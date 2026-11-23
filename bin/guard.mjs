#!/usr/bin/env node
// zippermerge commit guard (see CLAUDE.md in this folder).
//   node guard.mjs check [--slug S] [--cwd DIR]
//   node guard.mjs hook        (Claude Code PreToolUse: JSON on stdin)
// Read-only. Hook mode blocks if shell analysis cannot complete.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, access } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { CHAT_ROOT, CHAT_SH, HUMAN, MIG_DIR, hookRepoCommon, canonicalPath } from './config.mjs';
import { gitSubcommand, inspectShellCommands } from './shell-parse.mjs';

const run = promisify(execFile);
const CHAT_DIR = CHAT_ROOT;
const MIG_RE = new RegExp(`^${MIG_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d+)_.+\\.sql$`);

// Classify Git operations by the ref they may change. Unknown commands (including
// aliases), configurable refspecs, and multi-ref transactions have no proven
// destination, so a freeze covers them from every worktree of this repository.
const protectedRef = 'refs/heads/main';
const unknownRef = '*';
const headOperations = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'reset', 'read-tree']);
const recoveryOperations = new Set(['merge', 'cherry-pick', 'revert', 'am', 'rebase']);
const noBranchWrites = new Set([
  'add', 'annotate', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'grep',
  'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'rev-list', 'rev-parse',
  'show', 'show-ref', 'status', 'version',
]);
const gitScopeEnv = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];

function branchRef(name) {
  if (!name || !/^[a-zA-Z0-9_][a-zA-Z0-9._/-]*$/.test(name)) return unknownRef;
  return 'refs/heads/' + name;
}

function freezeDestination(operation, args) {
  const [first, second] = args;
  const simpleOperands = args.slice(1).every(value => !value.startsWith('-') && !value.includes('\0'));
  if (noBranchWrites.has(operation)) return null;
  if (args.length === 1 && recoveryOperations.has(operation)
    && ['--abort', '--quit', '-h', '--help'].includes(first)) return null;
  if (operation === 'reset') {
    const separator = args.indexOf('--');
    if (separator >= 0 && separator < args.length - 1
      && (separator === 0 || (separator === 1 && !first.startsWith('-')))) return null;
  }
  if (headOperations.has(operation)) return 'HEAD';
  if (operation === 'stash' && ['pop', 'apply', 'push', 'save'].includes(first)) return 'HEAD';
  if (operation === 'branch') {
    if (!args.length || (args.length === 1 && ['--show-current', '--list', '-l'].includes(first))) return null;
    if ((first === '-f' || first === '--force') && args.length <= 3 && simpleOperands) return branchRef(second);
  }
  if (operation === 'update-ref' && first?.startsWith('refs/heads/') && args.length <= 3 && simpleOperands) {
    return branchRef(first.slice('refs/heads/'.length));
  }
  if ((operation === 'checkout' && first === '-B') || (operation === 'switch' && first === '-C')) {
    if (args.length <= 3 && simpleOperands) return branchRef(second);
  }
  // A simple local transfer has one explicit destination. Other forms can use
  // configured mappings, multiple destinations, transactions, or another repo.
  if ((operation === 'fetch' || operation === 'push') && first === '.' && args.length === 2) {
    const spec = /^\+?[\w./][\w./-]*:refs\/heads\/([\w./-]+)$/.exec(second);
    if (spec) return branchRef(spec[1]);
  }
  return unknownRef;
}

// The shared parser resolves shell execution paths and parses Git's global
// options. Forward only repository selectors to our read-only Git probes.
function guardTarget({ tool, args, cwd, environment }) {
  if (tool !== 'git') return;
  const selectors = new Map();
  const flags = [];
  const values = args.map(({ value }) => value);
  let operand = 0;
  let customConfig = false;
  const operation = gitSubcommand(values, ({ name, value, nextIndex }) => {
    operand = nextIndex;
    if (name === 'c' || name === 'config-env') customConfig = true;
    if (value?.includes('\0')) return;
    if (name === 'C' && value) cwd = canonicalPath(value, cwd);
    if (['git-dir', 'work-tree', 'namespace'].includes(name)) selectors.set(name, value);
    if (['bare', 'no-replace-objects', 'no-lazy-fetch'].includes(name)) flags.push('--' + name);
  });
  if (!operation && (!values.length || ['--version', '--help', '-h'].includes(values[0]))) return;
  const destination = freezeDestination(operation, values.slice(operand + 1));
  if (!destination) return;
  const prefixes = ['-C', cwd, ...flags];
  for (const [name, value] of selectors) {
    prefixes.push('--' + name + '=' + (name === 'namespace' ? value : canonicalPath(value, cwd)));
  }
  const gitEnv = {};
  for (const name of gitScopeEnv) {
    const value = environment.values.has(name) ? environment.values.get(name) : environment.base[name];
    if (value && !value.includes('\0')) gitEnv[name] = name === 'GIT_NAMESPACE' ? value : canonicalPath(value, cwd);
  }
  return { cwd, prefixes, gitEnv, destination: customConfig ? unknownRef : destination, freezeOnly: operation !== 'commit' };
}

function probeOptions(dir, target) {
  if (!target) return { prefixes: ['-C', dir] };
  const env = { ...process.env };
  for (const name of gitScopeEnv) delete env[name];
  return { prefixes: target.prefixes, env: Object.assign(env, target.gitEnv) };
}

async function git(dir, args, target, emptyOnExit) {
  const { prefixes, env } = probeOptions(dir, target);
  try {
    const { stdout } = await run('git', [...prefixes, ...args], {
      env, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (emptyOnExit !== undefined && error.code === emptyOnExit) return '';
    return null;
  }
}

async function readGitFields(dir, args, visit, target) {
  const { prefixes, env } = probeOptions(dir, target);
  const child = spawn('git', [...prefixes, ...args], {
    env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
  child.stdout.setEncoding('utf8');
  let pending = '';
  try {
    for await (const chunk of child.stdout) {
      const fields = (pending + chunk).split('\0');
      pending = fields.pop();
      for (const field of fields) visit(field);
    }
  } catch {
    child.kill();
    return false;
  }
  return (await exited) && pending === '';
}

async function readStagedPaths(dir, target) {
  const staged = new Set();
  const migs = [];
  let status = null;
  let readSource = false;
  const ok = await readGitFields(dir, ['diff', '--cached', '--no-relative', '--name-status', '-z'], (field) => {
    if (status === null) {
      status = field[0];
      readSource = status === 'R' || status === 'C';
    } else if (readSource) {
      // Renames touch both paths. Copies leave the source untouched.
      if (status === 'R') staged.add(field);
      readSource = false;
    } else {
      staged.add(field);
      if ('ACMR'.includes(status) && MIG_RE.test(field)) migs.push(field);
      status = null;
    }
  }, target);
  return ok && status === null ? { staged, migs } : null;
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

function isDirectory(dir) {
  try {
    return statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return undefined;
  }
}

function canRedirect(file, operator) {
  try {
    const info = statSync(file, { throwIfNoEntry: false });
    if (operator === '<') return !!info;
    if (info) return !info.isDirectory();
    return isDirectory(path.dirname(file));
  } catch {
    return undefined;
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
  let g = glob.replace(/\\/g, '/');
  if (g.endsWith('/')) g += '**';
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
  return new RegExp(`^${re}$`, 'is');
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

async function evaluate(dir, slugArg, target) {
  const results = [];
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], target);
  const actualCommon = common && canonicalPath(common, dir);
  const repoCommon = hookRepoCommon(actualCommon);
  if (!actualCommon || !repoCommon || path.relative(repoCommon, actualCommon)) return { results, inScope: false };
  const top = await git(dir, ['rev-parse', '--show-toplevel'], target);
  const folder = top ? path.basename(top) : path.basename(dir);

  let slug = slugArg || process.env.ZM_SLUG || null;
  if (!slug) slug = await inferSlug(CHAT_DIR, folder);

  const lock = path.join(CHAT_DIR, 'locks', 'main-freeze.md');
  if (await exists(lock)) {
    const owner = (await readField(lock, 'owner')) || '?';
    const ref = target?.destination ?? 'HEAD';
    if (owner !== slug) {
      // Exit 1 means a direct ref (including detached HEAD). Other probe
      // failures leave the destination unknown and must respect the freeze.
      const symbolic = ref === unknownRef || ref.toLowerCase() === protectedRef ? ref
        : await git(dir, ['symbolic-ref', '-q', ref], target, 1);
      if (symbolic === null || symbolic === unknownRef || symbolic.toLowerCase() === protectedRef) {
        const hint = slug ? '' : '; guard could not identify this session (use --slug or ZM_SLUG)';
        results.push({ level: 'BLOCK', msg: `main-freeze is held by ${owner}; this operation may change main${hint}` });
      }
    }
  }
  if (target?.freezeOnly) return { results, inScope: true };

  const paths = await readStagedPaths(dir, target);
  if (paths === null) results.push({ level: 'WARN', msg: 'could not read staged paths from Git; skipped staged path checks' });
  const { staged, migs } = paths ?? { staged: [], migs: [] };

  // Rule 1: migrations
  if (migs.length) {
    const onMain = new Set();
    const ok = await readGitFields(dir, ['ls-tree', '--full-tree', '--name-only', '-z', 'origin/main', `${MIG_DIR}/`],
      (file) => onMain.add(file), target);
    if (!ok) {
      results.push({ level: 'WARN', msg: 'could not read migrations from origin/main; skipped migration checks' });
    } else {
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
        const claim = path.join(CHAT_DIR, 'claims', `migration-${String(n).padStart(3, '0')}.md`);
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

  // Rule 3: hot files
  for (const result of await hotFiles(CHAT_DIR, slug, staged)) results.push(result);

  // Rule 4: file reservations held by other sessions
  for (const result of await reservationChecks(CHAT_DIR, slug, staged)) results.push(result);
  return { results, inScope: true };
}

function report(results, stream) {
  for (const r of results) stream.write(`zippermerge guard: ${r.level} ${r.msg}\n`);
}

function blockShellAnalysis(reason) {
  report([{ level: 'BLOCK', msg: 'shell analysis could not complete (' + reason + ')' }], process.stderr);
  process.exitCode = 2;
}

async function main() {
  const mode = process.argv[2];
  const argv = process.argv.slice(3);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  if (mode === 'check') {
    const { results } = await evaluate(canonicalPath(opt('--cwd') || '.'), opt('--slug'));
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
    const { commands, incomplete } = inspectShellCommands(cmd, {
      cwd: canonicalPath(input.cwd || '.'), environment: process.env,
      resolvePath: canonicalPath, isDirectory, canRedirect,
    });
    if (incomplete) {
      if (hookRepoCommon()) blockShellAnalysis(incomplete);
      return;
    }
    const targets = commands.map(guardTarget).filter(Boolean);
    if (!targets.length) return;
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
    const results = [];
    for (const target of targets) {
      const key = JSON.stringify(target);
      if (seen.has(key)) continue;
      seen.add(key);
      const checked = await evaluate(target.cwd, process.env.ZM_SLUG ? undefined : learned, target);
      results.push(...checked.results);
    }
    report(results, process.stderr);
    process.exitCode = results.some((r) => r.level === 'BLOCK') ? 2 : 0;
    return;
  }
  process.stderr.write('usage: guard.mjs check [--slug S] [--cwd DIR] | guard.mjs hook\n');
}

main().catch((e) => {
  if (process.argv[2] === 'hook') {
    blockShellAnalysis('internal hook error');
    return;
  }
  process.stderr.write(`zippermerge guard: WARN internal error, failing open: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 0;
});
