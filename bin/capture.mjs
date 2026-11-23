#!/usr/bin/env node
// zippermerge capture: Claude Code hook handler for the coordinated repo.
// Records per-session activity, warns on live edit collisions, enforces the full-test-suite lock.
// Fails open: any error means exit 0 with no output.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_ROOT, CHAT_SH, HUMAN, REPO_COMMON, canonicalPath } from './config.mjs';

const run = promisify(execFile);
let shellParser;

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

const fwd = (p) => String(p).replace(/\\/g, '/');

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
  const key = dir;
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
      info = { common: canonicalPath(common, dir), top: canonicalPath(top.trim(), dir), t: Date.now() };
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
const SECRET_NAME = /token|password|passwd|secret|api[-_]?key|private[-_]?key|credential|authorization/i;
const ASSIGNMENT_NAME = /^([\w.-]+)[ \t]*(?:=|:[ \t]*)/;
const SECRET_ASSIGNMENT = new RegExp(
  '(?<![\\w./\\\\-])([\\w.-]*(?:' + SECRET_NAME.source + ')[\\w.-]*[ \\t]*[=:][ \\t]*)'
  + '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:[^\'\\r\\n]*)\'|[^\\s\'";&|<>]+)', 'gi',
);

// The first option that accepts a value consumes the rest of a curl short-option cluster.
const CURL_SHORT_OPERANDS = new Set('AbcCdeDEFhHKmoPQrtTuUwXxYyz');

function redactCurlOptions(args, replacement, edits) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.value === '--') break;
    const long = /^--(?:proxy-)?user(=|$)/.exec(arg.value);
    if (long) {
      if (!long[1]) {
        const value = args[++i];
        if (value) edits.push({ ...value, text: replacement });
      } else if (arg.value.length > long[0].length) {
        edits.push({ ...arg, text: arg.cover ? replacement : long[0] + replacement });
      }
      continue;
    }
    if (!/^-[^-]/.test(arg.value)) continue;
    for (let next = 1; next < arg.value.length; next++) {
      const option = arg.value[next];
      if (!CURL_SHORT_OPERANDS.has(option)) continue;
      const credential = option === 'u' || option === 'U';
      const prefix = arg.value.slice(0, next + 1);
      if (prefix.length < arg.value.length) {
        if (credential) edits.push({ ...arg, text: arg.cover ? replacement : prefix + replacement });
      } else if (option !== 'h' || !args[i + 1]?.value.startsWith('-')) {
        const value = args[++i];
        if (value && credential) edits.push({ ...value, text: replacement });
      }
      break;
    }
  }
}

function redactShellWords(parsed, replacement) {
  const { inspectShellCommands, shellWords } = shellParser;
  const cmd = parsed.text;
  const edits = [];
  const { commands, incomplete } = inspectShellCommands(parsed, { includeInactive: true });
  if (incomplete) return replacement;
  for (const { tool, args } of commands) {
    if (tool === 'curl') {
      redactCurlOptions(args, replacement, edits);
      continue;
    }
    if (tool !== 'mysql' && tool !== 'mariadb') continue;
    for (const arg of args) {
      if (arg.value === '--') break;
      if (/^-p[\s\S]/.test(arg.value)) edits.push({ ...arg, text: arg.cover ? replacement : '-p' + replacement });
    }
  }
  for (const { text, raw, start, end } of shellWords(parsed)) {
    const assignment = text.match(ASSIGNMENT_NAME);
    if (!assignment || assignment[0].length === text.length || !SECRET_NAME.test(assignment[1])) continue;
    const quote = raw.match(/^\$?(["'])/)?.[1] || '';
    edits.push({ start, end, text: quote + assignment[0] + replacement + quote });
  }

  const parts = [];
  let offset = 0;
  // An outer credential can contain another credential in a command substitution.
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!Number.isInteger(start) || start < offset || start === end) continue;
    parts.push(cmd.slice(offset, start), text);
    offset = end;
  }
  return parts.join('') + cmd.slice(offset);
}

export function redact(cmd) {
  const R = '‹redacted›';
  return redactShellWords(shellParser.parseShell(cmd), R)
    // Scan each run of scheme characters once, preserving any prefix before the first letter.
    .replace(/(?<![a-z\d+.-])([\d+.-]*[a-z][a-z\d+.-]*:\/\/)[^/\s"'<>?#]+@/gi, `$1${R}@`)
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
function classifySegment({ tool: first, args }) {
  const { firstOperand, gitSubcommand, PACKAGE_MANAGERS, PACKAGE_OPTIONS } = shellParser;
  const rest = args.map(({ value }) => value);
  const second = rest[0];
  const scoped = (args) => hasFlag(args, /^(--filter|-F|--workspace|-w)(=|$)/);

  if (first === 'git') {
    const sub = gitSubcommand(rest) || '';
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
      return { cat: 'test', heavy: !targeted, quickInZippermerge: first === 'npm' && scripted === 'test' };
    }
    if (/^build(:|$)/.test(scripted)) {
      return { cat: 'build', heavy: !scoped(rest) };
    }
  }
  return { cat: 'other', heavy: false };
}

const CAT_RANK = ['test', 'build', 'git-write', 'install', 'gh', 'git-read', 'other'];

export function classify(cmd, options, onHeavy) {
  let cat = 'other';
  let heavy = false;
  for (const command of shellParser.shellCommands(cmd, options)) {
    const r = classifySegment(command);
    if (CAT_RANK.indexOf(r.cat) < CAT_RANK.indexOf(cat)) cat = r.cat;
    if (r.heavy) {
      heavy = true;
      onHeavy?.(command, r.quickInZippermerge);
    }
  }
  return { category: cat, heavy };
}

// ---- identity ---------------------------------------------------------------
function worktreeKey(value) {
  const key = fwd(canonicalPath(value));
  return process.platform === 'win32' ? key.toLowerCase() : key;
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
          const candidate = /[/\\]/.test(declared) ? worktreeKey(declared) : declared;
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

// Learn a slug only when the possible shell paths agree on the first invocation.
export function extractChatSlug(cmd) {
  return shellParser.firstShellMatch(cmd, ({ tool, args, script }) => {
    if (script ? !/(^|[/\\])chat\.sh$/.test(script.value) : tool !== 'chat.sh') return null;
    const [sub, ...operands] = args.map(({ value }) => value);
    let slug;
    if (LOCK_CMDS.has(sub)) {
      const positional = [];
      while (operands.length && positional.length < 2) {
        const operand = operands.shift();
        if (operand === '--') { positional.push(...operands.slice(0, 2)); break; }
        if (operand === '--repo' || operand === '--timeout') operands.shift();
        else if (operand !== '--wait') positional.push(operand);
      }
      slug = positional[1];
    } else if (sub === 'guard') {
      const flag = operands.indexOf('--slug');
      if (flag >= 0) slug = operands[flag + 1];
    } else if (SLUG_CMDS.has(sub)) slug = operands[0];
    return SLUG_RE.test(slug || '') ? { slug, via: 'chat.sh ' + sub } : null;
  });
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
  for (let generation = 0; generation < 64; generation++) {
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
    if (!sid) return;
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
      if (!elected) return;
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
    if (!sid) return null;
    return readIdentity(identityFile(sid))?.slug ?? null;
  } catch {
    return null;
  }
}

function slugFromEnv() {
  const slug = process.env.ZM_SLUG;
  if (SLUG_RE.test(slug ?? '')) return slug;
  if (slug && !RECORD_ONLY) {
    process.stderr.write('zippermerge: ignoring invalid ZM_SLUG. Use 1–24 lowercase letters, digits, underscores, or hyphens.\n');
  }
  return null;
}

// ---- collision check --------------------------------------------------------
function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function activityLines(file) {
  try {
    return readFileSync(file, 'utf8').matchAll(/[^\n]+/g);
  } catch {
    return [];
  }
}

function collisionContext(slug, rel, now) {
  const oldest = now - COLLISION_WINDOW_MS;
  const ignoreCase = process.platform === 'win32';
  const key = ignoreCase ? rel.toLowerCase() : rel;
  const found = new Map(); // other slug -> { worktree, ts }
  for (const day of new Set([dayStamp(now), dayStamp(oldest)])) {
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
      // Concurrent hooks can append events out of timestamp order.
      for (const [line] of activityLines(path.join(dir, f))) {
        // Capture writes the event name as a literal JSON string.
        if (!line.includes('"edit"')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev?.event !== 'edit' || typeof ev.file !== 'string') continue;
        if ((ignoreCase ? ev.file.toLowerCase() : ev.file) !== key) continue;
        const ts = Date.parse(ev.ts);
        if (!Number.isFinite(ts) || ts < oldest || ts > now + 60000) continue;
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
function runDirectory({ cwd, tool, args }) {
  if (tool !== 'npm') return cwd;
  // npm --prefix chooses a different project without changing the shell's cwd.
  let prefix;
  for (let i = 0; i < args.length; i++) {
    const { value } = args[i];
    if (value === '--') break;
    if (value === '--prefix') prefix = args[++i]?.value;
    else if (value.startsWith('--prefix=')) prefix = value.slice('--prefix='.length);
  }
  return prefix ? canonicalPath(prefix, cwd) : cwd;
}

function lockField(text, name) {
  return text.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)$`, 'mi'))?.[1].trim() || '';
}

function lockBlock(scope, slug) {
  try {
    const text = readFileSync(path.join(CHAT_DIR, 'locks', `${scope.name}.md`), 'utf8');
    const field = (name) => lockField(text, name);
    const owner = field('owner');
    if (!owner || owner === slug) return null;
    return `zippermerge: full-test-suite is held by ${owner} since ${field('since') || '?'} for ${scope.label} (${field('why') || 'no reason given'}). Use chat.sh lock --wait or run a targeted subset. Protocol: ${CHAT_DIR}/CLAUDE.md trigger 6.`;
  } catch {
    return null; // no lock file
  }
}

function suiteLockConflicts(slug) {
  const dir = path.join(CHAT_DIR, 'locks');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return error.code !== 'ENOENT';
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^full-test-suite(?:-[0-9a-f]{64})?\.md$/.test(entry.name)) continue;
    try {
      const owner = lockField(readFileSync(path.join(dir, entry.name), 'utf8'), 'owner');
      // An unknown command scope may correspond to any held suite lock.
      if (!owner || owner !== slug) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') return true;
    }
  }
  return false;
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
  const cwd = typeof input.cwd === 'string' && input.cwd ? canonicalPath(input.cwd) : '';

  let event = null;
  let filePath = null;
  if (evName === 'PostToolUse' && EDIT_TOOLS.has(tool)) {
    filePath = ti.file_path || ti.notebook_path;
    if (typeof filePath !== 'string' || !filePath) return 0;
    filePath = canonicalPath(filePath, cwd || '.');
    event = 'edit';
  } else if (evName === 'PreToolUse' && tool === 'Bash') event = 'bash';
  else if (evName === 'SubagentStart') event = 'subagent-start';
  else if (evName === 'SubagentStop') event = 'subagent-stop';
  else if (evName === 'Stop') event = 'stop';
  else if (evName === 'UserPromptSubmit') event = 'prompt';
  else return 0;

  const sid = typeof input.session_id === 'string' && SID_RE.test(input.session_id) ? input.session_id : '';
  let parsed;
  if (tool === 'Bash') {
    // Bash parsing is only needed for shell events. Learn identity even outside the repo.
    shellParser = await import('./shell-parse.mjs');
    parsed = shellParser.parseShell(typeof ti.command === 'string' ? ti.command : '');
    if (parsed.text) learnIdentity(sid, parsed);
  }

  const lookupDir = event === 'edit' ? nearestExistingDir(path.dirname(filePath)) : cwd;
  if (!lookupDir || !existsSync(lookupDir)) return 0;

  const info = await repoInfo(lookupDir);
  const inScope = info.common && REPO_COMMON && !path.relative(REPO_COMMON, info.common);
  // The activity feed is for the configured checkout; locks can protect any
  // repository a Bash command actually runs in.
  if (!inScope && (event !== 'bash' || RECORD_ONLY)) return 0;

  const worktree = path.basename(info.top || cwd);
  const knownSlug = slugFromEnv() || slugFromIdentity(sid) || (info.top && inferSlug(info.top));
  const slug = knownSlug || `unknown-${sid.slice(0, 8) || 'nosid'}`;

  const now = Date.now();
  const rec = { ts: new Date(now).toISOString(), slug, sid, event, worktree };
  const heavyRuns = [];
  let rel = null;

  if (event === 'edit') {
    rel = fwd(path.relative(info.top, filePath));
    rec.file = rel;
  } else if (event === 'bash') {
    const c = classify(parsed, {
      cwd, environment: process.env, resolvePath: canonicalPath,
      isDirectory(dir) {
        try { return statSync(dir).isDirectory(); } catch { return false; }
      },
    }, (command, quickInZippermerge) => {
      if (!RECORD_ONLY) heavyRuns.push({ dir: runDirectory(command), quickInZippermerge });
    });
    rec.cmd = redact(parsed).slice(0, 140);
    rec.category = c.category;
  } else if (event === 'subagent-start' || event === 'subagent-stop') {
    const at = input.agent_type || input.subagent_type;
    if (at) rec.agentType = String(at);
  }

  try {
    if (inScope && !BLOCK_ONLY) {
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
  } else if (heavyRuns.length) {
    const { fullTestScope } = await import('./full-test-lock.mjs');
    const scopes = new Map();
    for (const { dir, quickInZippermerge } of heavyRuns) {
      if (!scopes.has(dir)) scopes.set(dir, fullTestScope(dir));
      const scope = scopes.get(dir);
      if (!scope) {
        if (!suiteLockConflicts(knownSlug)) continue;
        process.stderr.write(`zippermerge: could not determine the repository for a heavy command in ${dir} while a full-test-suite lock is held. Run the command from a working Git checkout or use a targeted subset.\n`);
        return 2;
      }
      if (scope.quickTests && quickInZippermerge) continue;
      const msg = lockBlock(scope, knownSlug || inferSlug(scope.top) || slug);
      if (msg) {
        process.stderr.write(`${msg}\n`);
        return 2;
      }
    }
  }
  return 0;
}

// run only when executed directly, so tests can import redact/extractChatSlug
// Either spelling can retain an alias, depending on the loader and its flags.
const isMain = Boolean(process.argv[1]) && path.relative(
  canonicalPath(fileURLToPath(import.meta.url)),
  canonicalPath(process.argv[1]),
) === '';
if (isMain) {
  let code = 0;
  try {
    code = await main();
  } catch {
    code = 0;
  }
  process.exitCode = code;
} else {
  // Library consumers use the synchronous classification and redaction helpers.
  shellParser = await import('./shell-parse.mjs');
}
