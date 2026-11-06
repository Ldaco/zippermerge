#!/usr/bin/env node
// zippermerge commit guard (see CLAUDE.md in this folder).
//   node guard.mjs check [--slug S] [--cwd DIR]
//   node guard.mjs hook        (Claude Code PreToolUse: JSON on stdin)
// Read-only. Fails open on any internal error.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_ROOT, CHAT_SH, HUMAN, MIG_DIR, REPO } from './config.mjs';

const run = promisify(execFile);
const msysToWin = (p) => p.replace(/^\/([a-zA-Z])(\/|$)/, (_m, d, s) => `${d.toUpperCase()}:${s || '/'}`);
const CHAT_DIR = msysToWin(CHAT_ROOT);
const REPO_COMMON = process.env.ZM_REPO_COMMON || (REPO ? `${REPO}/.git` : '');
const MIG_RE = new RegExp(`^${MIG_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{3})_.+\\.sql$`);

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function git(dir, args) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
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
function tokenize(cmd) {
  // Returns segments: arrays of tokens, split on && || ; | & newline outside quotes.
  const segs = [];
  let cur = [];
  let tok = '';
  let has = false;
  let q = null;
  const pushTok = () => { if (has) { cur.push(tok); tok = ''; has = false; } };
  const pushSeg = () => { pushTok(); if (cur.length) segs.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) { tok += cmd[++i]; }
      else tok += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\\' && /\s/.test(cmd[i + 1])) { tok += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (c === '\n') pushSeg(); else pushTok(); continue; }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { pushSeg(); continue; }
    tok += c; has = true;
  }
  pushSeg();
  return segs;
}

function findCommit(cmd, baseCwd) {
  let dir = baseCwd;
  let found = null;
  for (const seg of tokenize(cmd)) {
    let i = 0;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i])) i++;
    const t = seg.slice(i);
    if (t[0] === 'cd' && t[1]) { dir = path.resolve(dir, msysToWin(t[1])); continue; }
    if (t[0] !== 'git') continue;
    let j = 1;
    let cdir = null;
    while (j < t.length && t[j].startsWith('-')) {
      if (t[j] === '-C' && t[j + 1]) { cdir = path.resolve(cdir || dir, msysToWin(t[j + 1])); j += 2; }
      else if (['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(t[j])) j += 2;
      else j++;
    }
    if (t[j] === 'commit') { found = cdir || dir; break; }
  }
  return found;
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

async function evaluate(dir, slugArg) {
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
    if (typeof cmd !== 'string' || !/commit/.test(cmd)) return;
    const dir = findCommit(cmd, path.resolve(msysToWin(input.cwd || process.cwd())));
    if (!dir) return;
    // identity/<session_id>.json is written by capture.mjs when it sees a chat.sh call
    let learned;
    try {
      const sid = typeof input.session_id === 'string' ? input.session_id : '';
      if (/^[A-Za-z0-9_-]{1,100}$/.test(sid)) {
        const j = JSON.parse(await readFile(path.join(CHAT_DIR, 'identity', `${sid}.json`), 'utf8'));
        if (typeof j.slug === 'string' && /^[a-z0-9_-]{1,24}$/.test(j.slug) && j.slug !== HUMAN) learned = j.slug;
      }
    } catch { /* no identity yet */ }
    const { results } = await evaluate(dir, process.env.ZM_SLUG ? undefined : learned);
    report(results, process.stderr);
    process.exitCode = results.some((r) => r.level === 'BLOCK') ? 2 : 0;
    return;
  }
  process.stderr.write('usage: guard.mjs check [--slug S] [--cwd DIR] | guard.mjs hook\n');
}

main().catch((e) => {
  process.stderr.write(`zippermerge guard: WARN internal error, failing open: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 0;
});
