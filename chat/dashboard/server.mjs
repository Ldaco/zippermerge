// Read-only live dashboard for the zippermerge folder. Built-ins only.
import http from 'node:http';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CHAT_ROOT, HUMAN } from '../bin/config.mjs';
const ROOT = path.resolve(CHAT_ROOT);
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

async function buildLog() {
  const dir = path.join(ROOT, 'log');
  const names = (await listMd(dir)).reverse().slice(0, 60);
  const out = [];
  for (const name of names) {
    try {
      const { text } = await readFileInfo(path.join(dir, name));
      const idx = text.indexOf('\n\n');
      const head = idx >= 0 ? text.slice(0, idx) : text;
      const body = idx >= 0 ? text.slice(idx + 2).trim() : '';
      const headers = parseKeyValues(head);
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_([^_]+)_(.+)\.md$/.exec(name);
      const ts = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : headers.at || null;
      out.push({
        name,
        timestamp: ts,
        slug: m ? m[7] : headers.from || '',
        kind: headers.kind || (m ? m[8].replace(/-\d+$/, '') : ''),
        re: headers.re || null,
        headers,
        body,
      });
    } catch { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// v2: computed fields (hb, attention, migrations, timeline, worktrees, logStats, caches)
// ---------------------------------------------------------------------------
const LOG_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_([^_]+)_(.+)\.md$/;
const MIN = 60000;
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
  for (const s of sessions) {
    const f = s.fields && s.fields['Next risky action'];
    if (!f) continue;
    for (const text of [f.value, ...f.items].filter(Boolean)) {
      if (/^\s*none\b/i.test(text)) continue;
      const m = /~?(\d{1,2}):(\d{2})Z/.exec(text);
      let atMs = null;
      if (m) {
        const base = new Date(nowMs); base.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
        let bestDiff = null;
        for (const d of [-1, 0, 1]) {
          const t = base.getTime() + d * 86400000;
          const diff = t - nowMs;
          if (diff >= -30 * MIN && diff <= 12 * 60 * MIN && (bestDiff === null || Math.abs(diff) < Math.abs(bestDiff))) { bestDiff = diff; atMs = t; }
        }
      }
      if (atMs === null) { untimed.push({ slug: s.slug, text, atUtc: null, inMin: null, overdue: false, source: 'risky' }); continue; }
      const inMin = Math.round((atMs - nowMs) / MIN);
      timed.push({ slug: s.slug, text, atUtc: new Date(atMs).toISOString(), inMin, overdue: inMin < 0, source: 'risky' });
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

const SEV_ORDER = { red: 0, amber: 1, info: 2 };

async function board() {
  const sessions = await buildSessions();
  const locks = await buildKv('locks');
  const claims = (await buildKv('claims', 'migration-')).sort((a, b) => Number(a.number) - Number(b.number) || a.file.localeCompare(b.file));
  const log = await buildLog();
  const nowMs = Date.now();
  const out = {
    now: new Date(nowMs).toISOString(),
    sessions,
    locks,
    claims,
    log,
    hotFileOverlaps: hotFileOverlaps(sessions),
  };
  const [roster, idx] = await Promise.all([
    getRoster().catch(() => new Map()),
    logIndex().catch(() => []),
  ]);
  for (const s of sessions) s.hb = computeHb(s, roster, idx, nowMs);

  out.logStats = computeLogStats(idx, nowMs);
  out.timeline = computeTimeline(sessions, locks, nowMs);
  out.caches = {};

  const attention = [];
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
  out.meta = { writeEnabled: false, version: 4 };
  out.caches.activity = { ageSec: 0 };
  attention.push(...computeLockAttention(locks, nowMs));
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
    if (req.method !== 'GET') return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    const pathname = new URL(req.url, 'http://localhost').pathname;
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
