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

// Classify Git operations by the ref they may change. Resolve transfers from
// the target repository's configuration. Aliases and indeterminate writes
// require the freeze holder in every worktree of this repository.
const protectedRef = 'refs/heads/main';
const unknownRef = '*';
const configuredRefs = 'configured';
const headOperations = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'am', 'reset', 'read-tree',
  'restore', 'apply', 'bisect', 'clean']);
const recoveryOperations = new Set(['merge', 'cherry-pick', 'revert', 'am', 'rebase']);
const noBranchWrites = new Set([
  'add', 'annotate', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'grep',
  'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'rev-list', 'rev-parse',
  'show', 'show-ref', 'status', 'version', 'gc',
]);
const gitScopeEnv = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE'];

function branchRef(name) {
  if (!name || !/^[a-zA-Z0-9_][a-zA-Z0-9._/-]*$/.test(name)) return unknownRef;
  return 'refs/heads/' + name;
}

function freezeDestination(operation, args, compound) {
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
  if (operation === 'stash') {
    if (!first || ['pop', 'apply', 'push', 'save'].includes(first)) return 'HEAD';
    if (['list', 'show'].includes(first)) return null;
  }
  if (operation === 'remote' && (!args.length || (args.length === 1 && ['-v', '--verbose'].includes(first)))) return null;
  if (operation === 'config' && (first === '--get' || first === '--list'
    || (/^[\w-]+\.[\w.-]+$/.test(first) && args.length <= 2
      && (!compound || !second || /^user\.(?:name|email)$/i.test(first))))) return null;
  if (operation === 'sparse-checkout' && first === 'list') return null;
  if (operation === 'submodule' && first === 'update') return 'HEAD';
  if (operation === 'tag' && args.length === 1 && branchRef(first) !== unknownRef) return 'refs/tags/' + first;
  if (operation === 'worktree') {
    if (first === 'list' || first === 'remove') return null;
    if (first === 'add' && simpleOperands && second) return branchRef(path.basename(second));
  }
  if (operation === 'branch') {
    if (!args.length || (args.length === 1 && ['--show-current', '--list', '-l'].includes(first))) return null;
    if ((first === '-f' || first === '--force') && args.length <= 3 && simpleOperands) return branchRef(second);
    if (['-d', '-D', '--delete'].includes(first) && args.length === 2) return branchRef(second);
    if (args.length <= 2 && simpleOperands && !first.startsWith('-')) return branchRef(first);
  }
  if (operation === 'update-ref' && first?.startsWith('refs/heads/') && args.length <= 3 && simpleOperands) {
    return branchRef(first.slice('refs/heads/'.length));
  }
  if (operation === 'checkout' || operation === 'switch') {
    if (operation === 'checkout' && first === '--') return 'HEAD';
    // A standalone switch attaches HEAD without moving the branch tip. In
    // a compound command later writes may act on the newly attached branch.
    if (args.length === 1 && branchRef(first) !== unknownRef) return compound ? branchRef(first) : null;
    const create = operation === 'checkout' ? ['-B', '-b'] : ['-C', '-c', '--create', '--force-create'];
    if (create.includes(first) && args.length <= 3 && simpleOperands) return branchRef(second);
  }
  if (['fetch', 'push', 'pull', 'rebase'].includes(operation)) return configuredRefs;
  return unknownRef;
}

// The shared parser resolves shell execution paths and parses Git's global
// options. Forward only repository selectors to our read-only Git probes.
function guardTarget({ args, cwd, environment }, compound) {
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
  const operands = values.slice(operand + 1);
  const destination = freezeDestination(operation, operands, compound);
  if (!destination) return;
  // Config-sensitive decisions must use the same settings as the proposed
  // process. Do not evaluate arbitrary inline configuration in a probe.
  if (destination === configuredRefs) {
    const keys = new Set([...Object.keys(process.env), ...environment.values.keys()]);
    for (const key of keys) {
      if (!/^(?:GIT_CONFIG.*|HOME|XDG_CONFIG_HOME)$/i.test(key)) continue;
      const value = environment.values.has(key) ? environment.values.get(key) : environment.base[key];
      if (value !== process.env[key]) customConfig = true;
    }
  }
  const prefixes = ['-C', cwd, ...flags];
  for (const [name, value] of selectors) {
    prefixes.push('--' + name + '=' + (name === 'namespace' ? value : canonicalPath(value, cwd)));
  }
  const gitEnv = {};
  for (const name of gitScopeEnv) {
    const value = environment.values.has(name) ? environment.values.get(name) : environment.base[name];
    if (value && !value.includes('\0')) gitEnv[name] = name === 'GIT_NAMESPACE' ? value : canonicalPath(value, cwd);
  }
  return { cwd, prefixes, gitEnv, operation, operands, destination: customConfig ? unknownRef : destination,
    freezeOnly: operation !== 'commit' };
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

// Read only ref-routing settings. No push, fetch, remote helper, or dry run
// is invoked by the hook. Git config supplies the effective local settings.
async function configuredDestinations(dir, target) {
  const { operation, operands } = target;
  const settings = await git(dir, ['config', '--null', '--get-regexp',
    '^(branch\\..*\\.(remote|pushremote|merge)|remote\\..*\\.(url|push|fetch|mirror)|remote\\.pushdefault|remotes\\..*|push\\.default|fetch\\.all|rebase\\.updaterefs)$'], target, 1);
  if (settings === null) return [unknownRef];
  const config = new Map();
  const remotes = new Set();
  for (const field of settings.split('\0').filter(Boolean)) {
    const newline = field.indexOf('\n');
    const key = newline < 0 ? field : field.slice(0, newline);
    const value = newline < 0 ? 'true' : field.slice(newline + 1);
    if (!config.has(key)) config.set(key, []);
    config.get(key).push(value);
    const remote = /^remote\.(.+)\.(url|fetch|push|mirror)$/.exec(key);
    if (remote) remotes.add(remote[1]);
  }
  const enabled = key => config.has(key) && !/^(?:false|off|no|0)$/i.test(config.get(key).at(-1));
  if (operation === 'rebase') {
    if (enabled('rebase.updaterefs')) return [unknownRef];
    const upstream = operands.filter(arg => !['-i', '--interactive', '--root', '--no-update-refs'].includes(arg));
    return upstream.length <= 1 && upstream.every(arg => branchRef(arg) !== unknownRef) ? ['HEAD'] : [unknownRef];
  }
  if (operation === 'pull' && enabled('rebase.updaterefs')) return [unknownRef];
  const push = operation === 'push';
  const allowedFlags = push ? ['-u', '--set-upstream', '-f', '--force', '--force-with-lease', '--delete', '-d']
    : ['--all', '--prune', '-p', '--rebase', '--no-rebase', '--ff-only', '-f', '--force', '--update-head-ok'];
  const words = [];
  for (const arg of operands) {
    if (allowedFlags.includes(arg) || (push && arg.startsWith('--force-with-lease='))) continue;
    if (arg.startsWith('-') || arg.includes('\0')) return [unknownRef];
    words.push(arg);
  }
  const current = await git(dir, ['symbolic-ref', '-q', 'HEAD'], target, 1);
  if (current === null) return [unknownRef];
  const all = operands.includes('--all') || (operation === 'fetch' && !words.length && enabled('fetch.all'));
  const refs = [];
  for (const head of new Set([current, ...target.projectedHeads])) {
    refs.push(...transferDestinations(operation, words, head, config, remotes, all));
  }
  return refs;
}

function transferDestinations(operation, words, head, config, remotes, all) {
  const push = operation === 'push';
  const last = key => config.get(key)?.at(-1);
  const branch = 'branch.' + (head || '').replace(/^refs\/heads\//, '');
  const [remoteArg, ...specs] = words;
  const defaultRemote = (push && (last(branch + '.pushremote') || last('remote.pushdefault')))
    || last(branch + '.remote') || (remotes.size === 1 ? [...remotes][0] : 'origin');
  const names = all ? [...remotes] : [remoteArg || defaultRemote];
  if (names.some(name => config.has('remotes.' + name))) return [unknownRef];
  const refs = operation === 'pull' ? ['HEAD'] : [];
  for (const name of names) {
    const prefix = 'remote.' + name;
    const tracking = config.get(prefix + '.fetch') || [];
    if (!push) {
      const sources = specs.map(spec => spec.replace(/^\+/, '').split(':')[0]);
      refs.push(...mappedDestinations(tracking, sources, head));
      refs.push(...specs.map(spec => refspecDestination(spec, false, head)));
      continue;
    }
    const mirror = last(prefix + '.mirror');
    if (mirror !== undefined && !/^(?:false|off|no|0)$/i.test(mirror)) return [unknownRef];
    const mappings = config.get(prefix + '.push') || [];
    const pushed = specs.map(spec => refspecDestination(spec, true, head));
    const shorthand = specs.filter(spec => !spec.includes(':'));
    if (!specs.length || shorthand.length) pushed.push(...mappedDestinations(mappings, shorthand, head, true));
    if (!specs.length && !mappings.length) {
      const mode = last('push.default') || 'simple';
      if (['upstream', 'tracking'].includes(mode)) pushed.push(...(config.get(branch + '.merge') || [unknownRef]));
      else if (['simple', 'current'].includes(mode)) pushed.push(head || unknownRef);
      else if (mode !== 'nothing') return [unknownRef];
    }
    // Git may update local tracking refs after a successful push.
    refs.push(...pushed);
    if (pushed.some(Boolean)) refs.push(...mappedDestinations(tracking, pushed.filter(Boolean), head));
  }
  return refs.filter(Boolean);
}

// Git applies a configured refspec only to matching sources. Narrow a
// wildcard mapping to the explicitly selected branch whenever possible.
function mappedDestinations(mappings, sources, head, push = false) {
  const selected = sources.map(name => name.replace(/^\+/, '')).map(name =>
    name === 'HEAD' ? head : name.startsWith('refs/') ? name : branchRef(name));
  const refs = [];
  for (const spec of mappings) {
    if (spec.startsWith('^')) continue;
    const [source, dest] = spec.replace(/^\+/, '').split(':');
    if (!selected.length || selected.some(ref => !ref || ref.includes('*')) || !dest) {
      refs.push(refspecDestination(spec, push, head));
      continue;
    }
    const pattern = source.startsWith('refs/') ? source : 'refs/heads/' + source;
    const [prefix, suffix] = pattern.split('*');
    for (const ref of selected) {
      if (ref === pattern) refs.push(refspecDestination(spec, push, head));
      else if (suffix !== undefined && ref.startsWith(prefix) && ref.endsWith(suffix)) {
        const match = ref.slice(prefix.length, ref.length - suffix.length);
        refs.push(refspecDestination(source + ':' + dest.replace('*', () => match), push, head));
      }
    }
  }
  return refs;
}

function refspecDestination(spec, push, head) {
  if (spec.startsWith('^')) return null; // negative refspecs only exclude
  const [source, dest, extra] = spec.replace(/^\+/, '').split(':');
  if (extra !== undefined) return unknownRef;
  if (!push && !dest) return null; // FETCH_HEAD only
  const ref = dest ?? source;
  if (ref === 'HEAD') return !dest && push ? head || unknownRef : unknownRef;
  if (ref.startsWith('refs/')) return ref;
  return branchRef(ref);
}

async function mayChangeMain(dir, target, ref) {
  if (ref === unknownRef || ref.toLowerCase() === protectedRef) return true;
  if (ref.includes('*')) {
    // The normal fetch wildcard writes only remote-tracking refs. Check any
    // symbolic refs there before treating that namespace as independent.
    if (!/^refs\/remotes\/[\w./-]+\/\*$/.test(ref)) return true;
    const syms = await git(dir, ['for-each-ref', '--format=%(symref)', ref.slice(0, -1)], target);
    return syms === null || syms.toLowerCase().split(/\r?\n/).includes(protectedRef);
  }
  if (ref !== 'HEAD' && (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('//') || ref.endsWith('/'))) return true;
  // Exit 1 is a direct ref (including detached HEAD). Other probe failures
  // leave the destination unknown.
  const symbolic = await git(dir, ['symbolic-ref', '-q', ref], target, 1);
  return symbolic === null || symbolic.toLowerCase() === protectedRef;
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

async function evaluate(dir, slugArg, target, onConfigWarning) {
  const results = [];
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], target);
  const actualCommon = common && canonicalPath(common, dir);
  const repoCommon = hookRepoCommon(actualCommon, onConfigWarning);
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
      const refs = ref === configuredRefs ? await configuredDestinations(dir, target) : [ref];
      for (const candidate of new Set(refs)) {
        if (!(await mayChangeMain(dir, target, candidate))) continue;
        const hint = slug ? '' : '; guard could not identify this session (use --slug or ZM_SLUG)';
        const operation = target?.operation;
        const label = /^[a-z][a-z0-9-]{0,48}$/.test(operation || '') ? 'git ' + operation : 'this operation';
        results.push({ level: 'BLOCK', msg: `main-freeze is held by ${owner}; ${label} may change main${hint}` });
        break;
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
      blockShellAnalysis(incomplete);
      return;
    }
    const gitCommands = commands.filter(({ tool }) => tool === 'git');
    const targets = gitCommands.map(command => guardTarget(command, gitCommands.length > 1)).filter(Boolean);
    // The hook runs before the shell. A preceding checkout may change
    // which branch supplies the defaults for a later transfer.
    const projectedHeads = new Set();
    for (const target of targets) {
      if (target.destination === configuredRefs) target.projectedHeads = [...projectedHeads];
      if (['checkout', 'switch'].includes(target.operation) && target.destination.startsWith('refs/heads/')) {
        projectedHeads.add(target.destination);
      }
    }
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
      const checked = await evaluate(target.cwd, process.env.ZM_SLUG ? undefined : learned, target, warning => {
        process.stdout.write(JSON.stringify({ systemMessage: warning,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }) + '\n');
      });
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
