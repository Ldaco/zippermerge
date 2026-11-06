#!/usr/bin/env node
// zippermerge capture: Claude Code hook handler for the coordinated repo.
// Records per-session activity, warns on live edit collisions, enforces the full-test-suite lock.
// Fails open: any error means exit 0 with no output.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
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
const CACHE_FILE = path.join(tmpdir(), 'zippermerge-capture-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const COLLISION_WINDOW_MS = 30 * 60 * 1000;
const TAIL_LINES = 400;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// --rewake: collision warning goes to stderr + exit 2 (for asyncRewake hooks)
// --record-only: record the event, never warn or block
const REWAKE = process.argv.includes('--rewake');
const RECORD_ONLY = process.argv.includes('--record-only');
// --block-only: run the checks (lock block / collision) but don't record (the async --record-only hook records)
const BLOCK_ONLY = process.argv.includes('--block-only');

const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
export function redact(cmd) {
  const R = '‹redacted›';
  return String(cmd)
    .replace(/https?:\/\/[^/\s]+@/gi, `${R}@`)
    .replace(/(authorization\s*:\s*)[^"'\r\n]+/gi, `$1${R}`)
    .replace(/Bearer\s+\S+/gi, `Bearer ${R}`)
    .replace(
      /(token|password|secret|api_?key|authorization)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
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

function segmentsOf(cmd) {
  return String(cmd).split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// strip env assignments and runner prefixes so tokens[0] is the real tool
function tokensOf(segment) {
  let t = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1);
  for (let i = 0; i < 3 && t.length; i++) {
    if (/^(npx|pnpx|bunx)$/.test(t[0])) t = t.slice(1);
    else if (/^(pnpm|npm)$/.test(t[0]) && /^(exec|dlx)$/.test(t[1] || '')) t = t.slice(2);
    else break;
  }
  return t;
}

const positionals = (args) => args.filter((a) => a !== '--' && !a.startsWith('-'));
const hasFlag = (args, re) => args.some((a) => re.test(a));

// returns { cat, heavy } for one segment
function classifySegment(segment) {
  const t = tokensOf(segment);
  if (!t.length) return { cat: 'other', heavy: false };
  const [first, ...rest] = t;
  const second = rest[0];
  const scriptName = (rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0]) || '';
  const scriptArgs = rest[0] === 'run' || rest[0] === 'run-script' ? rest.slice(2) : rest.slice(1);
  const scoped = (args) => hasFlag(args, /^(--filter|-F|--workspace|-w)(=|$)/);

  if (first === 'git') {
    const sub = rest.find((a) => !a.startsWith('-')) || '';
    const write = /^(commit|push|merge|rebase|reset|checkout|cherry-pick|stash|switch|restore|am|apply|pull|tag|revert)$/;
    return { cat: write.test(sub) ? 'git-write' : 'git-read', heavy: false };
  }
  if (first === 'gh') return { cat: 'gh', heavy: false };

  if (first === 'vitest' || first === 'jest') {
    const targeted = positionals(rest.filter((a) => a !== 'run' && a !== 'watch')).length > 0
      || hasFlag(rest, /^(-t|--testNamePattern)(=|$)/);
    return { cat: 'test', heavy: !targeted };
  }
  if (first === 'playwright') {
    const args = rest[0] === 'test' ? rest.slice(1) : rest;
    const isTest = rest[0] === 'test';
    const targeted = positionals(args).length > 0 || hasFlag(args, /^(-g|--grep)(=|$)/);
    return { cat: isTest ? 'test' : 'other', heavy: isTest && !targeted };
  }
  if (first === 'turbo' || first === 'turbo.exe') {
    const args = rest[0] === 'run' ? rest.slice(1) : rest;
    const task = args.find((a) => !a.startsWith('-')) || '';
    if (/^test(:|$)/.test(task)) return { cat: 'test', heavy: !scoped(args) };
    if (/^build(:|$)/.test(task)) return { cat: 'build', heavy: !scoped(args) };
  }
  if (first === 'tsc' && hasFlag(rest, /^(-b|--build)$/)) return { cat: 'build', heavy: true };

  if (/^(npm|pnpm|yarn|bun)$/.test(first)) {
    // pnpm --filter x test: flags before the script name
    const all = rest;
    const scripted = scriptName;
    if (/^(install|i|ci|add)$/.test(second || '') || (first === 'yarn' && !second)) {
      return { cat: 'install', heavy: false };
    }
    if (/^test(:|$)/.test(scripted) || (first !== 'npm' && /^test(:|$)/.test(all.find((a) => !a.startsWith('-')) || ''))) {
      const args = all.filter((a) => a !== 'run' && a !== scripted);
      const targeted = scoped(all) || positionals(args).length > 0;
      return { cat: 'test', heavy: !targeted };
    }
    if (/^build(:|$)/.test(scripted) || (first !== 'npm' && /^build(:|$)/.test(all.find((a) => !a.startsWith('-')) || ''))) {
      return { cat: 'build', heavy: !scoped(all) };
    }
  }
  return { cat: 'other', heavy: false };
}

const CAT_RANK = ['test', 'build', 'git-write', 'install', 'gh', 'git-read', 'other'];

export function classify(cmd) {
  let cat = 'other';
  let heavy = false;
  for (const seg of segmentsOf(cmd)) {
    const r = classifySegment(seg);
    if (CAT_RANK.indexOf(r.cat) < CAT_RANK.indexOf(cat)) cat = r.cat;
    if ((r.cat === 'test' || r.cat === 'build') && r.heavy) heavy = true;
  }
  return { category: cat, heavy };
}

// ---- identity ---------------------------------------------------------------
function inferSlug(worktree) {
  try {
    if (!worktree) return null;
    const dir = path.join(CHAT_DIR, 'status');
    const needle = worktree.toLowerCase();
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => {
        try {
          return readFileSync(path.join(dir, f), 'utf8').toLowerCase().includes(needle);
        } catch {
          return false;
        }
      });
    return hits.length === 1 ? hits[0].slice(0, -3) : null;
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9_-]{1,24}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG_CMDS = new Set(['new', 'post', 'reply', 'unreserve', 'reserve', 'migration', 'claim-number']);
const LOCK_CMDS = new Set(['lock', 'unlock', 'break']);

// quote-aware split into segments (on && || ; | & newline) of unquoted-token arrays
function shellSegments(cmd) {
  const segs = [];
  let cur = [];
  let tok = '';
  let has = false;
  let q = null;
  const pushTok = () => { if (has) { cur.push(tok); tok = ''; has = false; } };
  const pushSeg = () => { pushTok(); if (cur.length) segs.push(cur); cur = []; };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else tok += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (c === '\n' || c === '\r') pushSeg(); else pushTok(); }
    else if (c === ';' || c === '|' || c === '&') pushSeg();
    else { tok += c; has = true; }
  }
  pushSeg();
  return segs;
}

// Returns { slug, via } for the first chat.sh invocation in cmd, or null. Slug is only syntactically checked.
export function extractChatSlug(cmd) {
  const vars = {};
  const expand = (t) => t.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => vars[a || b] ?? '');
  for (const seg of shellSegments(cmd)) {
    // leading VAR=value assignments (also a standalone `C=...` segment)
    let i = 0;
    while (i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i])) {
      const eq = seg[i].indexOf('=');
      vars[seg[i].slice(0, eq)] = expand(seg[i].slice(eq + 1));
      i++;
    }
    const toks = seg.slice(i).map(expand);
    const at = toks.findIndex((t) => /(^|[/\\])chat\.sh$/.test(t));
    if (at < 0) continue;
    const args = toks.slice(at + 1);
    const sub = args[0];
    let slug;
    if (LOCK_CMDS.has(sub)) slug = args[2];
    else if (sub === 'guard') {
      const k = args.indexOf('--slug');
      slug = k >= 0 ? args[k + 1] : undefined;
    } else if (SLUG_CMDS.has(sub)) slug = args[1];
    if (slug) return { slug, via: `chat.sh ${sub}` };
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

function learnIdentity(sid, cmd) {
  try {
    if (!SID_RE.test(sid)) return;
    const found = extractChatSlug(cmd);
    if (!found || !slugOk(found.slug)) return;
    const file = identityFile(sid);
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      if (prev.slug === found.slug && Date.now() - statSync(file).mtimeMs < IDENTITY_REFRESH_MS) return;
    } catch {
      // no usable previous file
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ slug: found.slug, at: new Date().toISOString(), via: found.via }));
    renameSync(tmp, file);
  } catch {
    // identity learning is best effort
  }
}

function slugFromIdentity(sid) {
  try {
    if (!SID_RE.test(sid)) return null;
    const { slug } = JSON.parse(readFileSync(identityFile(sid), 'utf8'));
    return typeof slug === 'string' && SLUG_RE.test(slug) && slug !== HUMAN ? slug : null;
  } catch {
    return null;
  }
}

// ---- collision check --------------------------------------------------------
function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function tailLines(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-TAIL_LINES);
  } catch {
    return [];
  }
}

function collisionContext(slug, rel, now) {
  const found = new Map(); // other slug -> { minAgo, worktree, ts }
  for (const day of [dayStamp(now), dayStamp(now - 86400000)]) {
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
      for (const line of tailLines(path.join(dir, f))) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event !== 'edit' || ev.file !== rel) continue;
        const ts = Date.parse(ev.ts);
        if (!Number.isFinite(ts) || now - ts > COLLISION_WINDOW_MS || ts > now + 60000) continue;
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
    return `zippermerge: full-test-suite is held by ${owner} since ${field('since') || '?'} (${field('why') || 'no reason given'}). Wait, or run a targeted subset. Protocol: C:\\zippermerge\\CLAUDE.md trigger 6.`;
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
    || inferSlug(worktree)
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
