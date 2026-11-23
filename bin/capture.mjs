#!/usr/bin/env node
// zippermerge capture: Claude Code hook handler for the coordinated repo.
// Records per-session activity, warns on live edit collisions, enforces the full-test-suite lock.
// Fails open: any error means exit 0 with no output.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAT_ROOT, CHAT_SH, HUMAN, REPO } from './config.mjs';

const run = promisify(execFile);

const REPO_COMMON = process.env.ZM_REPO_COMMON || (REPO ? `${REPO}/.git` : '');
// CHAT_DIR (or ZM_DIR, an alias used by the tests) redirects the whole chat folder.
const CHAT_DIR = CHAT_ROOT;
const IDENTITY_REFRESH_MS = 10 * 60 * 1000;
const LEGACY_IDENTITY_LOCK_GRACE_MS = 60 * 1000;
const CACHE_FILE = path.join(tmpdir(), 'zippermerge-capture-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const COLLISION_WINDOW_MS = 30 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// --rewake: collision warning goes to stderr + exit 2 (for asyncRewake hooks)
// --record-only: record the event, never warn or block
const REWAKE = process.argv.includes('--rewake');
const RECORD_ONLY = process.argv.includes('--record-only');
// --block-only: run the checks (lock block / collision) but don't record (the async --record-only hook records)
const BLOCK_ONLY = process.argv.includes('--block-only');

const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const fwd = (p) => String(p).replace(/\\/g, '/');
const pathKey = (p) => process.platform === 'win32' ? fwd(p).toLowerCase() : p;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---- git lookup with cache -------------------------------------------------
function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function nearestExistingDir(p) {
  let d = path.resolve(p);
  for (let i = 0; i < 64 && !existsSync(d); i++) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

async function repoInfo(dir) {
  const key = norm(dir);
  const cache = loadCache();
  const hit = cache[key];
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit;
  let info = { common: null, top: null, t: Date.now() };
  try {
    const { stdout } = await run(
      'git',
      ['--no-optional-locks', 'rev-parse', '--git-common-dir', '--show-toplevel'],
      { cwd: dir, timeout: 3000, windowsHide: true },
    );
    const [common, top] = stdout.split(/\r?\n/);
    if (common && top) {
      info = { common: norm(path.resolve(dir, common)), top: fwd(top.trim()), t: Date.now() };
    }
  } catch {
    // not a repo or git failed; cache the negative result too
  }
  try {
    const fresh = loadCache();
    for (const k of Object.keys(fresh)) if (Date.now() - fresh[k].t > CACHE_TTL_MS) delete fresh[k];
    fresh[key] = info;
    writeFileSync(CACHE_FILE, JSON.stringify(fresh));
  } catch {
    // cache is best effort
  }
  return info;
}

// ---- command classification / redaction -----------------------------------
const COMMAND_WORD = /(?:"(?:\\[\s\S]|[^"\\])*"|\$'(?:\\[\s\S]|[^'\\])*'|'[^']*'|\\(?:\r?\n|[ \t;&|<>()#="'\\])|(?!\$\()[^\s"';&|<>()])+/g;
const SHELL_TOKEN = [
  String.raw`(?<newline>\r\n?|\n)|[^\S\r\n]+|\\\r?\n|#[^\r\n]*`,
  String.raw`(?<substitution>[$<>]\()`,
  String.raw`(?<redirect>(?:\d+|\{[A-Za-z_]\w*\})?(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)|&>>?)`,
  String.raw`(?<separator>&&|\|\||\|&|[;&|()])|(?<word>.)`,
].join('|');
const CONTROL_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'for', 'select', 'do', 'done', 'case', 'esac', '!',
]);
const UNKNOWN_SHELL_VALUE = '\0';
const SECRET_NAME = /token|password|passwd|secret|api[-_]?key|private[-_]?key|credential|authorization/i;
const ASSIGNMENT_NAME = /^([\w.-]+)[ \t]*(?:=|:[ \t]*)/;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![\w./\\-])([\w.-]*(?:${SECRET_NAME.source})[\w.-]*[ \t]*[=:][ \t]*)${COMMAND_WORD.source}`, 'gi',
);

function unquote(word) {
  return word.replace(
    /\$?"((?:\\[\s\S]|[^"\\])*)"|\$'((?:\\[\s\S]|[^'\\])*)'|'([^']*)'|\\(\r?\n|[ \t;&|<>()#="'\\])/g,
    (_match, double, ansi, single, escaped) => double ?? ansi ?? single ?? escaped.replace(/\r?\n/, ''),
  );
}

function redactCredentialOptions(cmd, replacement) {
  const edits = [];
  for (const words of commandsOf(cmd)) {
    const { tool, args } = invocationOf(words);
    const curl = tool === 'curl';
    if (!curl && tool !== 'mysql' && tool !== 'mariadb') continue;

    for (let i = 0; i < args.length; i++) {
      const { value, start, end } = args[i];
      if (value === '--') break;
      if (curl && (value === '-u' || value === '--user')) {
        const credential = args[++i];
        if (credential) edits.push({ ...credential, text: replacement });
        continue;
      }
      const attached = value.match(curl ? /^(-u|--user=)[\s\S]/ : /^(-p)[\s\S]/);
      if (attached) edits.push({ start, end, text: attached[1] + replacement });
    }
  }
  const parts = [];
  let offset = 0;
  // A substitution can have its own credentials inside an outer credential word.
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (start < offset) continue;
    parts.push(cmd.slice(offset, start), text);
    offset = end;
  }
  return parts.join('') + cmd.slice(offset);
}

export function redact(cmd) {
  const R = '‹redacted›';
  return redactCredentialOptions(String(cmd), R)
    .replace(COMMAND_WORD, (word) => {
      const value = unquote(word);
      const assignment = value.match(ASSIGNMENT_NAME);
      if (!assignment || assignment[0].length === value.length || !SECRET_NAME.test(assignment[1])) return word;
      const quote = word.match(/^\$?(["'])/)?.[1] || '';
      return `${quote}${assignment[0]}${R}${quote}`;
    })
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s"'<>?#]+@/gi, `$1${R}@`)
    .replace(/(authorization\s*:\s*)[^"'\r\n]+/gi, `$1${R}`)
    .replace(SECRET_ASSIGNMENT, `$1${R}`)
    .replace(/Bearer\s+\S+/gi, `Bearer ${R}`)
    .replace(
      /\b(token|password|secret|api[-_]?key|authorization)([ \t]+)("[^"]*"|'[^']*'|\S+)/gi,
      `$1$2${R}`,
    )
    // known token families
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, R)
    .replace(/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, R)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, R)
    // long high-entropy blobs: not adjacent to a path separator, dot or colon, so paths and git refs survive
    .replace(/(?<![A-Za-z0-9+/_=\\.:-])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+/_=\\.:-])/g, (m) => (
      looksSecret(m) ? R : m
    ));
}

function looksSecret(tok) {
  if (!/\d/.test(tok) || !/[A-Za-z]/.test(tok)) return false;
  // kebab/snake names such as a long-branch-name-v2 are word-like, not secrets
  const parts = tok.split(/[-_]/);
  if (parts.length >= 3) {
    const wordy = parts.filter((p) => /^[A-Za-z]{2,12}$/.test(p) || /^\d{1,4}$/.test(p)).length;
    if (wordy / parts.length >= 0.7) return false;
  }
  return true;
}

function afterHereDocuments(cmd, index, documents) {
  for (const { delimiter, quoted, stripTabs } of documents) {
    let logicalLine = '';
    while (index < cmd.length) {
      const newline = cmd.indexOf('\n', index);
      const end = newline < 0 ? cmd.length : newline;
      logicalLine += cmd.slice(index, end).replace(/\r$/, '');
      index = newline < 0 ? end : end + 1;
      // An unquoted heredoc folds an unescaped backslash-newline before delimiter matching.
      if (!quoted && newline >= 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(logicalLine)) {
        logicalLine = logicalLine.slice(0, -1);
        continue;
      }
      const line = stripTabs ? logicalLine.replace(/^\t+/, '') : logicalLine;
      if (line === delimiter) break;
      logicalLine = '';
    }
  }
  return index;
}

function shellWord(cmd, lexer, start, expand) {
  let at = start;
  let offset = start;
  let raw = '';
  let quote = '';
  const substitutions = [];
  while (at < cmd.length) {
    const char = cmd[at];
    const next = cmd[at + 1];
    const regular = quote !== "'" && quote !== 'ansi';
    if (regular && char === '$' && next === '(' || !quote && (char === '<' || char === '>') && next === '(') {
      lexer.lastIndex = at + 2;
      const nested = [...shellEvents(cmd, lexer, true)];
      raw += cmd.slice(offset, at);
      if (expand) {
        if (cmd[at + 2] !== '(') substitutions.push(nested);
        raw += UNKNOWN_SHELL_VALUE;
      } else {
        raw += cmd.slice(at, lexer.lastIndex);
      }
      at = offset = lexer.lastIndex;
      continue;
    }
    if (!quote && /[\s;&|()<>]/.test(char)) break;
    if (char === '\\' && quote !== "'" && (quote !== '"' || /["\\$`\r\n]/.test(next || ''))) {
      at += next === '\r' && cmd[at + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (!quote && char === '$' && next === "'") {
      quote = 'ansi';
      at += 2;
      continue;
    }
    if (quote === char || quote === 'ansi' && char === "'") quote = '';
    else if (!quote && (char === '"' || char === "'")) quote = char;
    at++;
  }
  const end = Math.min(at, cmd.length);
  raw += cmd.slice(offset, end);
  lexer.lastIndex = end;
  return { raw, value: unquote(raw.replaceAll(UNKNOWN_SHELL_VALUE, '$()')), start, end, substitutions };
}

// Keep word offsets for redaction and preserve nested commands for scope analysis.
function* shellEvents(cmd, lexer = new RegExp(SHELL_TOKEN, 'g'), inSubstitution = false) {
  const documents = [];
  let words = [];
  let redirection = '';
  let substitutions = [];
  let depth = 0;
  while (lexer.lastIndex < cmd.length) {
    const token = lexer.exec(cmd);
    if (!token) break;
    const { newline, separator, redirect, substitution, word } = token.groups;
    const groupBrace = (word === '{' || word === '}') && !redirection
      && (!cmd[token.index + 1] || /[\s;&|()<>]/.test(cmd[token.index + 1]))
      && words.every(({ raw }) => CONTROL_WORDS.has(raw) || raw === 'time' || raw === '-p');
    if (newline || separator || groupBrace) {
      if (words.length || substitutions.length) yield { words, substitutions };
      words = [];
      substitutions = [];
      redirection = '';
      if (separator === '(') depth++;
      if (separator === ')') {
        if (!depth && inSubstitution) return;
        if (depth) depth--;
      }
      yield { boundary: newline ? '\n' : separator || word };
      if (newline && documents.length) {
        lexer.lastIndex = afterHereDocuments(cmd, lexer.lastIndex, documents);
        documents.length = 0;
      }
    } else if (redirect) {
      redirection = redirect;
    } else if (word || substitution) {
      const heredoc = /(?:^|[\d}])<<-?$/.test(redirection);
      const parsed = shellWord(cmd, lexer, token.index, !heredoc);
      substitutions.push(...parsed.substitutions);
      if (!redirection) words.push(parsed);
      else if (heredoc) {
        const { raw } = parsed;
        const quoted = /['"\\]/.test(raw.replace(/\\\r?\n/g, ''));
        const delimiter = identityWordParts(raw, null).map(({ text }) => text).join('');
        documents.push({ delimiter, quoted, stripTabs: redirection.endsWith('-') });
      }
      redirection = '';
    }
  }
  if (words.length || substitutions.length) yield { words, substitutions };
}

function* commandsOf(cmd, events = shellEvents(cmd)) {
  for (const { words, substitutions } of events) {
    if (!words) continue;
    for (const nested of substitutions) yield* commandsOf(cmd, nested);
    if (words.length) yield words;
  }
}

const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
const DIRECT_RUNNERS = /^(vitest|jest|playwright|turbo|tsc)$/;
const EXEC_OPTIONS = /^(?:--package|-p|--cache|--registry|--prefix|--userconfig)$/;
const PACKAGE_OPTIONS = /^(?:--filter|-F|--workspace|-w|--prefix|--cwd|--dir|-C)$/;
const WRAPPER_OPTIONS = new Map([
  ['sudo', /^(?:-[ughrtdCpRT]|--(?:user|group|host|role|type|chdir|chroot|prompt|close-from|command-timeout))$/],
  ['time', /^(?:-[fo]|--format|--output)$/],
  ['env', /^(?:-[uC]|--unset|--chdir)$/],
  ['cross-env', /^$/],
  ['nice', /^(?:-n|--adjustment)$/],
  ['npx', EXEC_OPTIONS],
  ['pnpx', EXEC_OPTIONS],
  ['bunx', EXEC_OPTIONS],
]);

function executableName(token = '') {
  return token.split(/[/\\]/).pop().replace(/\.(?:exe|cmd|bat)$/i, '');
}

function firstOperand(args, index, valueFlags) {
  for (; index < args.length && args[index].startsWith('-'); index++) {
    const flag = args[index];
    if (flag === '--') return index + 1;
    if (valueFlags.test(flag) && index + 1 < args.length) index++;
  }
  return index;
}

// Strip env assignments and runner prefixes to locate the actual tool.
function invocationOf(words) {
  const tokens = words.map(({ value }) => value);
  let i = 0;
  while (i < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i++;
      continue;
    }
    const tool = executableName(tokens[i]);
    const wrapper = WRAPPER_OPTIONS.get(tool);
    if (wrapper) {
      i = firstOperand(tokens, i + 1, wrapper);
      continue;
    }
    if (PACKAGE_MANAGERS.test(tool)) {
      const operand = firstOperand(tokens, i + 1, PACKAGE_OPTIONS);
      const sub = tokens[operand];
      if ((/^(npm|pnpm)$/.test(tool) && /^(exec|dlx)$/.test(sub || '')) || (tool === 'bun' && sub === 'x')) {
        i = firstOperand(tokens, operand + 1, EXEC_OPTIONS);
        continue;
      }
      if (tool !== 'npm' && DIRECT_RUNNERS.test(executableName(sub))) {
        i = operand;
        continue;
      }
    }
    return { tool, args: words.slice(i + 1) };
  }
  return { tool: '', args: [] };
}

const hasFlag = (args, re) => args.some((a) => re.test(a));
const TEST_NAME_FILTER = /^(?:-t|testNamePattern)$/;
const VITEST_VALUE_FLAGS = new Set([
  '-c', '-r', '-p', 'config', 'root', 'project', 'reporter', 'outputFile', 'pool', 'poolOptions',
  'dir', 'environment', 'setupFiles', 'exclude', 'include', 'workers', 'minWorkers', 'maxWorkers',
  'testTimeout', 'hookTimeout', 'teardownTimeout', 'bail', 'retry', 'shard', 'maxConcurrency', 'mode',
  'api.host', 'api.port', 'sequence.seed', 'sequence.hooks', 'sequence.setupFiles', 'diff',
  'coverage.provider', 'coverage.include', 'coverage.exclude', 'coverage.extension', 'coverage.reportsDirectory',
  'coverage.reporter', 'coverage.ignoreClassMethods', 'coverage.processingConcurrency',
  'coverage.customProviderModule', 'coverage.changed', 'coverage.htmlDir',
  'coverage.thresholds.lines', 'coverage.thresholds.functions', 'coverage.thresholds.branches',
  'coverage.thresholds.statements', 'coverage.watermarks.lines', 'coverage.watermarks.functions',
  'coverage.watermarks.branches', 'coverage.watermarks.statements',
]);
const JEST_VALUE_FLAGS = new Set([
  '-c', '-w', 'config', 'bail', 'cacheDirectory', 'changedSince', 'coverageDirectory',
  'coverageProvider', 'coverageThreshold', 'env', 'testEnvironment', 'testEnvironmentOptions',
  'filter', 'globalSetup', 'globalTeardown', 'globals', 'haste', 'maxConcurrency', 'maxWorkers',
  'moduleNameMapper', 'openHandlesTimeout', 'outputFile', 'preset', 'prettierPath', 'resolver',
  'rootDir', 'runner', 'seed', 'shard', 'testFailureExitCode', 'testResultsProcessor', 'testRunner',
  'testSequencer', 'testTimeout', 'transform', 'workerGracefulExitTimeout',
]);
const JEST_LIST_FLAGS = new Set([
  'collectCoverageFrom', 'coveragePathIgnorePatterns', 'coverageReporters', 'ignoreProjects',
  'moduleDirectories', 'moduleFileExtensions', 'modulePathIgnorePatterns', 'modulePaths',
  'projects', 'reporters', 'roots', 'selectProjects', 'setupFiles', 'setupFilesAfterEnv',
  'snapshotSerializers', 'testMatch', 'testPathIgnorePatterns', 'testRegex', 'transformIgnorePatterns',
  'unmockedModulePathPatterns', 'watchPathIgnorePatterns',
]);
const PLAYWRIGHT_VALUE_FLAGS = new Set([
  '-c', '-j', '-G', 'config', 'workers', 'reporter', 'addReporter', 'browser', 'globalTimeout',
  'lastFailedFile', 'maxFailures', 'output', 'repeatEach', 'retries', 'shard', 'timeout', 'trace',
  'updateSourceMethod', 'grepInvert', 'testListInvert', 'uiHost', 'uiPort',
]);

function hasTestFilter(args, runner) {
  const vitest = runner === 'vitest';
  const jest = runner === 'jest';
  const script = runner === 'script';
  const playwright = runner === 'playwright';
  let allowSubcommand = vitest;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return i + 1 < args.length;
    if (!arg.startsWith('-')) {
      if (!allowSubcommand || !/^(run|watch)$/.test(arg)) return true;
      allowSubcommand = false;
      continue;
    }
    const [rawFlag, value] = arg.split('=', 2);
    const flag = rawFlag.startsWith('--') ? rawFlag.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()) : rawFlag;
    if (playwright ? /^(?:-g|grep|testList)$/.test(flag) : TEST_NAME_FILTER.test(flag)) {
      return true;
    }
    if ((jest || script) && /^testPathPatterns?$/.test(flag)) return true;
    if (((jest || script) && JEST_LIST_FLAGS.has(flag)) || (playwright && flag === 'project')) {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
    } else if (value === undefined && (
      ((vitest || script) && VITEST_VALUE_FLAGS.has(flag))
      || ((jest || script) && JEST_VALUE_FLAGS.has(flag))
      || (playwright && PLAYWRIGHT_VALUE_FLAGS.has(flag))
    )) {
      i++;
    }
  }
  return false;
}

// returns { cat, heavy } for one segment
function classifySegment(words) {
  const { tool: first, args } = invocationOf(words);
  const rest = args.map(({ value }) => value);
  const second = rest[0];
  const scoped = (args) => hasFlag(args, /^(--filter|-F|--workspace|-w)(=|$)/);

  if (first === 'git') {
    const sub = rest.find((a) => !a.startsWith('-')) || '';
    const write = /^(commit|push|merge|rebase|reset|checkout|cherry-pick|stash|switch|restore|am|apply|pull|tag|revert)$/;
    return { cat: write.test(sub) ? 'git-write' : 'git-read', heavy: false };
  }
  if (first === 'gh') return { cat: 'gh', heavy: false };

  if (first === 'vitest' || first === 'jest') {
    const targeted = hasTestFilter(rest, first);
    return { cat: 'test', heavy: !targeted };
  }
  if (first === 'playwright' && second === 'test') {
    const targeted = hasTestFilter(rest.slice(1), 'playwright');
    return { cat: 'test', heavy: !targeted };
  }
  if (first === 'turbo') {
    const args = second === 'run' ? rest.slice(1) : rest;
    const task = args[firstOperand(args, 0, PACKAGE_OPTIONS)] || '';
    if (/^test(:|$)/.test(task)) return { cat: 'test', heavy: !scoped(args) };
    if (/^build(:|$)/.test(task)) return { cat: 'build', heavy: !scoped(args) };
  }
  if (first === 'tsc' && hasFlag(rest, /^(-b|--build)$/)) return { cat: 'build', heavy: true };

  if (PACKAGE_MANAGERS.test(first)) {
    // pnpm --filter x test: flags before the script name
    const sub = firstOperand(rest, 0, PACKAGE_OPTIONS);
    const [scripted = '', ...scriptArgs] = rest.slice(/^(run|run-script)$/.test(rest[sub] || '') ? sub + 1 : sub);
    if (/^(install|i|ci|add)$/.test(rest[sub] || '') || (first === 'yarn' && !second)) {
      return { cat: 'install', heavy: false };
    }
    if (/^test(:|$)/.test(scripted)) {
      const args = scriptArgs[0] === '--' ? scriptArgs.slice(1) : scriptArgs;
      const targeted = scoped(rest) || hasTestFilter(args, 'script');
      return { cat: 'test', heavy: !targeted };
    }
    if (/^build(:|$)/.test(scripted)) {
      return { cat: 'build', heavy: !scoped(rest) };
    }
  }
  return { cat: 'other', heavy: false };
}

const CAT_RANK = ['test', 'build', 'git-write', 'install', 'gh', 'git-read', 'other'];

export function classify(cmd) {
  let cat = 'other';
  let heavy = false;
  for (const words of commandsOf(String(cmd))) {
    const r = classifySegment(words);
    if (CAT_RANK.indexOf(r.cat) < CAT_RANK.indexOf(cat)) cat = r.cat;
    if ((r.cat === 'test' || r.cat === 'build') && r.heavy) heavy = true;
  }
  return { category: cat, heavy };
}

// ---- identity ---------------------------------------------------------------
function worktreeKey(p) {
  const key = pathKey(p).replace(/\/+$/, '');
  return process.platform === 'win32' ? key.replace(/^\/([a-z])(?=\/|$)/, '$1:') : key;
}

function* worktreePaths(status) {
  let inWorktrees = false;
  for (const line of status.split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9 /_-]*?):[ \t]*(.*)$/.exec(line);
    let entry = line;
    if (field && !/^[A-Za-z]:[/\\]/.test(line)) {
      inWorktrees = /^Worktrees(?:\/branches)?$/i.test(field[1].trim());
      entry = field[2];
    }
    if (!inWorktrees) continue;
    entry = entry.replace(/^[ \t]*[-*][ \t]+/, '').trim();
    while (entry) {
      const arrow = entry.indexOf('->');
      yield (arrow < 0 ? entry : entry.slice(0, arrow)).trim();
      if (arrow < 0) break;
      const branch = entry.slice(arrow + 2);
      const nextArrow = branch.indexOf('->');
      if (nextArrow < 0) break;
      const declaration = branch.slice(0, nextArrow);
      const separators = [...declaration.matchAll(/;([ \t]+)(?=\S)|;(?=[A-Za-z]:[/\\]|[/\\])/g)];
      // A bare slash can be part of a branch name. Within the same declaration,
      // an explicitly spaced absolute path is unambiguous.
      const separator = separators.find((candidate, index) => candidate[1]
        || !separators.slice(index + 1).some((later) => later[1]
          && /^(?:[A-Za-z]:)?[/\\]/.test(declaration.slice(later.index + later[0].length))));
      if (!separator) break;
      entry = branch.slice(separator.index + separator[0].length).trim();
    }
  }
}

function inferSlug(top) {
  try {
    if (!top) return null;
    const dir = path.join(CHAT_DIR, 'status');
    const full = worktreeKey(top);
    const name = path.posix.basename(full);
    const exact = new Set();
    const byName = new Set();
    for (const file of readdirSync(dir)) {
      const slug = file.slice(0, -3);
      if (!file.endsWith('.md') || !SLUG_RE.test(slug) || slug === HUMAN) continue;
      try {
        const text = readFileSync(path.join(dir, file), 'utf8');
        for (const declared of worktreePaths(text)) {
          const candidate = worktreeKey(declared);
          if (candidate === full) exact.add(slug);
          else if (candidate === name) byName.add(slug);
        }
      } catch {
        // ignore unreadable status files
      }
    }
    const hits = exact.size ? exact : byName;
    return hits.size === 1 ? [...hits][0] : null;
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9_-]{1,24}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG_CMDS = new Set(['new', 'post', 'reply', 'unreserve', 'reserve', 'migration', 'claim-number']);
const LOCK_CMDS = new Set(['lock', 'unlock', 'break']);
const SHELL_ASSIGNMENT = /^([A-Za-z_]\w*)(\+)?=/;
const IDENTITY_WORD = /\$'(?<ansi>(?:\\[\s\S]|[^'\\])*)'|'(?<single>[^']*)'|\$?"(?<double>(?:\\[\s\S]|[^"\\])*)"|\\(?<escape>\r?\n|[\s\S])|\$(?:\{(?<braced>[A-Za-z_]\w*)\}|(?<bare>[A-Za-z_]\w*)|[$?!#*@0-9-])/g;
const IDENTITY_DOUBLE_QUOTED = /\\(?<escape>["\\$\x60]|\r?\n)|\$(?:\{(?<braced>[A-Za-z_]\w*)\}|(?<bare>[A-Za-z_]\w*)|[$?!#*@0-9-])/g;
const ANSI_C_ESCAPES = new Map(Object.entries({
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
}));

function decodeAnsiC(text) {
  return text.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|c[\s\S]|[\s\S])/g,
    (match, escape) => {
      if (ANSI_C_ESCAPES.has(escape)) return ANSI_C_ESCAPES.get(escape);
      if (escape.startsWith('c') && escape.length === 2) {
        return String.fromCharCode(escape[1] === '?' ? 127 : escape.charCodeAt(1) & 31);
      }
      if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8) & 255);
      if (/^[xuU]./.test(escape)) {
        const code = parseInt(escape.slice(1), 16);
        if (code <= 0x10ffff) return String.fromCodePoint(code);
      }
      return match;
    }).split('\0', 1)[0];
}

// Preserve which parts of a word came from an unquoted expansion.
// Heredoc delimiters use the same quote removal with expansion disabled.
function identityWordParts(raw, vars) {
  const expand = (match, { escape, braced, bare }) => {
    if (escape !== undefined) return escape.replace(/\r?\n/, '');
    const name = braced ?? bare;
    return name === undefined || !vars ? match : vars[name] ?? '';
  };
  const nativePath = vars && /^[A-Za-z]:\\/.test(raw);
  const parts = [];
  let offset = 0;
  for (const match of raw.matchAll(IDENTITY_WORD)) {
    if (match.index > offset) parts.push({ text: raw.slice(offset, match.index) });
    const { ansi, single, double, escape, braced, bare } = match.groups;
    if (ansi !== undefined) parts.push({ text: decodeAnsiC(ansi) });
    else if (single !== undefined) parts.push({ text: single });
    else if (double !== undefined) {
      const text = double.replace(IDENTITY_DOUBLE_QUOTED, (part, ...args) => expand(part, args.at(-1)));
      parts.push({ text });
    } else if (escape === undefined || !/\r?\n/.test(escape)) {
      const keepBackslash = nativePath && escape !== undefined && /[A-Za-z0-9._/-]/.test(escape);
      parts.push({ text: keepBackslash ? match[0] : expand(match[0], match.groups), split: !!(braced || bare) });
    }
    offset = match.index + match[0].length;
  }
  if (offset < raw.length) parts.push({ text: raw.slice(offset) });
  return parts;
}

const DEFAULT_IFS = ' \t\n';

function identityArguments(words, vars) {
  const args = [];
  const ifs = vars.IFS ?? DEFAULT_IFS;
  for (const word of words) {
    let field = null;
    for (const { text, split } of identityWordParts(word, vars)) {
      if (!split || ifs !== DEFAULT_IFS) {
        // Conservatively decline a custom-IFS expansion when it could change the arguments.
        if (split && (ifs === UNKNOWN_SHELL_VALUE || [...ifs].some((separator) => text.includes(separator)))) return null;
        if (!split || text) field = (field ?? '') + text;
        continue;
      }
      for (const part of text.split(/([ \t\n]+)/)) {
        if (!part) continue;
        if (/^[ \t\n]/.test(part)) {
          if (field !== null) args.push(field);
          field = null;
        } else {
          field = (field ?? '') + part;
        }
      }
    }
    if (field !== null) args.push(field);
  }
  return args;
}

function envCommandOperand(tokens, index) {
  for (; index < tokens.length; index++) {
    const option = tokens[index];
    if (option === '--') return index + 1;
    if (option === '-' || /^(?:-i+|--ignore-environment)$/.test(option)) continue;
    if (/^(?:-i*[uC]|--unset|--chdir)$/.test(option)) index++;
    else if (!/^(?:-i*[uC].+|--(?:unset|chdir)=.+)$/.test(option)) return option.startsWith('-') ? -1 : index;
  }
  return -1;
}

const SHELL_SET_OPTIONS = new Set([
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand',
  'history', 'ignoreeof', 'keyword', 'monitor', 'noclobber', 'noexec', 'noglob', 'nolog', 'notify',
  'nounset', 'onecmd', 'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace',
]);
const SHELL_SHOPT_OPTIONS = new Set([
  'autocd', 'checkhash', 'cmdhist', 'dotglob', 'expand_aliases', 'extglob', 'extquote', 'failglob',
  'globstar', 'histappend', 'lastpipe', 'nocaseglob', 'nocasematch', 'nullglob', 'sourcepath',
]);

function shellScriptOperand(tokens, index) {
  let noexec = false;
  let interactive = false;
  const script = (at) => noexec && !interactive ? -1 : at;
  for (; index < tokens.length; index++) {
    const option = tokens[index];
    if (option === '--' || option === '-') return script(index + 1);
    if (!/^[+-]/.test(option)) return script(index);
    if (/^--(?:rcfile|init-file)$/.test(option)) {
      index++;
      continue;
    }
    if (/^--(?:debugger|login|noediting|noprofile|norc|posix|restricted|verbose)$/.test(option)) continue;
    // -c, -s and information-only modes do not execute a script operand.
    const short = option.match(/^([+-])([abefhiklnprtuvxBCEHPT]*)([oO])?$/);
    if (!short) return -1;
    const [, sign, flags, named] = short;
    if (flags.includes('i')) interactive = sign === '-';
    if (flags.includes('n')) noexec = sign === '-';
    if (named) {
      const argument = tokens[++index];
      if (!(named === 'o' ? SHELL_SET_OPTIONS : SHELL_SHOPT_OPTIONS).has(argument)) return -1;
      if (named === 'o' && argument === 'noexec') noexec = sign === '-';
    }
  }
  return -1;
}

function chatScriptOperand(tokens) {
  let at = 0;
  while (at < tokens.length) {
    if (tokens[at] === 'command') {
      at++;
      while (tokens[at] === '-p') at++;
      if (tokens[at] === '--') at++;
    } else if (executableName(tokens[at]) === 'env') {
      at = envCommandOperand(tokens, at + 1);
      if (at < 0) return -1;
      while (SHELL_ASSIGNMENT.test(tokens[at])) at++;
    } else {
      break;
    }
  }
  if (/^(?:bash|sh)$/.test(executableName(tokens[at]))) at = shellScriptOperand(tokens, at + 1);
  return /(^|[/\\])chat\.sh$/.test(tokens[at]) && !tokens.slice(0, at + 1).some((word) => word.includes(UNKNOWN_SHELL_VALUE))
    ? at : -1;
}

const SCOPE_STARTS = new Set(['(', '{']);
const SCOPE_ENDS = new Set([')', '}']);
const PIPE = new Set(['|', '|&']);
const LOOP_WORDS = new Set(['while', 'until', 'for', 'select']);

function startsChildProcess(events, start, end = start) {
  let before = start - 1;
  while (events[before]?.boundary === '\n') before--;
  const after = events[end + 1]?.boundary;
  return PIPE.has(events[before]?.boundary) || PIPE.has(after) || after === '&';
}

// null means that execution depends on values the hook cannot observe.
const shellNot = (value) => value === null ? null : !value;
const shellAnd = (left, right) => {
  if (left === false || right === false) return false;
  return left === null || right === null ? null : true;
};

function shellScope(vars, reach) {
  return { vars, reach, controls: [], status: null, gate: true, pendingGate: false };
}

function commandReach(scope) {
  const control = scope.controls.at(-1);
  return shellAnd(control ? control.active : scope.reach, scope.gate);
}

function enterShellControl(scope, word) {
  const control = scope.controls.at(-1);
  if (word === 'if' || LOOP_WORDS.has(word) || word === 'case') {
    const reach = commandReach(scope);
    scope.controls.push({ word, remaining: reach, active: word === 'case' ? shellAnd(reach, null) : reach });
  } else if (word === 'fi' || word === 'done' || word === 'esac') {
    scope.controls.pop();
  } else if (control && word === 'then') {
    control.active = shellAnd(control.remaining, scope.status);
    control.remaining = shellAnd(control.remaining, shellNot(scope.status));
  } else if (control && (word === 'elif' || word === 'else')) {
    control.active = control.remaining;
  } else if (control && word === 'do') {
    const condition = control.word === 'while' ? scope.status
      : control.word === 'until' ? shellNot(scope.status) : null;
    control.active = shellAnd(control.remaining, condition);
  }
  scope.status = null;
  scope.gate = true;
  scope.pendingGate = false;
}

function literalShellStatus(raw) {
  if (raw.every((word) => SHELL_ASSIGNMENT.test(word))) return true;
  if (raw.length !== 1) return null;
  if (raw[0] === 'true' || raw[0] === ':') return true;
  return raw[0] === 'false' ? false : null;
}

function* scopedShellCommands(events, vars = Object.create(null), reach = true) {
  const groups = [];
  const childGroups = new Set();
  // A brace group normally shares its parent scope, unless it is run as a pipeline or job.
  for (const [index, { boundary }] of events.entries()) {
    if (SCOPE_STARTS.has(boundary)) groups.push(index);
    if (SCOPE_ENDS.has(boundary)) {
      const start = groups.pop();
      if (events[start]?.boundary === '{' && startsChildProcess(events, start, index)) childGroups.add(start);
    }
  }

  const scopes = [shellScope(vars, reach)];
  for (const [index, { words, substitutions, boundary }] of events.entries()) {
    const current = scopes.at(-1);
    if (SCOPE_STARTS.has(boundary)) {
      const ownVars = boundary === '(' || childGroups.has(index) ? Object.create(current.vars) : current.vars;
      scopes.push(shellScope(ownVars, commandReach(current)));
    } else if (SCOPE_ENDS.has(boundary)) {
      if (scopes.length > 1) {
        const child = scopes.pop();
        const parent = scopes.at(-1);
        if (child.reach !== false) parent.status = null;
        parent.gate = true;
        parent.pendingGate = false;
      }
    } else if (boundary === '&&' || boundary === '||') {
      current.gate = boundary === '&&' ? current.status : shellNot(current.status);
      current.pendingGate = true;
    } else if (boundary) {
      if (boundary === '\n' && current.pendingGate) continue;
      current.gate = true;
      current.pendingGate = false;
      if (PIPE.has(boundary)) current.status = null;
    } else if (words) {
      const raw = words.map((word) => word.raw);
      let first = 0;
      let negated = false;
      let header = false;
      while (CONTROL_WORDS.has(raw[first])) {
        const word = raw[first++];
        if (word === '!') negated = !negated;
        else enterShellControl(current, word);
        if (word === 'for' || word === 'select' || word === 'case') header = true;
      }
      const command = raw.slice(first);
      if (!command.length && !substitutions.length) continue;
      const reachable = commandReach(current);
      const child = startsChildProcess(events, index);
      const ownVars = child ? Object.create(current.vars) : current.vars;
      if (reachable === true) {
        for (const nested of substitutions) yield* scopedShellCommands(nested, Object.create(ownVars));
      }
      if (reachable !== false && !header && command.length) {
        yield { raw: command, vars: ownVars, certain: reachable === true };
      }
      if (reachable !== false) {
        const status = reachable === true && !child && !substitutions.length ? literalShellStatus(command) : null;
        current.status = negated ? shellNot(status) : status;
      }
      current.gate = true;
      current.pendingGate = false;
    }
  }
}

function assignShellWord(raw, vars, certain) {
  const match = SHELL_ASSIGNMENT.exec(raw);
  if (!match) return;
  const [, name, append] = match;
  const value = identityWordParts(raw.slice(match[0].length), vars).map(({ text }) => text).join('');
  vars[name] = certain ? (append ? vars[name] ?? '' : '') + value : UNKNOWN_SHELL_VALUE;
}

function forgetShellVariables(vars) {
  for (const name in vars) vars[name] = UNKNOWN_SHELL_VALUE;
}

function changeShellVariables(raw, words, vars, certain) {
  let at = 0;
  if (raw[0] === 'command' || raw[0] === 'builtin') at++;
  if (raw[at] === '--') at++;
  const tool = raw[at];
  if (tool === 'export') {
    for (const word of raw.slice(at + 1)) {
      if (SHELL_ASSIGNMENT.test(word)) assignShellWord(word, vars, certain);
      else {
        const expanded = identityWordParts(word, vars).map(({ text }) => text).join('');
        const match = SHELL_ASSIGNMENT.exec(expanded);
        if (match) {
          const [, name, append] = match;
          const value = expanded.slice(match[0].length);
          vars[name] = certain ? (append ? vars[name] ?? '' : '') + value : UNKNOWN_SHELL_VALUE;
        } else if (expanded.includes(UNKNOWN_SHELL_VALUE)) forgetShellVariables(vars);
      }
    }
  } else if (tool === 'unset') {
    if (!words) {
      forgetShellVariables(vars);
      return;
    }
    let index = at + 1;
    while (/^-[fv]+$/.test(words[index])) {
      if (words[index++].includes('f')) return;
    }
    if (words[index] === '--') index++;
    for (const name of words.slice(index)) {
      if (/^[A-Za-z_]\w*$/.test(name)) vars[name] = certain ? '' : UNKNOWN_SHELL_VALUE;
      else forgetShellVariables(vars);
    }
  } else if (/^(?:read|readarray|mapfile|source|\.|eval|declare|typeset|local|readonly|let|getopts)$/.test(tool)
    || tool === 'printf' && words?.[at + 1] === '-v') {
    forgetShellVariables(vars);
  }
}

// Returns { slug, via } for the first chat.sh invocation in cmd, or null. Slug is only syntactically checked.
export function extractChatSlug(cmd) {
  for (const { raw, vars, certain } of scopedShellCommands([...shellEvents(String(cmd))])) {
    const command = raw.findIndex((word) => !SHELL_ASSIGNMENT.test(word));
    if (command < 0) {
      // Standalone assignments persist. Prefix assignments only affect their command.
      for (const word of raw) assignShellWord(word, vars, certain);
      continue;
    }
    const words = raw.slice(command);
    const toks = identityArguments(words, vars);
    changeShellVariables(words, toks, vars, certain);
    if (!toks || !certain) continue;
    const at = chatScriptOperand(toks);
    if (at < 0) continue;
    const args = toks.slice(at + 1);
    const sub = args[0];
    let slug;
    if (LOCK_CMDS.has(sub)) slug = args[2];
    else if (sub === 'guard') {
      const k = args.indexOf('--slug');
      slug = k >= 0 ? args[k + 1] : undefined;
    } else if (SLUG_CMDS.has(sub)) slug = args[1];
    if (SLUG_RE.test(slug || '')) return { slug, via: `chat.sh ${sub}` };
  }
  return null;
}

function slugOk(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && slug !== HUMAN
    && existsSync(path.join(CHAT_DIR, 'status', `${slug}.md`));
}

function identityFile(sid) {
  return path.join(CHAT_DIR, 'identity', `${sid}.json`);
}

function electedIdentity(file, candidate) {
  // Generations avoid removing a claim that a concurrent writer just published.
  for (let generation = 0; ; generation++) {
    const claim = file + '.claim' + (generation ? '.' + generation : '');
    try {
      linkSync(candidate, claim);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const elected = readIdentity(claim);
    if (elected) return elected.text;
  }
}

function learnIdentity(sid, cmd) {
  try {
    if (!SID_RE.test(sid)) return;
    const found = extractChatSlug(cmd);
    if (!found || !slugOk(found.slug)) return;
    const file = identityFile(sid);
    const previous = readIdentity(file)?.slug;
    if (previous && (previous !== found.slug || Date.now() - statSync(file).mtimeMs < IDENTITY_REFRESH_MS)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    const legacyLock = statSync(file + '.lock', { throwIfNoEntry: false });
    if (legacyLock && Date.now() - legacyLock.mtimeMs < LEGACY_IDENTITY_LOCK_GRACE_MS) return;

    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      const record = JSON.stringify({ slug: found.slug, at: new Date().toISOString(), via: found.via });
      writeFileSync(tmp, record);
      if (previous) {
        // A valid identity can only be refreshed by the same slug.
        renameSync(tmp, file);
        return;
      }

      // First publication and repair elect one complete record. If the owner
      // exits before publishing it, any later hook can finish the same write.
      const elected = electedIdentity(file, tmp);
      const settled = readIdentity(file);
      if (settled) return;

      // Give the dashboard file its own inode so later repairs can use the claim.
      rmSync(tmp);
      writeFileSync(tmp, elected);
      if (settled === undefined) linkSync(tmp, file);
      else renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch {
    // identity learning is best effort
  }
}

function readIdentity(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const { slug } = JSON.parse(text);
    return typeof slug === 'string' && SLUG_RE.test(slug) && slug !== HUMAN ? { slug, text } : null;
  } catch {
    return null;
  }
}

function slugFromIdentity(sid) {
  try {
    if (!SID_RE.test(sid)) return null;
    return readIdentity(identityFile(sid))?.slug ?? null;
  } catch {
    return null;
  }
}

// ---- collision check --------------------------------------------------------
function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function activityLines(file) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n');
  } catch {
    return [];
  }
}

function collisionContext(slug, rel, now) {
  const found = new Map(); // other slug -> { worktree, ts }
  const target = pathKey(rel);
  const since = now - COLLISION_WINDOW_MS;
  for (const day of new Set([dayStamp(now), dayStamp(since)])) {
    const dir = path.join(CHAT_DIR, 'activity', day);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const other = f.slice(0, -6);
      if (other === slug) continue;
      for (const line of activityLines(path.join(dir, f))) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev?.event !== 'edit' || typeof ev.file !== 'string' || pathKey(ev.file) !== target) continue;
        // Concurrent hooks can append events out of timestamp order.
        const ts = Date.parse(ev.ts);
        if (!Number.isFinite(ts) || ts < since || ts > now + 60000) continue;
        const prev = found.get(other);
        if (!prev || ts > prev.ts) found.set(other, { ts, worktree: ev.worktree || '?' });
      }
    }
  }
  if (!found.size) return null;
  const parts = [...found.entries()]
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, 3)
    .map(([o, v]) => `${o} also edited ${rel} ${Math.max(0, Math.round((now - v.ts) / 60000))} min ago (worktree ${v.worktree})`);
  return `zippermerge: ${parts.join('; ')}. Coordinate before going further: check bash ${CHAT_SH} board and post an ask if your changes overlap.`;
}

// ---- reservation check ------------------------------------------------------
function globToRegExp(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function reservationContext(slug, rel, now) {
  const dir = path.join(CHAT_DIR, 'reservations');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  const msgs = [];
  for (const f of files) {
    try {
      const text = readFileSync(path.join(dir, f), 'utf8');
      const field = (k) => (text.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi')) || [])[1]?.trim() || '';
      const owner = field('owner');
      const pattern = field('pattern');
      const exp = Number(field('expires_epoch'));
      if (!owner || !pattern || owner === slug || !Number.isFinite(exp) || exp * 1000 <= now) continue;
      if (!globToRegExp(pattern).test(rel)) continue;
      const until = `${new Date(exp * 1000).toISOString().slice(11, 16)}Z`;
      msgs.push(`zippermerge: ${rel} is reserved by ${owner} (${field('mode') || 'shared'}, until ${until}): ${field('why') || 'no reason given'}. Coordinate before continuing.`);
    } catch {
      // ignore unreadable reservation
    }
  }
  return msgs.length ? msgs.join(' ') : null;
}

// ---- lock check -------------------------------------------------------------
function lockBlock(slug) {
  try {
    const text = readFileSync(path.join(CHAT_DIR, 'locks', 'full-test-suite.md'), 'utf8');
    const field = (k) => (text.match(new RegExp(`^${k}:\\s*(.*)$`, 'mi')) || [])[1]?.trim() || '';
    const owner = field('owner');
    if (!owner || owner === slug) return null;
    return `zippermerge: full-test-suite is held by ${owner} since ${field('since') || '?'} (${field('why') || 'no reason given'}). Wait, or run a targeted subset. Protocol: ${CHAT_DIR}/CLAUDE.md trigger 6.`;
  } catch {
    return null; // no lock file
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return 0;
  }
  if (!input || typeof input !== 'object') return 0;

  const evName = input.hook_event_name;
  const tool = input.tool_name;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';

  let event = null;
  let filePath = null;
  if (evName === 'PostToolUse' && EDIT_TOOLS.has(tool)) {
    filePath = ti.file_path || ti.notebook_path;
    if (typeof filePath !== 'string' || !filePath) return 0;
    filePath = path.resolve(cwd || '.', filePath);
    event = 'edit';
  } else if (evName === 'PreToolUse' && tool === 'Bash') event = 'bash';
  else if (evName === 'SubagentStart') event = 'subagent-start';
  else if (evName === 'SubagentStop') event = 'subagent-stop';
  else if (evName === 'Stop') event = 'stop';
  else if (evName === 'UserPromptSubmit') event = 'prompt';
  else return 0;

  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  // learn identity from chat.sh calls even outside the repo scope
  if (tool === 'Bash' && typeof ti.command === 'string') learnIdentity(sid, ti.command);

  const lookupDir = event === 'edit' ? nearestExistingDir(path.dirname(filePath)) : cwd;
  if (!lookupDir || !existsSync(lookupDir)) return 0;

  const info = await repoInfo(lookupDir);
  if (!info.common || info.common !== norm(REPO_COMMON)) return 0;

  const worktree = path.basename(info.top);
  const slug = process.env.ZM_SLUG
    || slugFromIdentity(sid)
    || inferSlug(info.top)
    || `unknown-${sid.slice(0, 8) || 'nosid'}`;

  const now = Date.now();
  const rec = { ts: new Date(now).toISOString(), slug, sid, event, worktree };
  let heavy = false;
  let rel = null;

  if (event === 'edit') {
    const top = path.resolve(info.top);
    rel = fwd(path.relative(top, filePath));
    rec.file = rel;
  } else if (event === 'bash') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    const c = classify(cmd);
    rec.cmd = redact(cmd).slice(0, 140);
    rec.category = c.category;
    heavy = c.heavy;
  } else if (event === 'subagent-start' || event === 'subagent-stop') {
    const at = input.agent_type || input.subagent_type;
    if (at) rec.agentType = String(at);
  }

  try {
    if (!BLOCK_ONLY) {
      const dir = path.join(CHAT_DIR, 'activity', dayStamp(now));
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, `${slug}.jsonl`), `${JSON.stringify(rec)}\n`);
    }
  } catch {
    // recording is best effort
  }

  if (RECORD_ONLY) return 0;

  if (event === 'edit') {
    const msg = [collisionContext(slug, rel, now), reservationContext(slug, rel, now)].filter(Boolean).join('\n') || null;
    if (msg) {
      if (REWAKE) {
        process.stderr.write(`${msg}\n`);
        return 2;
      }
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
      })}\n`);
    }
  } else if (event === 'bash' && heavy) {
    const msg = lockBlock(slug);
    if (msg) {
      process.stderr.write(`${msg}\n`);
      return 2;
    }
  }
  return 0;
}

// run only when executed directly, so tests can import redact/extractChatSlug
// Windows paths are case-insensitive, so compare lowercased; a false "not main" would silently disable the hook.
const isMain = Boolean(process.argv[1]) && import.meta.url.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();
if (isMain) {
  let code = 0;
  try {
    code = await main();
  } catch {
    code = 0;
  }
  process.exitCode = code;
}
