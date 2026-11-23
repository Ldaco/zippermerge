#!/usr/bin/env node
// zippermerge commit guard (see CLAUDE.md in this folder).
//   node guard.mjs check [--slug S] [--cwd DIR]
//   node guard.mjs hook        (Claude Code PreToolUse: JSON on stdin)
// Read-only. Fails open on any internal error.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_ROOT, CHAT_SH, HUMAN, MIG_DIR, REPO } from './config.mjs';

const run = promisify(execFile);
const msysToWin = (p) => p.replace(/^\/([a-zA-Z])(\/|$)/, (_m, d, s) => `${d.toUpperCase()}:${s || '/'}`);
const CHAT_DIR = msysToWin(CHAT_ROOT);
const REPO_COMMON = process.env.ZM_REPO_COMMON || (REPO ? `${REPO}/.git` : '');
const MIG_RE = new RegExp(`^${MIG_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{3})_.+\\.sql$`);

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function readGit(dir, [command, ...args], options, overrides) {
  try {
    // Policy paths are relative to the repository root, even from a subdirectory.
    if (command === 'ls-tree' && !args.includes('--full-tree')) args.unshift('--full-tree');
    const env = { ...process.env };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const { stdout } = await run('git', ['-C', dir, ...options, command, ...args], {
      env, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readField(file, key) {
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith(`${key}: `)) return line.slice(key.length + 2).trim();
    }
  } catch { /* ignore */ }
  return null;
}

// ---- command parsing (hook mode) ----
const shellKeywords = new Set(['!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);

function tokenize(cmd) {
  // Keep control operators and redirection bodies separate from command arguments.
  const segs = [];
  let words = [];
  let documents = [];
  const pendingBodies = [];
  let pendingDelimiter;
  let tok = '';
  let has = false;
  let q = null;
  const pushTok = () => {
    if (!has) return;
    if (pendingDelimiter) {
      pendingDelimiter.delimiter = tok;
      documents.push(pendingDelimiter);
      pendingBodies.push(pendingDelimiter);
      pendingDelimiter = undefined;
    } else {
      words.push(tok);
    }
    tok = '';
    has = false;
  };
  const pushSeg = () => {
    pushTok();
    if (words.length) segs.push({ words, documents });
    words = [];
    documents = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && q !== "'") {
      if (cmd[i + 1] === '\n') { i++; continue; }
      if (cmd[i + 1] === '\r' && cmd[i + 2] === '\n') { i += 2; continue; }
    }
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && /[\\"$`]/.test(cmd[i + 1] ?? '')) { tok += cmd[++i]; }
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length && (pendingDelimiter || /[\s;&|(){}<>#"']/.test(cmd[i + 1]))) {
      tok += cmd[++i]; has = true; continue;
    }
    if (c === '#' && !has) {
      const newline = cmd.indexOf('\n', i);
      if (newline < 0) break;
      i = newline - 1;
      continue;
    }
    if (c === '\n') {
      pushSeg();
      if (!['&&', '||', '|', '|&'].includes(segs.at(-1))) segs.push(c);
      for (const doc of pendingBodies) {
        const lines = [];
        while (i + 1 < cmd.length) {
          const newline = cmd.indexOf('\n', i + 1);
          const end = newline < 0 ? cmd.length : newline;
          const raw = cmd.slice(i + 1, end).replace(/\r$/, '');
          const line = doc.stripTabs ? raw.replace(/^\t+/, '') : raw;
          i = end;
          if (line === doc.delimiter) break;
          lines.push(line);
        }
        doc.body = lines.join('\n');
      }
      pendingBodies.length = 0;
      continue;
    }
    if (/\s/.test(c)) { pushTok(); continue; }
    if (cmd.startsWith('<<<', i)) { tok += '<<<'; has = true; i += 2; continue; }
    if (cmd.startsWith('<<', i)) {
      const descriptor = has && !pendingDelimiter && /^\d+$/.test(tok) ? Number(tok) : undefined;
      if (descriptor !== undefined) { tok = ''; has = false; }
      pushTok();
      const stripTabs = cmd[i + 2] === '-';
      pendingDelimiter = { input: descriptor === undefined || descriptor === 0, stripTabs };
      i += stripTabs ? 2 : 1;
      continue;
    }
    const brace = (c === '{' || c === '}') && !has && words.every((word) => shellKeywords.has(word))
      && (i + 1 === cmd.length || /[\s;&|()<>]/.test(cmd[i + 1]));
    const redirect = c === '&' && (cmd[i + 1] === '>' || /[<>]/.test(cmd[i - 1] ?? ''));
    if (brace || c === '(' || c === ')' || c === ';' || (!redirect && c === '&') || c === '|') {
      const doubled = (c === '&' || c === '|') && (cmd[i + 1] === c || (c === '|' && cmd[i + 1] === '&'));
      pushSeg();
      segs.push(doubled ? c + cmd[++i] : c);
      continue;
    }
    tok += c; has = true;
  }
  pushSeg();
  return segs;
}

const wrapperOptions = new Map([
  ['env', {
    shortFlags: 'iv', shortValues: 'aCSu', chdirFlag: 'C',
    longFlags: ['ignore-environment', 'debug', 'list-signal-handling'],
    longOptional: ['block-signal', 'default-signal', 'ignore-signal'],
    longValues: ['argv0', 'chdir', 'split-string', 'unset'],
  }],
  ['sudo', {
    shortFlags: 'ABbEHkNnPSs', shortValues: 'aCcDgprTtu', chdirFlag: 'D',
    longFlags: ['askpass', 'bell', 'background', 'set-home', 'reset-timestamp', 'no-update',
      'non-interactive', 'preserve-groups', 'stdin', 'shell'],
    longOptional: ['preserve-env'],
    longValues: ['auth-type', 'close-from', 'login-class', 'chdir', 'group',
      'prompt', 'role', 'command-timeout', 'type', 'user'],
  }],
  ['command', { shortFlags: 'p' }],
  ['nohup', {}],
  ['nice', { shortValues: 'n', longValues: ['adjustment'] }],
  ['time', {
    shortFlags: 'apqv', shortValues: 'fo',
    longFlags: ['append', 'portability', 'quiet', 'verbose'], longValues: ['format', 'output'],
  }],
  ['doas', { shortFlags: 'ns', shortValues: 'au' }],
  ['xargs', {
    shortFlags: '0oprtx', shortValues: 'adEILnPs',
    shortOptional: 'eil',
    longFlags: ['exit', 'interactive', 'no-run-if-empty', 'null', 'open-tty', 'verbose'],
    longOptional: ['eof', 'max-lines', 'replace'],
    longValues: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'],
  }],
]);
const commandName = (token) => path.win32.basename(token).toLowerCase().replace(/\.exe$/, '');
const gitEnvironment = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];

// GNU env -S builds argv. Shell control punctuation inside it is ordinary text.
function splitEnvString(source) {
  const words = [];
  let word = '';
  let started = false;
  let quote;
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const escapes = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 0; i < source.length; i++) {
    let c = source[i];
    if (c === quote) { quote = undefined; continue; }
    if (!quote && (c === '"' || c === "'")) { quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) { endWord(); continue; }
    if (!started && c === '#') break;
    if (c === '\\' && (quote !== "'" || /[\\']/.test(source[i + 1] ?? ''))) {
      c = source[++i];
      if (c === '_' && !quote) { endWord(); continue; }
      if (c === 'c' && !quote) break;
      if (c === '_') c = ' ';
      else if (Object.hasOwn(escapes, c)) c = escapes[c];
      else if (!c || !/["#$'\\]/.test(c)) return null;
    }
    word += c;
    started = true;
  }
  if (quote) return null;
  endWord();
  return words;
}

function readWrapperOptions(tokens, index, wrapper, options) {
  let cwd;
  let cleanEnvironment = false;
  const unset = [];
  while (index < tokens.length) {
    const arg = tokens[index];
    if (arg === '--') { index++; break; }
    if (wrapper === 'env' && arg === '-') { cleanEnvironment = true; index++; break; }
    if (wrapper === 'nice' && /^-\d+$/.test(arg)) { index++; continue; }
    if (!arg.startsWith('-') || arg === '-') break;
    index++;

    let value;
    let name;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      name = arg.slice(2, equals < 0 ? undefined : equals);
      if (options.longOptional?.includes(name)) continue;
      if (equals < 0 && options.longFlags?.includes(name)) {
        if (wrapper === 'env' && name === 'ignore-environment') cleanEnvironment = true;
        continue;
      }
      if (!options.longValues?.includes(name)) return null;
      value = equals < 0 ? tokens[index++] : arg.slice(equals + 1);
    } else {
      let flag = 1;
      while (flag < arg.length && options.shortFlags?.includes(arg[flag])) {
        if (wrapper === 'env' && arg[flag] === 'i') cleanEnvironment = true;
        flag++;
      }
      if (flag === arg.length) continue;
      name = arg[flag];
      if (options.shortOptional?.includes(name)) continue;
      if (!options.shortValues?.includes(name)) return null;
      value = arg.slice(flag + 1) || tokens[index++];
    }
    if (value === undefined) return null;
    if (name === options.chdirFlag || name === 'chdir') cwd = value;
    if (wrapper === 'env' && (name === 'u' || name === 'unset')) unset.push(value);
    if (wrapper === 'env' && (name === 'S' || name === 'split-string')) {
      const split = splitEnvString(value);
      if (!split) return null;
      tokens = [...split, ...tokens.slice(index)];
      index = 0;
    }
  }
  if (wrapper === 'env' && tokens[index] === '-') { cleanEnvironment = true; index++; }
  return { tokens, index, cwd, cleanEnvironment, unset };
}

async function resolveDirectory(dir, target) {
  // Expansions need the caller's shell. Keep the last known directory.
  if (!target || target.startsWith('~') || /[$`]/.test(target)) return dir;
  const nextDir = path.resolve(dir, msysToWin(target));
  const info = await stat(nextDir).catch(() => null);
  return info?.isDirectory() ? nextDir : dir;
}

function shellScript(args, documents) {
  let stdin = false;
  let commandString = false;
  let i = 1;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (arg === '-' || !/^[-+]/.test(arg)) break;
    if (arg === '--help' || arg === '--version') return;
    if (arg === '--rcfile' || arg === '--init-file') { i++; continue; }
    if (arg === '--stdin') stdin = true;
    if (arg.startsWith('--')) continue;
    for (const flag of arg.slice(1)) {
      if (flag === 'c') commandString = true;
      if (flag === 's') stdin = true;
      if (flag === 'o' || flag === 'O') i++;
    }
  }
  if (commandString) return args[i];
  if (stdin || i === args.length || args[i] === '-') return documents.findLast((doc) => doc.input)?.body;
}

const gitSelectors = ['--git-dir', '--work-tree', '--namespace'];
const gitFlags = ['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects',
  '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs'];

function gitCommitTarget(args, cwd, gitEnv) {
  const options = [];
  let i = 1;
  for (; args[i]?.startsWith('-'); i++) {
    const arg = args[i];
    if (arg === '-C') {
      const target = args[++i];
      if (target === undefined) return;
      if (target) cwd = path.resolve(cwd, msysToWin(target));
      continue;
    }
    if (arg === '-c' || arg === '--config-env') { i++; continue; }
    if (arg.startsWith('--config-env=') || arg.startsWith('--exec-path=')) continue;
    if (gitFlags.includes(arg)) {
      if (arg === '--bare' || arg === '--no-replace-objects' || arg === '--no-lazy-fetch') options.push(arg);
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    // Remaining flags either report information, such as --version, or are unknown.
    if (!gitSelectors.includes(name)) return;
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined) return;
    options.push(`${name}=${name === '--namespace' ? value : msysToWin(value)}`);
  }
  if (args[i] === 'commit') return { cwd, options, gitEnv };
}

const isPipeline = (op) => op === '|' || op === '|&';

async function* findCommits(cmd, baseCwd, inheritedEnv = {}) {
  let dir = baseCwd;
  const scopes = [{ listStart: dir }];
  const segments = tokenize(cmd);
  commands: for (const [index, seg] of segments.entries()) {
    const before = segments[index - 1];
    const after = segments[index + 1];
    if (typeof seg === 'string') {
      if (seg === '(' || seg === '{') {
        scopes.push({ entry: dir, listStart: dir, scoped: seg === '(' || isPipeline(before) });
      } else if ((seg === ')' || seg === '}') && scopes.length > 1) {
        const scope = scopes.pop();
        if (scope.scoped || isPipeline(after)) dir = scope.entry;
      } else if (seg === '&' || seg === ';' || seg === '\n') {
        const scope = scopes.at(-1);
        if (seg === '&') dir = scope.listStart;
        scope.listStart = dir;
      }
      continue;
    }

    let commandDir = dir;
    const gitEnv = { ...inheritedEnv };
    let tokens = seg.words;
    let i = 0;
    while (i < tokens.length) {
      const prefix = tokens[i];
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(prefix);
      if (assignment) {
        const [, name, value] = assignment;
        if (gitEnvironment.includes(name)) gitEnv[name] = name === 'GIT_NAMESPACE' ? value : msysToWin(value);
        i++;
        continue;
      }
      if (shellKeywords.has(prefix)) { i++; continue; }
      const wrapper = commandName(prefix);
      const options = wrapperOptions.get(wrapper);
      if (!options) break;
      const parsed = readWrapperOptions(tokens, i + 1, wrapper, options);
      if (!parsed) continue commands;
      tokens = parsed.tokens;
      i = parsed.index;
      if (parsed.cwd !== undefined) commandDir = await resolveDirectory(commandDir, parsed.cwd);
      for (const name of gitEnvironment) {
        if (parsed.cleanEnvironment || parsed.unset.includes(name)) gitEnv[name] = undefined;
      }
    }
    const t = tokens.slice(i);
    if (!t.length) continue;
    if (t[0] === 'cd') {
      if (!isPipeline(before) && !isPipeline(after)) dir = await resolveDirectory(dir, t[1]);
      continue;
    }

    const program = commandName(t[0]);
    let nested;
    if (t[0] === 'eval') nested = t.slice(1).join(' ');
    if (program === 'bash' || program === 'sh') {
      nested = shellScript(t, seg.documents);
    }
    if (nested) yield* findCommits(nested, commandDir, gitEnv);
    if (program === 'git') {
      const target = gitCommitTarget(t, commandDir, gitEnv);
      if (target) yield target;
    }
  }
}

// ---- checks ----
async function inferSlug(chatDir, folder) {
  let files;
  try { files = (await readdir(path.join(chatDir, 'status'))).filter((f) => f.endsWith('.md')); } catch { return null; }
  const esc = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`, 'i');
  const hits = [];
  for (const f of files) {
    try {
      if (re.test(await readFile(path.join(chatDir, 'status', f), 'utf8'))) hits.push(f.replace(/\.md$/, ''));
    } catch { /* ignore */ }
  }
  return hits.length === 1 ? hits[0] : null;
}

async function hotFiles(chatDir, mySlug, staged) {
  const out = [];
  let files;
  try { files = (await readdir(path.join(chatDir, 'status'))).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const session = f.replace(/\.md$/, '');
    if (session === mySlug) continue;
    let text;
    try { text = await readFile(path.join(chatDir, 'status', f), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^Hot files:/.test(l));
    if (start < 0) continue;
    const section = [lines[start].replace(/^Hot files:/, '')];
    for (let k = start + 1; k < lines.length; k++) {
      if (/^[A-Za-z][A-Za-z0-9 ()\/-]*:(\s|$)/.test(lines[k])) break;
      section.push(lines[k]);
    }
    for (const file of staged) {
      const base = file.split('/').pop();
      const hit = section.find((l) => l.includes(base));
      if (hit) out.push({ level: 'WARN', msg: `${base} is in ${session}'s Hot files: ${hit.trim().slice(0, 160)}` });
    }
  }
  return out;
}

// ---- reservations ----
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

async function activeReservations(chatDir, now) {
  const out = [];
  let files;
  try { files = (await readdir(path.join(chatDir, 'reservations'))).filter((f) => f.endsWith('.md')); } catch { return out; }
  for (const f of files) {
    const file = path.join(chatDir, 'reservations', f);
    const owner = await readField(file, 'owner');
    const pattern = await readField(file, 'pattern');
    const exp = Number(await readField(file, 'expires_epoch'));
    if (!owner || !pattern || !Number.isFinite(exp) || exp * 1000 <= now) continue;
    out.push({
      owner,
      pattern,
      mode: (await readField(file, 'mode')) || 'shared',
      why: (await readField(file, 'why')) || 'no reason given',
      exp,
    });
  }
  return out;
}

const hhmmz = (epoch) => `${new Date(epoch * 1000).toISOString().slice(11, 16)}Z`;

async function reservationChecks(chatDir, mySlug, staged) {
  const out = [];
  const list = await activeReservations(chatDir, Date.now());
  for (const r of list) {
    if (mySlug && r.owner === mySlug) continue;
    let re;
    try { re = globToRegExp(r.pattern); } catch { continue; }
    for (const file of staged) {
      if (!re.test(file)) continue;
      const exclusive = r.mode === 'exclusive';
      out.push({
        level: exclusive && mySlug ? 'BLOCK' : 'WARN',
        msg: exclusive
          ? `${file} is exclusively reserved by ${r.owner} until ${hhmmz(r.exp)} (${r.why})${mySlug ? '' : '; guard could not identify this session (use --slug or ZM_SLUG)'}`
          : `${file} is reserved (shared) by ${r.owner} until ${hhmmz(r.exp)} (${r.why})`,
      });
    }
  }
  return out;
}

async function evaluate(dir, slugArg, { options = [], gitEnv = {} } = {}) {
  const git = (cwd, args) => readGit(cwd, args, options, gitEnv);
  const results = [];
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null) return { results, inScope: false };
  const commonAbs = path.resolve(dir, msysToWin(common));
  if (norm(commonAbs) !== norm(path.resolve(msysToWin(REPO_COMMON)))) return { results, inScope: false };
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  const folder = top ? path.basename(top) : path.basename(dir);

  let slug = slugArg || process.env.ZM_SLUG || null;
  if (!slug) slug = await inferSlug(CHAT_DIR, folder);

  const stagedOut = await git(dir, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  const staged = (stagedOut || '').split(/\r?\n/).filter(Boolean);

  // Rule 1: migrations
  const migs = staged.filter((f) => MIG_RE.test(f));
  if (migs.length) {
    const tree = await git(dir, ['ls-tree', '--name-only', 'origin/main', `${MIG_DIR}/`]);
    if (tree === null) {
      results.push({ level: 'WARN', msg: 'origin/main not found; skipped migration checks' });
    } else {
      const onMain = new Set(tree.split(/\r?\n/).filter(Boolean));
      let max = 0;
      for (const p of onMain) {
        const m = /^(\d+)_/.exec(p.split('/').pop());
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      for (const f of migs) {
        if (onMain.has(f)) continue;
        const num = MIG_RE.exec(f)[1];
        const n = parseInt(num, 10);
        if (n <= max) {
          results.push({ level: 'BLOCK', msg: `${f} is numbered ${num}, at or below origin/main's highest (${String(max).padStart(3, '0')}): renumber upward: chat.sh migration <slug> <name> "<ref>"` });
          continue;
        }
        const claim = path.join(CHAT_DIR, 'claims', `migration-${num}.md`);
        if (!(await exists(claim))) {
          results.push({ level: 'BLOCK', msg: `migration ${num} unclaimed: run bash ${CHAT_SH} claim-number ${slug || '<slug>'} ${num} <name> "<ref>" first` });
          continue;
        }
        const owner = (await readField(claim, 'owner')) || '?';
        if (slug) {
          if (owner !== slug) results.push({ level: 'BLOCK', msg: `migration ${num} claimed by ${owner}, not ${slug}` });
        } else {
          results.push({ level: 'WARN', msg: `migration ${num} is claimed by ${owner}; guard could not identify this session (use --slug or ZM_SLUG)` });
        }
      }
    }
  }

  // Rule 2: freeze
  const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (branch === 'main') {
    const lock = path.join(CHAT_DIR, 'locks', 'main-freeze.md');
    if (await exists(lock)) {
      const owner = (await readField(lock, 'owner')) || '?';
      if (owner !== slug) results.push({ level: 'BLOCK', msg: `main-freeze is held by ${owner}; do not commit on main` });
    }
  }

  // Rule 3: hot files
  results.push(...(await hotFiles(CHAT_DIR, slug, staged)));

  // Rule 4: file reservations held by other sessions
  results.push(...(await reservationChecks(CHAT_DIR, slug, staged)));
  return { results, inScope: true };
}

function report(results, stream) {
  for (const r of results) stream.write(`zippermerge guard: ${r.level} ${r.msg}\n`);
}

async function main() {
  const mode = process.argv[2];
  const argv = process.argv.slice(3);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  if (mode === 'check') {
    const { results } = await evaluate(path.resolve(opt('--cwd') || process.cwd()), opt('--slug'));
    report(results, process.stdout);
    process.exitCode = results.some((r) => r.level === 'BLOCK') ? 2 : 0;
    return;
  }
  if (mode === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    if (input.tool_name !== 'Bash') return;
    const cmd = input.tool_input && input.tool_input.command;
    if (typeof cmd !== 'string') return;
    const targets = findCommits(cmd, path.resolve(msysToWin(input.cwd || process.cwd())));
    // identity/<session_id>.json is written by capture.mjs when it sees a chat.sh call
    let learned;
    try {
      const sid = typeof input.session_id === 'string' ? input.session_id : '';
      if (/^[A-Za-z0-9_-]{1,100}$/.test(sid)) {
        const j = JSON.parse(await readFile(path.join(CHAT_DIR, 'identity', `${sid}.json`), 'utf8'));
        if (typeof j.slug === 'string' && /^[a-z0-9_-]{1,24}$/.test(j.slug) && j.slug !== HUMAN) learned = j.slug;
      }
    } catch { /* no identity yet */ }
    const seen = new Set();
    const reported = new Set();
    for await (const target of targets) {
      const key = JSON.stringify(target, (_key, value) => value === undefined ? null : value);
      if (seen.has(key)) continue;
      seen.add(key);
      const { results } = await evaluate(target.cwd, process.env.ZM_SLUG ? undefined : learned, target);
      report(results.filter(({ level, msg }) => {
        const line = `${level} ${msg}`;
        if (reported.has(line)) return false;
        reported.add(line);
        return true;
      }), process.stderr);
      if (results.some((r) => r.level === 'BLOCK')) process.exitCode = 2;
    }
    return;
  }
  process.stderr.write('usage: guard.mjs check [--slug S] [--cwd DIR] | guard.mjs hook\n');
}

main().catch((e) => {
  process.stderr.write(`zippermerge guard: WARN internal error, failing open: ${e && e.message ? e.message : e}\n`);
});
