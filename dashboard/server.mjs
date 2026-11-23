// Read-only live dashboard for the zippermerge folder. Built-ins only.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_ROOT, HUMAN, MIG_DIR, PR_REPO, REPO } from '../bin/config.mjs';
import { openPullRequestPages } from '../bin/github-pr-pages.mjs';
import { ciBlocker, summarizeCi } from '../bin/pr-ci.mjs';
import { holdFor } from '../bin/pr-holds.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(CHAT_ROOT);
// Random per-process token embedded in served HTML; required by POST /api/post. Never logged.
const WRITE_TOKEN = randomBytes(32).toString('hex');
const TOKEN_PLACEHOLDER = '__ZM_TOKEN__';
const portArgIdx = process.argv.indexOf('--port');
const portArg = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : NaN;
const PORT = (Number.isInteger(portArg) && portArg > 0 && portArg < 65536 ? portArg : 0) || Number(process.env.PORT) || 4747;
// Last good board snapshot for instant cold starts. BOARD_CACHE_FILE overrides the path (testing).
const BOARD_CACHE_FILE = process.env.BOARD_CACHE_FILE ? path.resolve(process.env.BOARD_CACHE_FILE) : path.join(ROOT, 'state', 'board-cache.json');
const BOARD_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const BOARD_CACHE_WRITE_EVERY_MS = 60 * 1000;
const HOST = '127.0.0.1';
const FILE_RE = /\.(ts|tsx|mjs|js|json|md|sql)$/i;

async function listMd(dir) {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    return names.filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

async function readFileInfo(file) {
  const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  return { text: text.replace(/\r\n/g, '\n'), mtime: st.mtime.toISOString() };
}

function parseKeyValues(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_ ./-]+?):\s?(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function parseStatus(text) {
  const lines = text.split('\n');
  const result = { title: '', updated: '', state: '', fields: {}, order: [] };
  const first = lines[0] || '';
  const h = /^#\s*(\S+)(?:\s*\(([^)]*)\))?\s*(.*)$/.exec(first);
  if (h) {
    result.headSlug = h[1];
    result.title = h[2] || '';
    const rest = h[3] || '';
    const u = /updated:\s*(\S+)/.exec(rest);
    const s = /state:\s*(\S+)/.exec(rest);
    if (u) result.updated = u[1];
    if (s) result.state = s[1].toLowerCase();
  }
  let cur = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && cur) {
      cur.items.push(item[1]);
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9 /_-]*?):\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].trim();
      if (!result.fields[key]) {
        result.fields[key] = { value: kv[2].trim(), items: [] };
        result.order.push(key);
      } else {
        result.fields[key].value += (result.fields[key].value ? ' ' : '') + kv[2].trim();
      }
      cur = result.fields[key];
    } else if (cur) {
      cur.items.push(line.trim());
    }
  }
  return result;
}

function extractPaths(line) {
  const found = [];
  for (let tok of line.split(/[\s,;`]+/)) {
    tok = tok.replace(/^[("'[{]+/, '').replace(/["'\]}.:]+$/, '');
    while (tok.endsWith(')') && (tok.match(/\(/g) || []).length < (tok.match(/\)/g) || []).length) tok = tok.slice(0, -1);
    if (!tok || /^https?:/i.test(tok)) continue;
    const base = tok.split(/[\\/]/).filter(Boolean).pop() || '';
    if (!base.includes('.')) continue;
    if (FILE_RE.test(tok) || tok.includes('/')) found.push(base);
  }
  return found;
}

function hotFileOverlaps(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const f = s.fields && s.fields['Hot files'];
    if (!f) continue;
    const lines = [f.value, ...f.items].filter(Boolean);
    for (const line of lines) {
      for (const base of new Set(extractPaths(line))) {
        if (!map.has(base)) map.set(base, new Map());
        const per = map.get(base);
        if (!per.has(s.slug)) per.set(s.slug, []);
        per.get(s.slug).push(line);
      }
    }
  }
  // Second pass: a session that names a file without its extension ("join-scaffold snapshots")
  // still overlaps. Only distinctive stems (a dash, or 8+ chars) to avoid matching ordinary words.
  const hotLines = new Map();
  for (const s of sessions) {
    const f = s.fields && s.fields['Hot files'];
    if (f) hotLines.set(s.slug, [f.value, ...f.items].filter(Boolean));
  }
  for (const [file, per] of map) {
    const stem = file.replace(/\.[^.]+$/, '');
    if (!(stem.includes('-') || stem.length >= 8)) continue;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`, 'i');
    for (const [slug, lines] of hotLines) {
      if (per.has(slug)) continue;
      const hits = lines.filter((l) => word.test(l));
      if (hits.length) per.set(slug, hits.map((l) => `${l}  [matched by name: ${stem}]`));
    }
  }
  const out = [];
  for (const [file, per] of map) {
    if (per.size >= 2) {
      out.push({ file, sessions: [...per].map(([slug, lines]) => ({ slug, lines })) });
    }
  }
  return out.sort((a, b) => b.sessions.length - a.sessions.length || a.file.localeCompare(b.file));
}

async function buildSessions() {
  const dir = path.join(ROOT, 'status');
  const out = [];
  for (const name of await listMd(dir)) {
    const slug = name.replace(/\.md$/, '');
    try {
      const { text, mtime } = await readFileInfo(path.join(dir, name));
      let parsed;
      try { parsed = parseStatus(text); } catch { parsed = { fields: {}, order: [], title: '', updated: '', state: '' }; }
      out.push({ slug, file: name, mtime, raw: text, ...parsed });
    } catch (e) {
      out.push({ slug, file: name, mtime: null, raw: '', fields: {}, order: [], title: '', updated: '', state: '', error: String(e.message) });
    }
  }
  return out;
}

async function buildKv(dirName, prefix) {
  const dir = path.join(ROOT, dirName);
  const out = [];
  for (const name of await listMd(dir)) {
    if (prefix && !name.startsWith(prefix)) continue;
    try {
      const { text, mtime } = await readFileInfo(path.join(dir, name));
      out.push({ file: name, mtime, ...parseKeyValues(text), raw: text });
    } catch { /* skip unreadable */ }
  }
  return out;
}

async function buildLog(nowMs) {
  const dir = path.join(ROOT, 'log');
  const names = (await listMd(dir)).reverse();
  // Keep the usual recent feed and the Timeline's three-hour history with a margin for polling.
  const cutoff = nowMs - 4 * 60 * MIN;
  const log = [];
  for (const [i, name] of names.entries()) {
    const inFeed = i < 60;
    const entry = parseLogName(name);
    if (!inFeed && entry && !(entry.ms >= cutoff)) continue;
    try {
      const { text } = await readFileInfo(path.join(dir, name));
      const idx = text.indexOf('\n\n');
      const head = idx >= 0 ? text.slice(0, idx) : text;
      const body = idx >= 0 ? text.slice(idx + 2).trim() : '';
      const headers = parseKeyValues(head);
      const ts = entry ? entry.iso : headers.at || null;
      if (!inFeed && !entry && !(Date.parse(ts) >= cutoff)) continue;
      log.push({
        name,
        timestamp: ts,
        slug: entry ? entry.slug : headers.from || '',
        kind: headers.kind || (entry ? entry.kind : ''),
        re: headers.re || null,
        headers,
        body,
      });
    } catch { /* skip */ }
  }
  return { log, logTotal: names.length };
}

// ---------------------------------------------------------------------------
// v2: computed fields (hb, attention, migrations, timeline, worktrees, logStats, caches)
// ---------------------------------------------------------------------------
const MAIN_REPO = REPO || process.cwd();
const MIG_RE = /^(\d{3})_(.+)\.sql$/;
const LOG_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_([^_]+)_(.+)\.md$/;
const MIN = 60000;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

function gitRun(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', ...(cwd ? ['-C', cwd] : []), ...args],
      { timeout: 5000, env: GIT_ENV, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = undefined; }
    }
  });
  await Promise.all(workers);
  return out;
}

// Background-refreshed cache. get() only awaits when there is no data at all.
function makeCache(refreshFn, everyMs) {
  const st = { data: null, at: 0, inflight: null };
  const run = () => {
    if (st.inflight) return st.inflight;
    st.inflight = (async () => {
      try { st.data = await refreshFn(st.data); st.at = Date.now(); } catch { /* keep last */ }
      finally { st.inflight = null; }
    })();
    return st.inflight;
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  return {
    kick: run,
    wait: () => st.inflight || Promise.resolve(),
    // Never waits: returns whatever is cached (possibly null) and kicks a refresh when stale.
    peek() {
      if (!st.data || Date.now() - st.at > everyMs) run();
      return { data: st.data, at: st.at };
    },
    async get() {
      if (!st.data) await run();
      else if (Date.now() - st.at > everyMs) run();
      return { data: st.data, at: st.at };
    },
  };
}

async function listWorktrees() {
  const out = await gitRun(MAIN_REPO, ['worktree', 'list', '--porcelain']);
  const items = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) items.push({ path: line.slice(9).trim(), branch: null });
    else if (line.startsWith('branch ') && items.length) items[items.length - 1].branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  return items;
}

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// Roster heartbeat minutes from CLAUDE.md (cached by mtime).
let rosterCache = { mtime: 0, map: new Map() };
async function getRoster() {
  try {
    const file = path.join(ROOT, 'CLAUDE.md');
    const st = await stat(file);
    if (st.mtimeMs === rosterCache.mtime) return rosterCache.map;
    const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    const map = new Map();
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 2) continue;
      const m = /^`([a-z0-9-]+)`$/.exec(cells[0]);
      if (!m) continue;
      const last = cells[cells.length - 1];
      const nums = /^\d{1,2}(\s*,\s*\d{1,2})*$/.test(last) ? last.split(',').map((x) => Number(x.trim())).sort((a, b) => a - b) : null;
      map.set(m[1], nums);
    }
    rosterCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    return rosterCache.map;
  }
}

function parseLogName(name) {
  const m = LOG_NAME_RE.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return { name, iso, ms: Date.parse(iso), slug: m[7], kind: m[8].replace(/-\d+$/, '') };
}

async function logIndex() {
  const names = await listMd(path.join(ROOT, 'log'));
  return names.map(parseLogName).filter(Boolean); // names sort chronologically
}

const BIN_MINUTES = 10;
const BIN_COUNT = 18;

function computeLogStats(idx, nowMs) {
  const perSession = {};
  const lastByKind = {};
  let total24h = 0;
  for (const e of idx) {
    const s = (perSession[e.slug] ||= { h1: 0, h24: 0, last: null, lastKind: null, bins: new Array(BIN_COUNT).fill(0) });
    const age = nowMs - e.ms;
    if (age < BIN_COUNT * BIN_MINUTES * MIN) s.bins[BIN_COUNT - 1 - Math.min(BIN_COUNT - 1, Math.floor(Math.max(0, age) / (BIN_MINUTES * MIN)))]++;
    if (age <= 60 * MIN) s.h1++;
    if (age <= 24 * 60 * MIN) { s.h24++; total24h++; }
    s.last = e.iso; s.lastKind = e.kind; // idx ascending, so the final write is the newest
    lastByKind[e.kind] = { slug: e.slug, at: e.iso, name: e.name };
  }
  return { binMinutes: BIN_MINUTES, perSession, lastByKind, total24h };
}

function computeHb(session, roster, idx, nowMs) {
  const minutes = roster.get(session.slug) || null;
  let lastPostAt = null;
  for (let i = idx.length - 1; i >= 0; i--) if (idx[i].slug === session.slug) { lastPostAt = idx[i].iso; break; }
  const statusMs = session.mtime ? Date.parse(session.mtime) : NaN;
  const postMs = lastPostAt ? Date.parse(lastPostAt) : NaN;
  const statusAgeMin = Number.isFinite(statusMs) ? Math.max(0, Math.round((nowMs - statusMs) / MIN)) : null;
  const lastPostAgeMin = Number.isFinite(postMs) ? Math.max(0, Math.round((nowMs - postMs) / MIN)) : null;
  let nextAt = null; let nextInMin = null;
  if (minutes && minutes.length) {
    const d = new Date(nowMs); d.setUTCSeconds(0, 0);
    for (let k = 1; k <= 61; k++) {
      const t = new Date(d.getTime() + k * MIN);
      if (minutes.includes(t.getUTCMinutes())) { nextAt = t.toISOString(); nextInMin = Math.round((t.getTime() - nowMs) / MIN); break; }
    }
  }
  // No heartbeat expected (none configured, or the session is idle or done): nothing to warn about, so 'ok'.
  // Views compare against 'ok', so anything else would read as stale. `expected` says whether it was checked.
  let health = 'ok';
  const expected = Boolean(minutes && minutes.length && session.state !== 'idle' && session.state !== 'done');
  if (expected) {
    const recent = Math.max(Number.isFinite(statusMs) ? statusMs : 0, Number.isFinite(postMs) ? postMs : 0);
    const ageMin = (nowMs - recent) / MIN;
    health = !recent || ageMin > 45 ? 'silent' : ageMin > 25 ? 'late' : 'ok';
  }
  return { minutes, nextAt, nextInMin, lastPostAt, lastPostAgeMin, statusAgeMin, health, expected };
}

// Log bodies are immutable, so cache them by name.
const logBodyCache = new Map();
async function logBody(name) {
  if (logBodyCache.has(name)) return logBodyCache.get(name);
  let v = { kind: '', body: '', re: null, from: '' };
  try {
    const { text } = await readFileInfo(path.join(ROOT, 'log', name));
    const i = text.indexOf('\n\n');
    const head = parseKeyValues(i >= 0 ? text.slice(0, i) : text);
    v = { kind: head.kind || '', body: i >= 0 ? text.slice(i + 2) : '', re: head.re || null, from: (head.from || '').toLowerCase() };
  } catch { /* leave empty */ }
  logBodyCache.set(name, v);
  return v;
}

// Shorten display text at a word boundary and mark the cut, so a clipped line never ends mid-word.
function clipText(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// Canonical asks list. Single source for the asks view and the attention ask items.
// Asks with no resolvable @target are skipped (one ask per target).
async function computeAskList(idx, sessions, nowMs) {
  const slugs = new Set(sessions.map((s) => s.slug));
  const statusMs = new Map(sessions.map((s) => [s.slug, s.mtime ? Date.parse(s.mtime) : 0]));
  const postsBy = new Map(); // slug -> ascending post times (idx is chronological)
  for (const e of idx) (postsBy.get(e.slug) || postsBy.set(e.slug, []).get(e.slug)).push(e.ms);
  const answerOf = (target, atMs) => {
    let best = null;
    for (const ms of postsBy.get(target) || []) if (ms > atMs) { best = ms; break; }
    const sm = statusMs.get(target) || 0;
    if (sm > atMs && (best === null || sm < best)) best = sm;
    return best;
  };
  const targetsOf = (text, from) => {
    const out = new Set();
    for (const m of text.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) {
      const t = m[1].toLowerCase();
      if ((slugs.has(t) || t === HUMAN) && t !== from) out.add(t);
    }
    return out;
  };
  // Explicit replies: log entries with "re: <log-file-name>", keyed by the referenced file.
  const replies = new Map(); // ref -> [{ from, ms, name, text }] ascending
  for (const e of idx.slice(-300)) {
    const lb = await logBody(e.name);
    if (!lb.re) continue;
    const arr = replies.get(lb.re) || replies.set(lb.re, []).get(lb.re);
    arr.push({ from: lb.from || e.slug.toLowerCase(), ms: e.ms, name: e.name, text: lb.body.trim().slice(0, 300) });
  }
  const asks = [];
  const meta = new Map(); // ask id -> { kind }
  const seen = new Set();
  const push = (id, from, to, text, atMs, ref, source, kind) => {
    const key = `${from}|${to}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rep = source === 'log' ? (replies.get(ref) || []).find((r) => r.ms >= atMs && (r.from === to || r.from === HUMAN)) : null;
    const ansMs = rep ? rep.ms : answerOf(to, atMs);
    asks.push({
      id, from, to, text, at: new Date(atMs).toISOString(), ref,
      answered: ansMs !== null, answeredAt: ansMs !== null ? new Date(ansMs).toISOString() : null,
      answeredBy: rep ? rep.from : ansMs !== null ? to : null,
      answeredVia: rep ? 'reply' : ansMs !== null ? 'heuristic' : null,
      replyText: rep ? rep.text : null,
      replyRef: rep ? rep.name : null,
      ageMin: Math.max(0, Math.round((nowMs - atMs) / MIN)), source,
    });
    meta.set(id, { kind });
  };
  for (const e of idx.slice(-300)) {
    const { kind, body } = await logBody(e.name);
    const targets = targetsOf(body, e.slug);
    const text = clipText(body.trim().split('\n')[0], 160);
    for (const t of targets) push(`${e.name}>${t}`, e.slug, t, text, e.ms, e.name, 'log', kind || e.kind);
  }
  for (const s of sessions) {
    const f = s.fields && s.fields.Asks;
    const atMs = s.mtime ? Date.parse(s.mtime) : NaN;
    if (!f || !Number.isFinite(atMs)) continue;
    const text = [f.value, ...f.items].filter(Boolean).join(' ').trim();
    if (!text || /^none\b/i.test(text)) continue;
    for (const t of targetsOf(text, s.slug)) push(`status:${s.slug}>${t}`, s.slug, t, clipText(text, 160), atMs, s.file, 'status', 'status');
  }
  asks.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { asks, meta };
}

function asksToAttention(asks, meta) {
  const out = [];
  for (const a of asks) {
    if (a.answered) continue;
    let sev;
    if (a.to === HUMAN) {
      if (a.ageMin > 24 * 60) continue;
      sev = 'red';
    } else {
      sev = a.ageMin >= 60 ? 'red' : a.ageMin >= 20 ? 'amber' : 'info';
    }
    const kind = (meta.get(a.id) || {}).kind || 'ask';
    out.push({ sev, kind: 'ask', slug: a.to, text: `@${a.to} unanswered (${kind} from ${a.from}): ${a.text}`, since: a.at, ageMin: a.ageMin, ref: a.ref });
  }
  return out;
}

function lockExpectedMin(why) {
  let best = 0;
  for (const m of String(why || '').matchAll(/~?(\d+)(?:-(\d+))?\s*min/gi)) {
    best = Math.max(best, Number(m[1]), m[2] ? Number(m[2]) : 0);
  }
  return best || 45;
}

function lockInfo(l, nowMs) {
  const sinceMs = Number(l.since_epoch) * 1000;
  if (!Number.isFinite(sinceMs) || !sinceMs) return null;
  const ageMin = (nowMs - sinceMs) / MIN;
  return { sinceMs, ageMin, exp: lockExpectedMin(l.why), name: l.lock || String(l.file || '').replace(/\.md$/, ''), owner: l.owner || '?' };
}

function computeLockAttention(locks, nowMs) {
  const out = [];
  for (const l of locks) {
    const i = lockInfo(l, nowMs);
    if (!i) continue;
    const since = new Date(i.sinceMs).toISOString();
    const age = Math.round(i.ageMin);
    if (i.name === 'main-freeze') {
      out.push({ sev: 'red', kind: 'freeze', slug: i.owner, text: `main-freeze held by ${i.owner} for ${age} min`, since, ageMin: age, ref: l.file || null });
    }
    if (i.ageMin > 60) {
      out.push({ sev: 'red', kind: 'lock-overrun', slug: i.owner, text: `${i.name} held by ${i.owner} for ${age} min (expected ~${i.exp}): breakable per protocol`, since, ageMin: age, ref: l.file || null });
    } else if (i.ageMin > i.exp) {
      out.push({ sev: 'amber', kind: 'lock-overrun', slug: i.owner, text: `${i.name} held by ${i.owner} for ${age} min, over expected ~${i.exp} min`, since, ageMin: age, ref: l.file || null });
    }
  }
  return out;
}

function computeTimeline(sessions, locks, nowMs) {
  const timed = []; const untimed = [];
  const dayMs = 24 * 60 * MIN;
  for (const s of sessions) {
    const f = s.fields && s.fields['Next risky action'];
    if (!f) continue;
    // Resolve the time of day relative to the status update so its date stays fixed as time passes.
    let statusAt = Date.parse(s.updated);
    if (!Number.isFinite(statusAt)) statusAt = Date.parse(s.mtime);
    if (!Number.isFinite(statusAt)) statusAt = nowMs;
    for (const text of [f.value, ...f.items].filter(Boolean)) {
      if (/^\s*none\b/i.test(text)) continue;
      const m = /~?(\d{1,2}):(\d{2})Z/.exec(text);
      let atMs = null;
      if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
        atMs = new Date(statusAt).setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
        if (atMs - statusAt > dayMs / 2) atMs -= dayMs;
        else if (statusAt - atMs > dayMs / 2) atMs += dayMs;
      }
      if (atMs === null) { untimed.push({ slug: s.slug, text, atUtc: null, inMin: null, overdue: false, source: 'risky' }); continue; }
      const inMin = Math.round((atMs - nowMs) / MIN);
      timed.push({ slug: s.slug, text, atUtc: new Date(atMs).toISOString(), inMin, overdue: atMs < nowMs, source: 'risky' });
    }
  }
  for (const l of locks) {
    const i = lockInfo(l, nowMs);
    if (!i) continue;
    const endMs = i.sinceMs + i.exp * MIN;
    const inMin = Math.round((endMs - nowMs) / MIN);
    timed.push({ slug: i.owner, text: `${i.name} expected to finish (since + ~${i.exp} min)`, atUtc: new Date(endMs).toISOString(), inMin, overdue: inMin < 0, source: 'lock' });
  }
  timed.sort((a, b) => Date.parse(a.atUtc) - Date.parse(b.atUtc));
  return [...timed, ...untimed];
}

function inferOwner(folder, sessions) {
  const esc = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`);
  const hits = new Set();
  for (const s of sessions) {
    const f = s.fields && s.fields['Worktrees/branches'];
    if (!f) continue;
    if ([f.value, ...f.items].some((l) => re.test(l))) hits.add(s.slug);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

// ---- migrations (cached, background refresh) ----
async function refreshMigrations() {
  const ranMs = Date.now();
  const res = { mainMax: null, mainFetchedAt: null, ranAt: new Date(ranMs).toISOString(), raw: { mainSet: new Set(), wt: [], allNums: new Set() }, error: null };
  const errs = [];
  try { res.mainFetchedAt = (await stat(path.join(MAIN_REPO, '.git', 'FETCH_HEAD'))).mtime.toISOString(); } catch { /* none */ }
  const mainNames = [];
  try {
    const out = await gitRun(MAIN_REPO, ['ls-tree', '--name-only', 'origin/main', MIG_DIR + '/']);
    for (const p of out.split(/\r?\n/)) {
      const b = p.trim().split('/').pop();
      const m = MIG_RE.exec(b || '');
      if (m) { mainNames.push(b); res.raw.mainSet.add(b); res.raw.allNums.add(Number(m[1])); }
    }
    res.mainMax = mainNames.length ? Math.max(...mainNames.map((n) => Number(MIG_RE.exec(n)[1]))) : null;
  } catch (e) { errs.push(`ls-tree: ${e.message.split('\n')[0]}`); }
  try {
    const wts = await listWorktrees();
    for (const w of wts) {
      const folder = baseName(w.path);
      try {
        const names = await readdir(path.join(w.path, ...MIG_DIR.split('/')));
        for (const n of names) {
          const m = MIG_RE.exec(n);
          if (!m) continue;
          res.raw.allNums.add(Number(m[1]));
          if (!res.raw.mainSet.has(n)) res.raw.wt.push({ n: Number(m[1]), name: n, folder });
        }
      } catch { /* worktree without migrations dir */ }
    }
  } catch (e) { errs.push(`worktree list: ${e.message.split('\n')[0]}`); }
  if (errs.length) res.error = errs.join('; ');
  return res;
}

function buildMigrations(raw, at, sessions, claims, nowMs) {
  const base = { mainMax: null, mainFetchedAt: null, ranAt: new Date(nowMs).toISOString(), ageSec: 0, files: [], problems: [], error: 'migration scan not ready' };
  if (!raw) return { migrations: base, allNums: new Set() };
  const mainMax = raw.mainMax;
  const claimByN = new Map();
  for (const c of claims) {
    const n = Number(c.number);
    if (Number.isFinite(n)) claimByN.set(n, c);
  }
  const byKey = new Map(); // "n|name" -> file
  const add = (n, name, where, onMain) => {
    const k = `${n}|${name}`;
    if (!byKey.has(k)) byKey.set(k, { n, name, where: [], onMain });
    const f = byKey.get(k);
    if (!f.where.includes(where)) f.where.push(where);
  };
  for (const name of raw.raw.mainSet) {
    const n = Number(MIG_RE.exec(name)[1]);
    if (mainMax === null || n > mainMax - 3) add(n, name, 'main', true);
  }
  for (const w of raw.raw.wt) add(w.n, w.name, w.folder, false);
  const files = [...byKey.values()].map((f) => {
    const c = claimByN.get(f.n);
    return { ...f, claimOwner: c ? c.owner || null : null, claimName: c ? c.name || null : null };
  }).sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));

  const problems = [];
  // Red: same number, different names (main set is complete; worktree files are non-main only).
  const namesByN = new Map();
  for (const name of raw.raw.mainSet) { const n = Number(MIG_RE.exec(name)[1]); (namesByN.get(n) || namesByN.set(n, new Set()).get(n)).add(name); }
  for (const w of raw.raw.wt) (namesByN.get(w.n) || namesByN.set(w.n, new Set()).get(w.n)).add(w.name);
  for (const [n, names] of namesByN) {
    if (names.size > 1) {
      const where = files.filter((f) => f.n === n).map((f) => `${f.name} [${f.where.join(', ')}]`).join(' vs ');
      problems.push({ sev: 'red', n, text: `Number ${n} used by different files: ${where || [...names].join(' vs ')}` });
    }
  }
  for (const w of raw.raw.wt) {
    if (mainMax !== null && w.n <= mainMax) {
      problems.push({ sev: 'red', n: w.n, text: `${w.name} in ${w.folder} is at or below origin/main's highest migration (${mainMax}): renumber upward` });
    }
  }
  const seen = new Set();
  for (const w of raw.raw.wt) {
    const key = `${w.n}|${w.name}`;
    const c = claimByN.get(w.n);
    if (mainMax !== null && w.n > mainMax && !c && !seen.has('u' + key)) {
      seen.add('u' + key);
      problems.push({ sev: 'amber', n: w.n, text: `${w.name} in ${w.folder} has no claim for number ${w.n}` });
    }
    if (c) {
      const wtOwner = inferOwner(w.folder, sessions);
      if (wtOwner && c.owner && wtOwner !== c.owner) {
        problems.push({ sev: 'amber', n: w.n, text: `${w.name}: claim owner ${c.owner} differs from owner of worktree ${w.folder} (${wtOwner})` });
      }
      const fileBase = w.name.replace(MIG_RE, '$2');
      if (c.name && c.name !== fileBase) {
        problems.push({ sev: 'info', n: w.n, text: `${w.name}: claim name "${c.name}" differs from file name "${fileBase}"` });
      }
    }
  }
  const ageSec = Math.max(0, Math.round((nowMs - at) / 1000));
  return {
    migrations: { mainMax, mainFetchedAt: raw.mainFetchedAt, ranAt: raw.ranAt, ageSec, files, problems, error: raw.error },
    allNums: raw.raw.allNums,
  };
}

function computeOrphans(claims, allNums, sessions, nowMs, migReady) {
  if (!migReady) return [];
  const out = [];
  for (const c of claims) {
    const n = Number(c.number);
    if (!Number.isFinite(n) || allNums.has(n)) continue;
    const claimedMs = Date.parse(c.claimed || c.mtime || '');
    const ageMin = Number.isFinite(claimedMs) ? Math.round((nowMs - claimedMs) / MIN) : null;
    const owner = sessions.find((s) => s.slug === c.owner);
    const unused = owner && new RegExp(`${c.number}[^\\n]{0,100}UNUSED`, 'i').test(owner.raw || '');
    const sev = ageMin !== null && ageMin > 120 && !unused ? 'amber' : 'info';
    out.push({
      sev, kind: 'orphan-claim', slug: c.owner || null,
      text: `Claim ${c.number} (${c.name || '?'}) has no migration file in any worktree or main${unused ? ' (owner marked UNUSED)' : ''}`,
      since: Number.isFinite(claimedMs) ? new Date(claimedMs).toISOString() : null, ageMin, ref: c.file || null,
    });
  }
  return out;
}

// ---- worktrees (cached, background refresh, max 3 concurrent git runs) ----
async function inspectWorktree(w, prev) {
  const item = { path: w.path, name: baseName(w.path), branch: w.branch, ahead: null, behind: null, dirty: null, lastCommitAgeMin: null, lastSubject: null, op: null, owner: null };
  if (prev) Object.assign(item, { ahead: prev.ahead, behind: prev.behind, dirty: prev.dirty, lastCommitAgeMin: prev.lastCommitAgeMin, lastSubject: prev.lastSubject, branch: prev.branch ?? w.branch });
  let gitDir = null;
  try {
    const out = (await gitRun(w.path, ['rev-parse', '--git-dir'])).trim();
    gitDir = path.resolve(w.path, out);
  } catch { return item; }
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))) { item.op = 'rebase'; return item; }
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) { item.op = 'merge'; return item; }
  try {
    const out = await gitRun(w.path, ['status', '--porcelain=v1', '-b']);
    const lines = out.split(/\r?\n/).filter(Boolean);
    const head = lines.find((l) => l.startsWith('## ')) || '';
    const br = head.slice(3).replace(/\.\.\..*$/, '').replace(/^No commits yet on /, '').replace(/ \[.*\]$/, '');
    if (br) item.branch = br;
    item.dirty = lines.filter((l) => !l.startsWith('## ')).length;
  } catch { /* keep prev */ }
  try {
    const [l, r] = (await gitRun(w.path, ['rev-list', '--left-right', '--count', 'origin/main...HEAD'])).trim().split(/\s+/).map(Number);
    if (Number.isFinite(l) && Number.isFinite(r)) { item.behind = l; item.ahead = r; }
  } catch { /* keep prev */ }
  try {
    const [ct, , ...subj] = (await gitRun(w.path, ['log', '-1', '--format=%ct%x09%h%x09%s'])).trim().split('\t');
    const ms = Number(ct) * 1000;
    if (Number.isFinite(ms) && ms > 0) item.lastCommitAgeMin = Math.max(0, Math.round((Date.now() - ms) / MIN));
    item.lastSubject = subj.join('\t') || null;
  } catch { /* keep prev */ }
  return item;
}

async function refreshWorktrees(prevData) {
  const ranAt = new Date().toISOString();
  let mainFetchedAt = null;
  try { mainFetchedAt = (await stat(path.join(MAIN_REPO, '.git', 'FETCH_HEAD'))).mtime.toISOString(); } catch { /* none */ }
  let wts;
  try { wts = await listWorktrees(); } catch (e) {
    return { ranAt, mainFetchedAt, items: prevData ? prevData.items : [], error: `worktree list: ${e.message.split('\n')[0]}` };
  }
  const prevByPath = new Map((prevData ? prevData.items : []).map((i) => [i.path, i]));
  const items = await pooled(wts, 3, (w) => inspectWorktree(w, prevByPath.get(w.path)));
  return { ranAt, mainFetchedAt, items: items.filter(Boolean), error: null };
}

// ---- open PRs (GraphQL inventory, REST CI, background refresh with backoff) ----
const PR_EVERY_MS = 5 * MIN;
const PR_BACKOFF_MS = 15 * MIN;
const RATE_RE = /rate limit|\b(?:403|429)\b|secondary|abuse/i;
const prState = { fetchedAt: null, at: 0, error: null, rateLimited: false, items: [], inflight: false };

function ghApi(endpoint) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', endpoint],
      { timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || err).trim().split('\n').slice(0, 3).join(' ').slice(0, 300)));
        resolve(stdout);
      });
  });
}

async function listOpenPrs() {
  const prs = [];
  const fields = 'title url isDraft headRefName baseRefName author { login } updatedAt headRefOid';
  for await (const page of openPullRequestPages(PR_REPO, fields)) {
    for (const p of page) prs.push({
      number: p.number, title: p.title, url: p.url, draft: Boolean(p.isDraft),
      headRef: p.headRefName, baseRef: p.baseRefName,
      author: p.author?.login || null, updatedAt: p.updatedAt, sha: p.headRefOid,
    });
  }
  return prs.reverse(); // The dashboard lists newest first.
}

async function fetchCheckRuns(sha) {
  const pageSize = 100;
  const runs = [];
  const ids = new Set();
  let expected;
  for (let page = 1; ; page++) {
    const { total_count: total, check_runs: items } = JSON.parse(await ghApi(`repos/${PR_REPO}/commits/${sha}/check-runs?per_page=${pageSize}&page=${page}`));
    expected ??= total;
    if (!Number.isSafeInteger(total) || total < 0 || total !== expected
      || !Array.isArray(items) || items.length !== Math.min(pageSize, total - runs.length)) {
      throw new Error(`incomplete check runs for ${sha}`);
    }
    for (const run of items) {
      if (!Number.isSafeInteger(run?.id) || ids.has(run.id)) throw new Error(`incomplete check runs for ${sha}`);
      ids.add(run.id);
      runs.push(run);
    }
    if (runs.length === total) return runs;
  }
}

async function fetchCommitStatus(sha) {
  // The combined state includes every context. Only fetch one status detail.
  const { state, total_count: total } = JSON.parse(await ghApi(`repos/${PR_REPO}/commits/${sha}/status?per_page=1`));
  if (total === 0 && state === 'pending') return 'none';
  if (Number.isSafeInteger(total) && total > 0 && ['success', 'pending', 'failure'].includes(state)) return state;
  throw new Error(`invalid combined commit status for ${sha}`);
}

async function refreshPrs() {
  if (!PR_REPO || prState.inflight) return;
  prState.inflight = true;
  let errMsg = null;
  let rateLimited = false;
  const incomplete = (err) => {
    const message = String((err && err.message) || err);
    errMsg ||= message;
    rateLimited ||= RATE_RE.test(message);
    return null;
  };
  try {
    const base = await listOpenPrs();
    const items = await pooled(base, 4, async (pr) => {
      if (!pr.sha) return { ...pr, checks: summarizeCi([]) };
      const runs = await fetchCheckRuns(pr.sha).catch(incomplete);
      const status = await fetchCommitStatus(pr.sha).catch(incomplete);
      return { ...pr, checks: summarizeCi(runs, status ?? 'unknown') };
    });
    prState.items = items.filter(Boolean);
    prState.fetchedAt = new Date().toISOString();
    prState.at = Date.now();
  } catch (e) {
    incomplete(e);
  }
  prState.error = errMsg;
  prState.rateLimited = rateLimited;
  prState.inflight = false;
  schedulePrs(errMsg ? PR_BACKOFF_MS : PR_EVERY_MS);
}

function schedulePrs(delay) {
  const t = setTimeout(() => { refreshPrs().catch(() => {}); }, delay);
  t.unref();
}
schedulePrs(3000);

function prOwner(pr, wtItems, sessions) {
  const w = wtItems.find((i) => i.branch && i.branch === pr.headRef && i.owner);
  if (w) return w.owner;
  const re = new RegExp(`#${pr.number}(?!\\d)`);
  for (const s of sessions) {
    const f = s.fields || {};
    const hit = Object.values(f).some((v) => v && [v.value, ...(v.items || [])].some((l) => l && re.test(l)));
    if (hit) return s.slug;
  }
  return null;
}

function buildPrs(sessions, wtItems, nowMs) {
  return {
    fetchedAt: prState.fetchedAt,
    ageSec: prState.fetchedAt ? Math.max(0, Math.round((nowMs - prState.at) / 1000)) : null,
    error: prState.error,
    rateLimited: prState.rateLimited,
    items: prState.items.map((p) => ({ ...p, owner: prOwner(p, wtItems, sessions) })),
  };
}

const CI_RANK = { success: 0, pending: 1, none: 1, failure: 3 };
function landingRank(s) {
  if (s.prState === 'none') return 5;
  if (s.prState === 'draft') return 4;
  return CI_RANK[s.ci] ?? 1;
}

function rankSessions(slugs, lineFor, prs) {
  return slugs.map((slug) => {
    const mine = prs.items.filter((p) => p.owner === slug).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const p = mine[0] || null;
    return {
      slug, line: lineFor(slug), pr: p ? p.number : null,
      prState: p ? (p.draft ? 'draft' : 'ready') : 'none', ci: p ? p.checks.conclusion : 'none',
    };
  }).sort((a, b) => landingRank(a) - landingRank(b));
}

function landingSuggestion(sessions, file) {
  const top = sessions[0]; const next = sessions[1];
  const first = top && next && top.prState === 'ready' && top.ci === 'success' && landingRank(top) < landingRank(next) ? top.slug : null;
  let suggestion;
  if (first) {
    const others = sessions.filter((s) => s.slug !== first).map((s) => s.slug);
    suggestion = `${first}'s PR #${top.pr} is green and ready: land it first, then ${others.join(' and ')} ${others.length === 1 ? 'rebases' : 'rebase'} onto main and re-run the tests that touch ${file}.`;
  } else if (top && top.prState === 'ready' && top.ci === 'failure') {
    suggestion = `Fix failing CI on #${top.pr} before choosing a landing order.`;
  } else if (sessions.every((s) => s.prState === 'none')) {
    suggestion = sessions.length === 2
      ? 'No PR yet on either side: whoever opens a green PR first lands first; the other rebases.'
      : 'No PR yet from any of them: whoever opens a green PR first lands first; the rest rebase.';
  } else {
    suggestion = 'Agree landing order with an ask, or ask the owner. Land a PR once it is green and ready.';
  }
  return { first, suggestion };
}

const fileBase = path.posix.basename;
const sessionPairKey = (a, b) => JSON.stringify([a, b].sort());
const MERGE_TREE_ITEMS_MAX = 40;

function buildLandingOrder(overlaps, prs, conflicts) {
  const cf = conflicts || {};
  const cleanPairs = new Set(cf.cleanSessionPairs || []);
  const cross = (cf.pairs || []).filter((p) => p.kind === 'cross-session' && !p.error && !p.clean && !p.viaMain && p.a.owner && p.b.owner);
  const items = overlaps.map((o) => {
    const sessions = rankSessions(o.sessions.map((s) => s.slug), (slug) => {
      const s = o.sessions.find((x) => x.slug === slug);
      return (s && s.lines && s.lines[0]) || '';
    }, prs);
    const slugs = sessions.map((s) => s.slug);
    const want = o.file.toLowerCase();
    const confirmed = cross.some((p) => slugs.includes(p.a.owner) && slugs.includes(p.b.owner)
      && p.files.some((f) => fileBase(f).toLowerCase() === want));
    const testedClean = slugs.every((a, i) => slugs.slice(i + 1).every((b) => cleanPairs.has(sessionPairKey(a, b))));
    let { first, suggestion } = landingSuggestion(sessions, o.file);
    if (!confirmed) suggestion += testedClean ? ' (no textual conflict found by trial merge)' : ' (no clean trial merge result for this overlap)';
    return { file: o.file, sessions, first, suggestion, source: 'overlap', confirmed, trialRan: confirmed || testedClean };
  });
  // Cross-session trial-merge conflicts that no status-file overlap already explains.
  const extra = new Map();
  for (const p of cross) {
    for (const f of p.files) {
      const want = fileBase(f).toLowerCase();
      const covered = overlaps.some((o) => o.file.toLowerCase() === want
        && o.sessions.some((s) => s.slug === p.a.owner) && o.sessions.some((s) => s.slug === p.b.owner));
      if (covered) continue;
      if (!extra.has(f)) extra.set(f, new Map());
      const per = extra.get(f);
      if (!per.has(p.a.owner)) per.set(p.a.owner, `${p.a.branch} conflicts with ${p.b.owner}'s ${p.b.branch} in a trial merge`);
      if (!per.has(p.b.owner)) per.set(p.b.owner, `${p.b.branch} conflicts with ${p.a.owner}'s ${p.a.branch} in a trial merge`);
    }
  }
  for (const [file, per] of [...extra].slice(0, MERGE_TREE_ITEMS_MAX)) {
    const sessions = rankSessions([...per.keys()], (slug) => per.get(slug), prs);
    const { first, suggestion } = landingSuggestion(sessions, file);
    items.push({ file, sessions, first, suggestion, source: 'merge-tree', confirmed: true, trialRan: true });
  }
  // One item per stale branch (conflicts with main): rebasing it clears its inherited conflicts.
  for (const p of (cf.pairs || [])) {
    if (p.kind !== 'vs-main' || p.error || !p.a.owner || !p.files.length) continue;
    const shown = p.files.slice(0, 3).join(', ') + (p.files.length > 3 ? ` (+${p.files.length - 3} more)` : '');
    const sessions = rankSessions([p.a.owner], () => `${p.a.branch} conflicts with main`, prs);
    items.push({
      file: p.files[0], sessions, first: p.a.owner, source: 'needs-rebase', confirmed: true, trialRan: true,
      suggestion: `${p.a.owner}'s ${p.a.branch} conflicts with main in ${shown}: rebase it first; that clears ${p.blocks || 0} downstream conflicts.`,
    });
  }
  return items;
}

// ---- real merge-conflict detection: exact trial merges with `git merge-tree` ----
// MergeGym found 47.3% of conflicts between parallel PRs happen between PRs that share no files,
// because git merges both heads against their common base. So we trial-merge instead of guessing.
// `merge-tree --write-tree` writes only loose tree/blob objects to the shared object store. It writes
// no refs, no index and nothing in any worktree. We never run merge, checkout, rebase, fetch or gc.
const CONFLICT_MAX_PAIRS = 200;
const CONFLICT_TIMEOUT_MS = 10000;

function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)/.exec(String(text));
  return m ? { major: Number(m[1]), minor: Number(m[2]), full: String(text).trim().replace(/^git version /, '') } : null;
}

// exit 0 = clean, exit 1 = conflicts (NUL-separated tree OID and paths), else error.
function trialMerge(refA, refB) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', MAIN_REPO, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', refA, refB],
      { timeout: CONFLICT_TIMEOUT_MS, env: GIT_ENV, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ clean: true, files: [], error: null });
        if (err.code === 1) {
          const files = [...new Set(String(stdout).split('\0').slice(1).filter(Boolean))];
          return resolve({ clean: false, files, error: null });
        }
        const why = err.killed ? `timed out after ${CONFLICT_TIMEOUT_MS / 1000}s` : String(stderr || err.message || err).trim().split('\n')[0].slice(0, 200);
        resolve({ clean: false, files: [], error: why || `exit ${err.code}` });
      });
  });
}

async function refreshConflicts() {
  const res = { ranAt: null, gitVersion: null, error: null, pairsTested: 0, genuineCount: 0, viaMainCount: 0, pairs: [], cleanSessionPairs: [] };
  const finish = () => { res.ranAt = new Date().toISOString(); return res; };
  let ver;
  try { ver = parseGitVersion(await gitRun(null, ['version'])); } catch (e) {
    res.error = `git version: ${String(e.message).split('\n')[0]}`;
    return finish();
  }
  if (!ver) { res.error = 'could not parse git version'; return finish(); }
  res.gitVersion = ver.full;
  if (ver.major < 2 || (ver.major === 2 && ver.minor < 38)) {
    res.error = `git ${ver.full} is older than 2.38, so merge-tree --write-tree is unavailable: conflict check skipped`;
    return finish();
  }
  await wtCache.wait();
  const wt = (await wtCache.get()).data;
  if (!wt || !wt.items.length) { res.error = 'worktree scan not ready'; return finish(); }
  let sessions = [];
  try { sessions = await buildSessions(); } catch { /* owners stay unknown */ }
  const cands = wt.items
    .filter((i) => i.branch !== 'main')
    .map((i) => ({
      side: { worktree: i.name, branch: i.branch, owner: inferOwner(i.name, sessions) },
      testable: Boolean(i.branch && !i.op && !/^HEAD\b/.test(i.branch)),
    }))
    .filter((c) => c.side.owner);
  const tasks = [];
  // Count all owned worktree pairs, including in-progress operations, detached
  // worktrees and pairs beyond the scan limit. Only clean trials clear a count.
  const pendingByPair = new Map();
  for (const { side, testable } of cands) {
    if (testable) tasks.push({ kind: 'vs-main', a: side, b: { worktree: null, branch: 'origin/main', owner: null } });
  }
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const { side: a, testable: aTestable } = cands[i];
      const { side: b, testable: bTestable } = cands[j];
      if (a.owner === b.owner) continue;
      const key = sessionPairKey(a.owner, b.owner);
      pendingByPair.set(key, (pendingByPair.get(key) || 0) + 1);
      if (aTestable && bTestable) tasks.push({ kind: 'cross-session', a, b });
    }
  }
  let run = tasks;
  if (tasks.length > CONFLICT_MAX_PAIRS) {
    run = tasks.slice(0, CONFLICT_MAX_PAIRS);
    res.error = `truncated: tested ${CONFLICT_MAX_PAIRS} of ${tasks.length} pairs`;
  }
  const ref = (x) => (x.worktree ? `refs/heads/${x.branch}` : x.branch);
  const out = await pooled(run, 3, async (t) => ({ t, r: await trialMerge(ref(t.a), ref(t.b)) }));
  res.pairsTested = run.length;
  for (const o of out) {
    if (!o) continue;
    if (o.r.clean) {
      if (o.t.kind === 'cross-session') {
        const key = sessionPairKey(o.t.a.owner, o.t.b.owner);
        pendingByPair.set(key, pendingByPair.get(key) - 1);
      }
      continue;
    }
    res.pairs.push({ kind: o.t.kind, a: o.t.a, b: o.t.b, clean: false, files: o.r.files, error: o.r.error, viaMain: false, blocks: 0 });
  }
  for (const [key, pending] of pendingByPair) if (pending === 0) res.cleanSessionPairs.push(key);
  // A cross-session conflict whose files all already conflict with main on side a or b is inherited
  // from a stale branch (both heads merge against the same base): flag it and credit the stale branch.
  const staleFiles = new Map();
  for (const p of res.pairs) if (p.kind === 'vs-main' && !p.error) staleFiles.set(p.a.branch, { pair: p, set: new Set(p.files) });
  for (const p of res.pairs) {
    if (p.kind !== 'cross-session' || p.error || !p.files.length) continue;
    const sa = staleFiles.get(p.a.branch), sb = staleFiles.get(p.b.branch);
    // Squash merges leave stale branches holding pre-squash copies of files now on main, so nearly every file in a
    // pair can be inherited while one or two are left over. Treat "at most 2 leftover files, and most of the pair
    // inherited" as inherited too, but keep the leftovers as `residual` so they are still reported (grouped).
    const left = p.files.filter((f) => !((sa && sa.set.has(f)) || (sb && sb.set.has(f))));
    p.residual = left;
    p.viaMain = left.length === 0 || (left.length <= 2 && left.length * 4 <= p.files.length);
    if (!p.viaMain) continue;
    for (const s of [sa, sb]) if (s && p.files.some((f) => s.set.has(f))) s.pair.blocks++;
  }
  const cross = res.pairs.filter((p) => p.kind === 'cross-session' && !p.error);
  res.viaMainCount = cross.filter((p) => p.viaMain).length;
  res.genuineCount = cross.length - res.viaMainCount;
  return finish();
}

const migCache = makeCache(refreshMigrations, 60000);
const wtCache = makeCache(refreshWorktrees, 60000);
const cfCache = makeCache(refreshConflicts, 60000);
migCache.kick();
wtCache.kick();
cfCache.kick();

// ---------------------------------------------------------------------------
// v4: activity (from hook events), reservations, live-overlap / breach attention
// ---------------------------------------------------------------------------
const ACTIVITY_TAIL_LINES = 2000;
const HHMM = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

async function readActivityEvents(nowMs) {
  const out = [];
  for (const day of [utcDay(nowMs), utcDay(nowMs - 86400000)]) {
    const dir = path.join(ROOT, 'activity', day);
    let names = [];
    try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      let lines = [];
      try { lines = (await readFile(path.join(dir, n), 'utf8')).split('\n').filter(Boolean).slice(-ACTIVITY_TAIL_LINES); } catch { continue; }
      const fileSlug = n.slice(0, -6);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          const ms = Date.parse(ev && ev.ts);
          if (!ev || typeof ev !== 'object' || !Number.isFinite(ms)) continue;
          out.push({ ...ev, slug: typeof ev.slug === 'string' && ev.slug ? ev.slug : fileSlug, ms });
        } catch { /* skip bad line */ }
      }
    }
  }
  out.sort((a, b) => a.ms - b.ms);
  // One Claude session = one session id. If any of a session's events was identified (e.g. an edit inside a
  // listed worktree), attribute ALL of that session's events to that slug, including earlier "unknown-*" ones
  // (e.g. commands run from a worktree its status doesn't list yet).
  const sidVotes = new Map();
  for (const ev of out) {
    if (!ev.sid || /^unknown-/.test(ev.slug)) continue;
    const v = sidVotes.get(ev.sid) || new Map();
    v.set(ev.slug, (v.get(ev.slug) || 0) + 1);
    sidVotes.set(ev.sid, v);
  }
  let identity = null; // loaded lazily, only if an unknown-* event is still unresolved after voting
  for (const ev of out) {
    if (!ev.sid || !/^unknown-/.test(ev.slug)) continue;
    const v = sidVotes.get(ev.sid);
    let best = null, n = 0;
    if (v) for (const [s, c] of v) if (c > n) { best = s; n = c; }
    if (!best) {
      identity ||= await getIdentityMap(nowMs);
      best = identity.get(ev.sid) || null;
    }
    if (best) { ev.slugInferred = ev.slug; ev.slug = best; }
  }
  return out;
}

// identity/<session_id>.json = {"slug","at","via"}, written by hooks when a session runs chat.sh with its slug.
// Cached for 30 s. Only slugs with a status file are accepted, and never the human.
const IDENTITY_TTL_MS = 30000;
let identityCache = { at: 0, map: new Map() };
async function getIdentityMap(nowMs) {
  if (identityCache.at && nowMs - identityCache.at < IDENTITY_TTL_MS) return identityCache.map;
  const map = new Map();
  try {
    const known = new Set((await listMd(path.join(ROOT, 'status'))).map((n) => n.replace(/\.md$/, '')));
    const dir = path.join(ROOT, 'identity');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    for (const n of names) {
      try {
        const j = JSON.parse(await readFile(path.join(dir, n), 'utf8'));
        const slug = j && typeof j.slug === 'string' ? j.slug.trim().toLowerCase() : '';
        if (slug && slug !== HUMAN && known.has(slug)) map.set(n.slice(0, -5), slug);
      } catch { /* skip bad file */ }
    }
  } catch { /* missing folder */ }
  identityCache = { at: nowMs, map };
  return map;
}

function describeEvent(ev) {
  const cmd = String(ev.cmd || '').slice(0, 100);
  if (ev.event === 'edit') return `editing ${ev.file || '?'}`;
  if (ev.event === 'bash') {
    if (ev.category === 'test') return `running tests: ${cmd}`;
    if (ev.category === 'build') return `building: ${cmd}`;
    if (ev.category === 'git-read' || ev.category === 'git-write') return `git: ${cmd}`;
    return `running: ${cmd}`;
  }
  if (ev.event === 'subagent-start') return `subagent${ev.agentType ? ` ${ev.agentType}` : ''} running`;
  if (ev.event === 'prompt') return 'working on a prompt';
  return null;
}

function computeActivity(events, sessionSlugs, nowMs) {
  const H2 = 120 * MIN, M30 = 30 * MIN;
  const per = new Map();
  const get = (slug) => per.get(slug) || per.set(slug, []).get(slug);
  for (const s of sessionSlugs) get(s);
  for (const ev of events) get(ev.slug).push(ev);
  const sessions = {};
  const editsByFile = new Map(); // file -> [{slug, ms, worktree}]
  const allEdits2h = [];
  for (const [slug, evs] of per) {
    const last = evs[evs.length - 1] || null;
    let nowDoing = null;
    let idle = true;
    if (last) {
      if (last.event === 'stop') nowDoing = `idle since ${HHMM(last.ms)}`;
      else if (nowMs - last.ms <= 10 * MIN) { nowDoing = describeEvent(last); idle = false; }
      // a latest event of subagent-stop or an unknown type inside 10 min still counts as active
      if (nowDoing === null && last.event !== 'stop' && nowMs - last.ms <= 10 * MIN) { nowDoing = 'working'; idle = false; }
    }
    let subs = 0, edits1h = 0, bash1h = 0;
    const bins = new Array(BIN_COUNT).fill(0);
    const files = new Map();
    for (const ev of evs) {
      const age = nowMs - ev.ms;
      if (age <= H2) {
        if (ev.event === 'subagent-start') subs++;
        else if (ev.event === 'subagent-stop') subs--;
      }
      if (age <= 60 * MIN) { if (ev.event === 'edit') edits1h++; else if (ev.event === 'bash') bash1h++; }
      if (age < BIN_COUNT * BIN_MINUTES * MIN) bins[BIN_COUNT - 1 - Math.min(BIN_COUNT - 1, Math.floor(Math.max(0, age) / (BIN_MINUTES * MIN)))]++;
      if (ev.event === 'edit' && ev.file && age <= H2) {
        const f = files.get(ev.file) || files.set(ev.file, { file: ev.file, ms: 0, count: 0 }).get(ev.file);
        f.count++; f.ms = Math.max(f.ms, ev.ms);
        (editsByFile.get(ev.file) || editsByFile.set(ev.file, []).get(ev.file)).push({ slug, ms: ev.ms, worktree: ev.worktree || null });
        allEdits2h.push({ slug, ms: ev.ms, file: ev.file });
      }
    }
    sessions[slug] = {
      nowDoing, lastEventAt: last ? new Date(last.ms).toISOString() : null, idle,
      subagentsRunning: Math.max(0, subs), edits1h, bash1h, bins,
      recentFiles: [...files.values()].sort((a, b) => b.count - a.count || b.ms - a.ms).slice(0, 10)
        .map((f) => ({ file: f.file, at: new Date(f.ms).toISOString(), count: f.count })),
    };
  }
  const liveTouches = [];
  for (const [file, edits] of editsByFile) {
    const latest = new Map();
    for (const e of edits) { const p = latest.get(e.slug); if (!p || e.ms > p.ms) latest.set(e.slug, e); }
    if (latest.size < 2) continue;
    const live = edits.some((a) => edits.some((b) => b.slug !== a.slug && Math.abs(a.ms - b.ms) <= M30));
    liveTouches.push({
      file, live,
      slugs: [...latest.values()].sort((a, b) => b.ms - a.ms).map((e) => ({ slug: e.slug, at: new Date(e.ms).toISOString(), worktree: e.worktree })),
    });
  }
  liveTouches.sort((a, b) => Number(b.live) - Number(a.live) || a.file.localeCompare(b.file));
  const recent = events.slice(-150).reverse().map((ev) => {
    const o = { ts: ev.ts, slug: ev.slug, event: ev.event };
    for (const k of ['file', 'cmd', 'category', 'agentType']) if (ev[k] !== undefined) o[k] = ev[k];
    return o;
  });
  return { sessions, liveTouches, events: recent };
}

function liveOverlapAttention(liveTouches, nowMs) {
  const out = [];
  for (const t of liveTouches) {
    if (!t.live) continue;
    const names = t.slugs.map((s) => s.slug);
    const who = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const newest = Date.parse(t.slugs[0].at);
    out.push({
      sev: 'amber', kind: 'live-overlap', slug: names[0],
      text: `${who} both edited ${t.file} in the last 30 min`,
      since: new Date(newest).toISOString(), ageMin: Math.max(0, Math.round((nowMs - newest) / MIN)), ref: t.file,
    });
  }
  return out;
}

async function buildReservations(nowMs) {
  const dir = path.join(ROOT, 'reservations');
  const out = [];
  for (const name of await listMd(dir)) { // listMd ignores subfolders
    try {
      const { text } = await readFileInfo(path.join(dir, name));
      const kv = parseKeyValues(text);
      const sinceMs = Number(kv.since_epoch) * 1000;
      let expMs = Number(kv.expires_epoch) * 1000;
      if (!Number.isFinite(expMs) || !expMs) {
        const ttl = Number(kv.ttl_min);
        expMs = Number.isFinite(sinceMs) && sinceMs && Number.isFinite(ttl) && ttl > 0 ? sinceMs + ttl * MIN : NaN;
      }
      const hasExp = Number.isFinite(expMs);
      out.push({
        id: name.replace(/\.md$/, ''), owner: kv.owner || '', pattern: kv.pattern || '',
        mode: kv.mode === 'exclusive' ? 'exclusive' : 'shared', why: kv.why || '',
        since: Number.isFinite(sinceMs) && sinceMs ? new Date(sinceMs).toISOString() : (kv.since || null),
        expiresAt: hasExp ? new Date(expMs).toISOString() : null,
        expired: hasExp ? nowMs >= expMs : false,
        minutesLeft: hasExp ? Math.max(0, Math.ceil((expMs - nowMs) / MIN)) : null,
        _expMs: hasExp ? expMs : null,
      });
    } catch { /* skip */ }
  }
  return out;
}

function globToRegex(pattern) {
  let p = String(pattern).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!p) return null;
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`, 'i'); } catch { return null; }
}

function reservationAttention(reservations, events, nowMs) {
  const out = [];
  const recentEdits = events.filter((e) => e.event === 'edit' && e.file && nowMs - e.ms <= 30 * MIN);
  for (const r of reservations) {
    if (r.expired) continue;
    if (r.minutesLeft !== null && r._expMs - nowMs < 5 * MIN) {
      out.push({ sev: 'info', kind: 'reservation-expiring', slug: r.owner || null, text: `${r.owner}'s reservation of ${r.pattern} expires in ${r.minutesLeft} min`, since: null, ageMin: null, ref: r.id });
    }
    const re = globToRegex(r.pattern);
    if (!re) continue;
    const hits = new Map(); // slug -> { files:Set, ms }
    for (const e of recentEdits) {
      if (e.slug === r.owner || !re.test(String(e.file).replace(/\\/g, '/'))) continue;
      const h = hits.get(e.slug) || hits.set(e.slug, { files: new Set(), ms: 0 }).get(e.slug);
      h.files.add(e.file); h.ms = Math.max(h.ms, e.ms);
    }
    for (const [slug, h] of hits) {
      const first = [...h.files][0];
      out.push({
        // Exclusive reservations are a real breach (amber); shared ones are just "also working here" (info).
        sev: r.mode === 'exclusive' ? 'amber' : 'info', kind: 'reservation-breach', slug,
        text: `${slug} edited ${first}${h.files.size > 1 ? ` (+${h.files.size - 1} more)` : ''}, which matches ${r.owner}'s ${r.mode} reservation ${r.pattern}`,
        since: new Date(h.ms).toISOString(), ageMin: Math.max(0, Math.round((nowMs - h.ms) / MIN)), ref: r.id,
      });
    }
  }
  return out;
}

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const LOOPBACK_AUTHORITIES = LOOPBACK_NAMES.map((name) => `${name}:${PORT}`);
if (PORT === 80) LOOPBACK_AUTHORITIES.push(...LOOPBACK_NAMES);
const LOOPBACK_ORIGINS = LOOPBACK_AUTHORITIES.map((authority) => `http://${authority}`);

// ---- POST /api/post: messages from the human, written as log files ----
const POST_MAX_BYTES = 32 * 1024; // 4000 JSON-escaped code units can take 24000 bytes, plus other fields.
const POST_KINDS = new Set(['note', 'ask', 'alert', 'reply']);
const RE_NAME = /^[0-9TZ_a-z.-]+\.md$/;
const sha = (s) => createHash('sha256').update(String(s)).digest();

function jsonReply(res, code, obj) { send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function readBodyLimited(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); return resolve(null); }
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { n += c.length; if (n > limit) over = true; else chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

async function handlePost(req, res) {
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGINS.includes(origin)) {
    return jsonReply(res, 403, { error: 'bad origin' });
  }
  const tok = req.headers['x-zm-token'];
  if (typeof tok !== 'string' || !timingSafeEqual(sha(tok), sha(WRITE_TOKEN))) {
    req.resume();
    return jsonReply(res, 403, { error: 'missing or bad token' });
  }
  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') { req.resume(); return jsonReply(res, 400, { error: 'content-type must be application/json' }); }
  const raw = await readBodyLimited(req, POST_MAX_BYTES);
  if (raw === null) return jsonReply(res, 400, { error: `body too large (max ${POST_MAX_BYTES} bytes)` });
  let b;
  try { b = JSON.parse(raw); } catch { return jsonReply(res, 400, { error: 'invalid JSON' }); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return jsonReply(res, 400, { error: 'body must be an object' });
  if (typeof b.kind !== 'string' || !POST_KINDS.has(b.kind)) return jsonReply(res, 400, { error: 'bad kind' });
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) return jsonReply(res, 400, { error: 'text must be 1-4000 chars' });
  let to = null;
  if (b.to !== undefined && b.to !== null) {
    if (typeof b.to !== 'string') return jsonReply(res, 400, { error: 'bad to' });
    const known = (await listMd(path.join(ROOT, 'status'))).map((n) => n.replace(/\.md$/, ''));
    if (b.to !== 'all' && !known.includes(b.to)) return jsonReply(res, 400, { error: 'unknown to' });
    to = b.to;
  }
  let re = null;
  if (b.re !== undefined && b.re !== null) {
    if (typeof b.re !== 'string' || !RE_NAME.test(b.re) || !(await listMd(path.join(ROOT, 'log'))).includes(b.re)) {
      return jsonReply(res, 400, { error: 'bad re' });
    }
    re = b.re;
  }
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const head = [`from: ${HUMAN}`, `kind: ${b.kind}`, `at: ${now.toISOString()}`, `via: dashboard`];
  if (to) head.push(`to: ${to}`);
  if (re) head.push(`re: ${re}`);
  const body = `${to && to !== 'all' ? `@${to} ` : ''}${b.text.replace(/\r\n/g, '\n').trim()}`;
  const content = `${head.join('\n')}\n\n${body}\n`;
  const dir = path.join(ROOT, 'log');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i <= 9; i++) {
    const name = `${stamp}_${HUMAN}_${b.kind}${i ? `-${i}` : ''}.md`;
    try {
      await writeFile(path.join(dir, name), content, { flag: 'wx' });
      return jsonReply(res, 200, { ok: true, file: name });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return jsonReply(res, 400, { error: 'could not write log file' });
    }
  }
  return jsonReply(res, 400, { error: 'could not allocate a unique log file name' });
}

// ---- merge queue (synthesized for the board; views only render it) ----
const MQ_NUDGE_FILE = path.join(ROOT, 'state', 'pr-nudge.json');
const MQ_HOLDS_FILE = path.join(ROOT, 'state', 'pr-holds.json');
const MQ_PLAN_FILE = path.join(ROOT, 'state', 'merge-plan.json');
const MQ_NUDGE_SCRIPT = path.join(ROOT, 'bin', 'pr-nudge.mjs');
const MQ_NUDGE_EVERY_MS = 5 * MIN;
const MQ_MERGED_EVERY_MS = 3 * MIN;
const MQ_PLAN_TTL_MS = 15 * 1000;
const MQ_JQ = '[.[] | select(.merged_at != null) | {number, title, base: .base.ref, head: .head.ref, mergedAt: .merged_at, mergedBy: (.merged_by.login // null), url: .html_url}]';
const mqMerged = { items: [], fetchedAt: null, inflight: false };
const mqNudge = { inflight: false };
let mqPlanCache = { at: 0, plan: null };

function mqEmpty(error) {
  const out = {
    generatedAt: new Date().toISOString(), nudgeAt: null, mergedFetchedAt: null,
    plan: { updatedAt: null, updatedBy: '', note: '' },
    runway: { held: false, owner: null, since: null, why: '', prs: [] },
    merged: [], queue: [], riding: [],
    counts: { mergedToday: 0, mergedToMainToday: 0, queue: 0, ready: 0, landing: 0, riding: 0 },
  };
  if (error) out.error = error;
  return out;
}

function refreshMqMerged() {
  if (!PR_REPO || mqMerged.inflight) return;
  mqMerged.inflight = true;
  execFile('gh', ['api', `repos/${PR_REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=60`, '--jq', MQ_JQ],
    { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      mqMerged.inflight = false;
      if (err) return;
      try {
        const list = JSON.parse(String(stdout));
        if (Array.isArray(list)) {
          for (const p of list) if (!p.mergedBy && mergedByCache.has(p.number)) p.mergedBy = mergedByCache.get(p.number);
          mqMerged.items = list; mqMerged.fetchedAt = new Date().toISOString();
          fillMergedBy(list);
        }
      } catch { /* keep last */ }
    });
}

// The PR list endpoint omits merged_by; the single-PR endpoint has it. It never changes, so fetch once per PR
// (today's merges only, at most 10 per refresh, sequentially) and cache.
const mergedByCache = new Map();
function fillMergedBy(list) {
  const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const todo = list.filter((p) => !p.mergedBy && !mergedByCache.has(p.number) && Date.parse(p.mergedAt) >= dayStart).slice(0, 10);
  const next = () => {
    const p = todo.shift();
    if (!p) return;
    execFile('gh', ['api', `repos/${PR_REPO}/pulls/${p.number}`, '--jq', '.merged_by.login // ""'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      const who = err ? '' : String(stdout).trim();
      if (who) { mergedByCache.set(p.number, who); p.mergedBy = who; }
      next();
    });
  };
  next();
}

function refreshMqNudge() {
  if (!PR_REPO || mqNudge.inflight) return;
  mqNudge.inflight = true;
  execFile(process.execPath, [MQ_NUDGE_SCRIPT],
    { timeout: 150000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, BOARD_URL: `http://127.0.0.1:${PORT}/api/board` } },
    () => { mqNudge.inflight = false; });
}

{
  const m = setInterval(refreshMqMerged, MQ_MERGED_EVERY_MS); m.unref();
  const n = setInterval(refreshMqNudge, MQ_NUDGE_EVERY_MS); n.unref();
  setTimeout(refreshMqMerged, 5000).unref();
  setTimeout(refreshMqNudge, 20000).unref();
}

async function mqReadPlan() {
  const now = Date.now();
  if (now - mqPlanCache.at < MQ_PLAN_TTL_MS) return mqPlanCache.plan;
  let plan = null;
  try { plan = JSON.parse(await readFile(MQ_PLAN_FILE, 'utf8')); } catch { plan = null; }
  mqPlanCache = { at: now, plan };
  return plan;
}

const MQ_STATUS_RANK = { landing: 0, ready: 1, ci: 2, 'needs-work': 3, stacked: 4, held: 5 };
const MQ_CI_ONLY_RE = /^(CI still running|GitHub still computing mergeability)/;

async function buildMergeQueue(sessions, wtItems, prItems, locks) {
  const out = mqEmpty(null);
  const own = (number, headRef) => { try { return prOwner({ number, headRef }, wtItems, sessions); } catch { return null; } };

  let nudge = null;
  try { nudge = JSON.parse(await readFile(MQ_NUDGE_FILE, 'utf8')); } catch { nudge = null; }
  if (nudge && nudge.at) out.nudgeAt = new Date(nudge.at).toISOString();
  const rows = new Map(((nudge && nudge.rows) || []).map((r) => [r.number, r]));

  const plan = await mqReadPlan();
  const phases = (plan && Array.isArray(plan.phases)) ? plan.phases : [];
  if (plan) out.plan = { updatedAt: plan.updatedAt || null, updatedBy: plan.updatedBy || '', note: plan.note || '' };

  const lk = (locks || []).find((l) => l.file === 'main-freeze.md');
  if (lk) {
    const why = String(lk.why || '');
    out.runway = { held: true, owner: lk.owner || null, since: lk.since || null, why, prs: [...new Set([...why.matchAll(/#(\d+)/g)].map((x) => Number(x[1])))] };
  }

  out.mergedFetchedAt = mqMerged.fetchedAt;
  const d = new Date();
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  out.merged = mqMerged.items
    .filter((p) => Date.parse(p.mergedAt) >= dayStart)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .map((p) => ({ number: p.number, title: p.title, owner: own(p.number, p.head), base: p.base, mergedAt: p.mergedAt, mergedBy: p.mergedBy, url: p.url }));

  const byHead = new Map();
  for (const p of prItems) if (p.headRef) byHead.set(p.headRef, p);
  let holdRules;
  try { holdRules = JSON.parse(await readFile(MQ_HOLDS_FILE, 'utf8')); } catch { /* no configured holds */ }
  const holds = new Map(prItems.map((p) => [p.number, holdFor(p, holdRules)]));

  const riders = new Map();
  const ridingNums = new Set();
  for (const p of prItems) {
    const hold = holds.get(p.number);
    const via = hold && /via #(\d+)/.exec(hold);
    if (via && Number(via[1]) !== p.number) {
      const w = Number(via[1]);
      ridingNums.add(p.number);
      out.riding.push({ number: p.number, title: p.title, owner: p.owner || null, with: w });
      if (!riders.has(w)) riders.set(w, []);
      riders.get(w).push(p.number);
    }
  }
  out.riding.sort((a, b) => a.number - b.number);

  const planOrder = [];
  const phaseOf = new Map();
  for (const ph of phases) for (const n of (ph.prs || [])) if (!phaseOf.has(n)) { phaseOf.set(n, ph.title || null); planOrder.push(n); }

  const items = [];
  for (const p of prItems) {
    if (ridingNums.has(p.number)) continue;
    const r = rows.get(p.number);
    const draft = Boolean(p.draft);
    const hold = holds.get(p.number);
    const cachedHold = r?.blockers?.find((b) => /^hold: /.test(b)) || '';
    const current = Boolean(p.sha && p.baseRef) && r?.headSha === p.sha
      && r.base === p.baseRef && r.draft === draft && cachedHold === hold;
    const blockers = current ? [...(r.blockers || [])] : hold ? [hold] : [];
    const freshCi = ciBlocker(p.checks);
    const ci = p.checks?.conclusion ?? (current ? r.ci : null);
    if (draft && !blockers.includes('draft')) blockers.push('draft');
    if (freshCi && !blockers.includes(freshCi.text)) blockers.push(freshCi.text);
    if (!current) blockers.push('readiness not computed yet');
    const stackedP = byHead.get(p.baseRef);
    const stackedOn = stackedP && stackedP.number !== p.number ? stackedP.number : null;
    let status;
    if (out.runway.held && out.runway.prs.includes(p.number) && p.owner && p.owner === out.runway.owner) status = 'landing';
    else if (hold) status = 'held';
    else if (stackedOn) status = 'stacked';
    else if (current && r.ready && !draft && !freshCi) status = 'ready';
    else if (blockers.length && blockers.every((b) => MQ_CI_ONLY_RE.test(b))) status = 'ci';
    else if (!blockers.length && ci === 'pending') status = 'ci';
    else status = 'needs-work';
    items.push({
      number: p.number, title: p.title, owner: p.owner || null, base: p.baseRef || '', head: p.headRef || '', url: p.url,
      status, blockers, phase: phaseOf.has(p.number) ? phaseOf.get(p.number) : null, stackedOn, riders: riders.get(p.number) || [],
    });
  }
  items.sort((a, b) => {
    const pa = planOrder.indexOf(a.number), pb = planOrder.indexOf(b.number);
    if (pa >= 0 || pb >= 0) return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb) || a.number - b.number;
    return MQ_STATUS_RANK[a.status] - MQ_STATUS_RANK[b.status] || a.number - b.number;
  });
  out.queue = items.map((it, i) => ({ position: i + 1, ...it }));
  out.counts = {
    mergedToday: out.merged.length,
    mergedToMainToday: out.merged.filter((m) => m.base === 'main').length,
    queue: out.queue.length,
    ready: out.queue.filter((q) => q.status === 
'ready').length,
    landing: out.queue.filter((q) => q.status === 'landing').length,
    riding: out.riding.length,
  };
  return out;
}

const SEV_ORDER = { red: 0, amber: 1, info: 2 };

async function board() {
  const sessions = await buildSessions();
  const locks = await buildKv('locks');
  const claims = (await buildKv('claims', 'migration-')).sort((a, b) => Number(a.number) - Number(b.number) || a.file.localeCompare(b.file));
  const nowMs = Date.now();
  const { log, logTotal } = await buildLog(nowMs);
  const out = {
    now: new Date(nowMs).toISOString(),
    sessions,
    locks,
    claims,
    log,
    logTotal,
    hotFileOverlaps: hotFileOverlaps(sessions),
  };
  const [roster, idx, migRes, wtRes] = await Promise.all([
    getRoster().catch(() => new Map()),
    logIndex().catch(() => []),
    migCache.get().catch(() => ({ data: null, at: 0 })),
    wtCache.get().catch(() => ({ data: null, at: 0 })),
  ]);
  for (const s of sessions) s.hb = computeHb(s, roster, idx, nowMs);

  const { migrations, allNums } = buildMigrations(migRes.data, migRes.at, sessions, claims, nowMs);
  out.migrations = migrations;
  const wtData = wtRes.data;
  out.worktrees = wtData
    ? { ranAt: wtData.ranAt, ageSec: Math.max(0, Math.round((nowMs - wtRes.at) / 1000)), mainFetchedAt: wtData.mainFetchedAt, items: wtData.items.map((i) => ({ ...i, owner: inferOwner(i.name, sessions) })), error: wtData.error }
    : { ranAt: new Date(nowMs).toISOString(), ageSec: 0, mainFetchedAt: null, items: [], error: 'worktree scan not ready' };
  out.logStats = computeLogStats(idx, nowMs);
  out.timeline = computeTimeline(sessions, locks, nowMs);
  out.prs = buildPrs(sessions, out.worktrees.items, nowMs);
  const cfRes = cfCache.peek();
  out.conflicts = cfRes.data
    ? { ...cfRes.data, ageSec: Math.max(0, Math.round((nowMs - cfRes.at) / 1000)) }
    : { ranAt: null, ageSec: null, gitVersion: null, error: null, pairsTested: 0, genuineCount: 0, viaMainCount: 0, pairs: [], cleanSessionPairs: [] };
  out.caches = { migrations: { ageSec: out.migrations.ageSec }, worktrees: { ageSec: out.worktrees.ageSec }, prs: { ageSec: out.prs.ageSec }, conflicts: { ageSec: out.conflicts.ageSec } };
  out.landingOrder = buildLandingOrder(out.hotFileOverlaps, out.prs, out.conflicts);
  try { out.mergeQueue = await buildMergeQueue(sessions, out.worktrees.items, out.prs.items, locks); } catch (e) { out.mergeQueue = mqEmpty(String((e && e.message) || e).slice(0, 200)); }

  const attention = [];
  // Leftover (non-inherited) files from inherited pairs: one amber item per session pair, not one per branch pair.
  const residualBy = new Map();
  for (const p of out.conflicts.pairs) {
    if (p.kind !== 'cross-session' || !p.viaMain || !(p.residual && p.residual.length) || !p.a.owner || !p.b.owner) continue;
    const k = [p.a.owner, p.b.owner].sort().join(' + ');
    const r = residualBy.get(k) || { files: new Set(), pairs: 0, a: p.a.owner };
    p.residual.forEach((f) => r.files.add(f)); r.pairs++;
    residualBy.set(k, r);
  }
  for (const [k, r] of residualBy) {
    const files = [...r.files];
    attention.push({ sev: 'amber', kind: 'coordinate', slug: r.a, text: `${k}: ${files.map(fileBase).join(', ')} conflicts across ${r.pairs} branch pairs (the rest is inherited from stale branches; merging main in clears it)`, since: null, ageMin: null, ref: files.join(', ') });
  }
  for (const p of out.conflicts.pairs) {
    if (p.error || !p.files.length || !p.a.owner) continue;
    const shown = fileBase(p.files[0]) + (p.files.length > 1 ? ` (+${p.files.length - 1} more)` : '');
    if (p.kind === 'cross-session' && p.b.owner) {
      if (p.viaMain) continue;
      attention.push({ sev: 'red', kind: 'conflict', slug: p.a.owner, text: `${p.a.owner}'s ${p.a.branch} conflicts with ${p.b.owner}'s ${p.b.branch} in ${shown}`, since: null, ageMin: null, ref: p.files.join(', ') });
    } else if (p.kind === 'vs-main') {
      attention.push({ sev: 'amber', kind: 'needs-rebase', slug: p.a.owner, text: `${p.a.owner}'s ${p.a.branch} conflicts with origin/main in ${shown}: rebase before merging${p.blocks ? ` (also blocks ${p.blocks} other branches)` : ''}`, since: null, ageMin: null, ref: p.files.join(', ') });
    }
  }
  out.asks = [];
  try {
    const { asks, meta } = await computeAskList(idx, sessions, nowMs);
    out.asks = asks;
    attention.push(...asksToAttention(asks, meta));
  } catch { /* skip */ }
  for (const s of sessions) {
    if (s.hb.health === 'late' || s.hb.health === 'silent') {
      const ageMin = Math.min(s.hb.statusAgeMin ?? Infinity, s.hb.lastPostAgeMin ?? Infinity);
      const recentMs = nowMs - (Number.isFinite(ageMin) ? ageMin : 0) * MIN;
      attention.push({
        sev: s.hb.health === 'silent' ? 'red' : 'amber', kind: 'stale', slug: s.slug,
        text: `${s.slug} is ${s.hb.health}: no post or status update for ${Number.isFinite(ageMin) ? ageMin : '?'} min`,
        since: Number.isFinite(ageMin) ? new Date(recentMs).toISOString() : null, ageMin: Number.isFinite(ageMin) ? ageMin : null, ref: s.file,
      });
    }
  }
  out.activity = { sessions: {}, liveTouches: [], events: [] };
  out.reservations = [];
  try {
    const actEvents = await readActivityEvents(nowMs);
    out.activity = computeActivity(actEvents, sessions.map((s) => s.slug), nowMs);
    attention.push(...liveOverlapAttention(out.activity.liveTouches, nowMs));
    const resv = await buildReservations(nowMs);
    attention.push(...reservationAttention(resv, actEvents, nowMs));
    out.reservations = resv.map(({ _expMs, ...r }) => r);
  } catch { /* skip */ }
  out.meta = { writeEnabled: true, version: 4 };
  out.caches.activity = { ageSec: 0 };
  attention.push(...computeLockAttention(locks, nowMs));
  for (const p of out.migrations.problems) {
    const claim = claims.find((c) => Number(c.number) === p.n);
    attention.push({ sev: p.sev, kind: 'migration', slug: claim ? claim.owner || null : null, text: p.text, since: null, ageMin: null, ref: claim ? claim.file : null });
  }
  attention.push(...computeOrphans(claims, allNums, sessions, nowMs, Boolean(migRes.data)));
  attention.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]
    || (a.since ? Date.parse(a.since) : 9e15) - (b.since ? Date.parse(b.since) : 9e15));
  out.attention = attention;
  return out;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

// ---- persisted board snapshot (instant cold start) ----
let staleBoard = null; // { board, cachedAt } loaded at startup if under 6 h old
let freshBuilt = false;
let freshInflight = null;
let lastPersistAt = 0;

// Every open view polls /api/board every 5-10 s, and the shell loads all four views at once, so several requests
// arrive together. Share one build between concurrent requests and reuse the result (and its JSON) for 3 s,
// instead of rebuilding the whole board per request (that piled up to 25-55 s responses).
const BOARD_SHARE_MS = 3000;
let boardShared = { at: 0, value: null, json: '', inflight: null };
function sharedBoard() {
  if (boardShared.value && Date.now() - boardShared.at < BOARD_SHARE_MS) return Promise.resolve(boardShared);
  if (boardShared.inflight) return boardShared.inflight;
  const inflight = board().then((b) => {
    boardShared = { at: Date.now(), value: b, json: JSON.stringify(b), inflight: null };
    return boardShared;
  }, (e) => { boardShared.inflight = null; throw e; });
  boardShared.inflight = inflight;
  return inflight;
}

function startFreshBuild() {
  if (freshInflight) return freshInflight;
  freshInflight = sharedBoard().then((s) => s.value)
    .then((b) => { freshBuilt = true; persistBoard(b); })
    .catch(() => { /* keep serving stale; next request retries */ })
    .finally(() => { freshInflight = null; });
  return freshInflight;
}

function persistBoard(b) {
  const nowMs = Date.now();
  if (nowMs - lastPersistAt < BOARD_CACHE_WRITE_EVERY_MS) return;
  lastPersistAt = nowMs;
  const tmp = `${BOARD_CACHE_FILE}.tmp`;
  (async () => {
    await mkdir(path.dirname(BOARD_CACHE_FILE), { recursive: true });
    await writeFile(tmp, JSON.stringify({ cachedAt: new Date(nowMs).toISOString(), board: b }), 'utf8');
    await rename(tmp, BOARD_CACHE_FILE);
  })().catch(() => { /* best effort */ });
}

async function loadBoardCache() {
  try {
    const j = JSON.parse(await readFile(BOARD_CACHE_FILE, 'utf8'));
    const at = Date.parse(j && j.cachedAt);
    if (j && j.board && typeof j.board === 'object' && Number.isFinite(at) && Date.now() - at < BOARD_CACHE_MAX_AGE_MS) {
      staleBoard = { board: j.board, cachedAt: new Date(at).toISOString() };
    }
  } catch { /* no or bad cache: current behaviour */ }
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host?.toLowerCase();
    if (!LOOPBACK_AUTHORITIES.includes(host)) {
      req.resume();
      return jsonReply(res, 403, { error: 'bad host' });
    }
    const pn = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && pn === '/api/post') return await handlePost(req, res);
    if (req.method !== 'GET') return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      const html = (await readFile(path.join(HERE, 'index.html'), 'utf8')).replaceAll(TOKEN_PLACEHOLDER, WRITE_TOKEN);
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    if (pathname === '/api/board') {
      // Cold start: answer from the persisted snapshot until the first fresh build completes.
      if (!freshBuilt && staleBoard) {
        startFreshBuild();
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
          ...staleBoard.board, meta: { ...(staleBoard.board.meta || {}), stale: true, cachedAt: staleBoard.cachedAt },
        }));
      }
      const s = await sharedBoard();
      freshBuilt = true;
      persistBoard(s.value);
      return send(res, 200, 'application/json; charset=utf-8', s.json);
    }
    // Mockup gallery: /mockups/ and /mockups/<lowercase-name>.html only (strict whitelist, no traversal).
    if (pathname === '/mockups' || pathname === '/mockups/') {
      try {
        return send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(HERE, 'mockups', 'index.html')));
      } catch { return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' })); }
    }
    const mock = /^\/mockups\/([a-z0-9-]{1,60}\.html)$/.exec(pathname);
    if (mock) {
      try {
        return send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(HERE, 'mockups', mock[1])));
      } catch { return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' })); }
    }
    // Views: /views/<name>.html only (strict whitelist, no traversal).
    const view = /^\/views\/([a-z0-9-]{1,40}\.html)$/.exec(pathname);
    if (view) {
      try {
        return send(res, 200, 'text/html; charset=utf-8', (await readFile(path.join(HERE, 'views', view[1]), 'utf8')).replaceAll(TOKEN_PLACEHOLDER, WRITE_TOKEN));
      } catch { return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' })); }
    }
    return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
  } catch (e) {
    send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`zippermerge dashboard: http://localhost:${PORT} (bound to ${HOST})`);
  // Load the snapshot and start the first fresh build in the background; the listener is already up.
  loadBoardCache().finally(() => { startFreshBuild(); });
});
