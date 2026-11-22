#!/usr/bin/env node
// pr-nudge: per-PR merge readiness for every open PR the dashboard knows about, grouped by owning session.
// Reads the dashboard's /api/board (PR list, owners, CI), adds GitHub's mergeable_state per PR over REST
// (one GET per PR, no GraphQL), writes state/pr-nudge.json, and prints a summary.
// With --post it also posts one note per session whose blocker list changed (or every 60 min), via chat.sh.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PR_REPO } from './config.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(HERE, '..');
const STATE_DIR = path.join(CHAT_DIR, 'state');
const STATE_FILE = path.join(STATE_DIR, 'pr-nudge.json');
const REPO = PR_REPO;
if (!REPO) process.exit(0); // no GitHub repo configured
const BOARD_URL = process.env.BOARD_URL || `http://127.0.0.1:${process.env.PORT || 4747}/api/board`;
const POST = process.argv.includes('--post');
const REPOST_MIN = 60;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

async function mergeInfo(num) {
  const r = await run('gh', ['api', `repos/${REPO}/pulls/${num}`, '--jq', '{state: .state, merged: .merged, mergeable: .mergeable, ms: .mergeable_state, base: .base.ref, draft: .draft}']);
  if (!r.ok) return { error: r.err.trim().split('\n')[0].slice(0, 160) };
  try { return JSON.parse(r.out); } catch { return { error: 'bad json from gh' }; }
}

// One GraphQL call per run (a few points): unresolved review threads and review decision for every open PR.
// Rule: agents reply to review threads, the PR owner resolves them. So "unanswered" (no reply after
// the opening comment, or the reviewer spoke last) is the agents' job; answered-but-unresolved waits for the owner.
const THREADS_QUERY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:60,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number reviewDecision reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){totalCount nodes{author{login}}} last:comments(last:1){nodes{author{login}}}}}}}}}';
async function threadInfo() {
  const [owner, name] = REPO.split('/');
  const r = await run('gh', ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]);
  const map = new Map();
  if (!r.ok) return map;
  try {
    const { data, errors } = JSON.parse(r.out);
    if (errors?.length) return map;
    const nodes = data.repository.pullRequests.nodes;
    for (const n of nodes) {
      if (n?.reviewThreads?.pageInfo?.hasNextPage !== false || !Array.isArray(n.reviewThreads.nodes) || n.reviewDecision === undefined) continue;
      const open = n.reviewThreads.nodes.filter((t) => !t.isResolved);
      const unanswered = open.filter((t) => {
        const first = t.comments.nodes[0] && t.comments.nodes[0].author && t.comments.nodes[0].author.login;
        const last = t.last.nodes[0] && t.last.nodes[0].author && t.last.nodes[0].author.login;
        return t.comments.totalCount < 2 || last === first;
      }).length;
      map.set(n.number, { unresolved: open.length, unanswered, awaitingResolve: open.length - unanswered, decision: n.reviewDecision || null });
    }
  } catch { /* PRs without a complete entry are classified as unknown */ }
  return map;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}

// GitHub mergeable_state: clean, dirty (conflicts), behind (base moved, branch protection wants it current),
// blocked (required review or required check missing), unstable (non-required checks failing), unknown (still computing), draft.
function classify(p, m, t) {
  const c = p.checks || {};
  const blockers = [];
  if (m.error) blockers.push(`could not read merge state (${m.error})`);
  if (p.draft || m.draft) blockers.push('draft');
  if (Number(c.failure) > 0) blockers.push(`CI failing (${c.failure})`);
  if (!t) blockers.push('review threads unknown');
  if (t && t.decision === 'CHANGES_REQUESTED') blockers.push('changes requested');
  if (t && t.unanswered > 0) blockers.push(`${t.unanswered} unanswered review thread${t.unanswered > 1 ? 's' : ''}`);
  if (m.ms === 'dirty') blockers.push('merge conflicts with base');
  if (m.ms === 'behind') blockers.push('behind base, update branch');
  if (m.ms === 'blocked' && !(Number(c.failure) > 0)) blockers.push(Number(c.pending) > 0 ? 'CI still running' : 'blocked: review or required check');
  if (m.ms === 'unstable' && !(Number(c.failure) > 0)) blockers.push('a non-required check is failing');
  if (m.ms === 'unknown' || m.mergeable === null) blockers.push('GitHub still computing mergeability');
  if (!blockers.length && Number(c.pending) > 0) blockers.push('CI still running');
  // Answered threads still count as unresolved to GitHub, which can make mergeable_state 'blocked'; that is the owner's step.
  const humansStep = t && t.awaitingResolve > 0 ? `${t.awaitingResolve} answered thread${t.awaitingResolve > 1 ? 's' : ''} for the owner to resolve` : '';
  const hold = holdFor(p);
  if (hold) blockers.unshift(hold);
  const ready = !blockers.length && (m.ms === 'clean' || (m.ms === 'blocked' && humansStep));
  return { ready, blockers, humansStep };
}

// Holds that the PR state can't show, such as a stack of PRs that must land together through one merge commit.
// Edit state/pr-holds.json to change: {"byOwnerNonMainBase": {"<slug>": "lands via #<n> (merge commit)"}, "byNumber": {"<n>": "unowned: owner's call"}}
const HOLDS_FILE = path.join(STATE_DIR, 'pr-holds.json');
let holdsCache = null;
function holdFor(p) {
  if (!holdsCache) {
    try { holdsCache = JSON.parse(readFileSync(HOLDS_FILE, 'utf8')); } catch { holdsCache = {}; }
  }
  const byNum = holdsCache.byNumber || {};
  if (byNum[String(p.number)]) return `hold: ${byNum[String(p.number)]}`;
  if ((holdsCache.notHeld || []).map(String).includes(String(p.number))) return '';
  const byOwner = holdsCache.byOwnerNonMainBase || {};
  if (p.owner && byOwner[p.owner] && p.baseRef && p.baseRef !== 'main') return `hold: ${byOwner[p.owner]}`;
  return '';
}

async function main() {
  let board;
  try {
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(45000) });
    board = await res.json();
  } catch (e) {
    console.log(`pr-nudge: dashboard not reachable at ${BOARD_URL} (${e.message}). Start it with: node dashboard/server.mjs`);
    process.exit(1);
  }
  if (board.prs?.rateLimited) {
    console.log('pr-nudge: skipping during GitHub rate-limit backoff');
    return;
  }
  const prs = ((board.prs && board.prs.items) || []).filter((p) => p && p.number);
  const [infos, threads] = await Promise.all([pool(prs, 3, (p) => mergeInfo(p.number)), threadInfo()]);
  const rows = prs.map((p, i) => {
    const m = infos[i] || {};
    const t = threads.get(p.number) || null;
    const k = classify(p, m, t);
    const ci = (p.checks && p.checks.conclusion) || 'none';
    return { number: p.number, title: String(p.title || '').slice(0, 90), owner: p.owner || null, base: m.base || p.baseRef || '', head: p.headRef || '', ms: m.ms || null, ci, unresolved: t ? t.unresolved : null, open: m.state !== 'closed' && !m.merged, ...k };
  }).filter((r) => r.open);
  const tag = (r) => `#${r.number}->${r.base}${r.ci === 'none' ? ' (no CI)' : ''}${r.humansStep ? ` (${r.humansStep})` : ''}`;

  let prevPosted;
  try { prevPosted = JSON.parse(readFileSync(STATE_FILE, 'utf8'))?.posted; } catch { /* start with empty post history */ }
  const byOwner = new Map();
  for (const r of rows) {
    const k = r.owner || '(unowned)';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(r);
  }
  const nowMs = Date.now();
  const posted = { ...prevPosted };
  const summary = [];
  for (const [owner, list] of [...byOwner.entries()].sort()) {
    list.sort((a, b) => a.number - b.number);
    const ready = list.filter((r) => r.ready);
    const toMain = ready.filter((r) => r.base === 'main');
    const notReady = list.filter((r) => !r.ready);
    summary.push(`${owner}: ${list.length} open, ${ready.length} ready (${toMain.length} into main)`);
    for (const r of notReady) summary.push(`  #${r.number} -> ${r.base}: ${r.blockers.join('; ')}`);
    if (ready.length) summary.push(`  ready: ${ready.map(tag).join(' ')}`);
    if (!POST || owner === '(unowned)') continue;
    const sig = notReady.map((r) => `${r.number}:${r.blockers.join('|')}`).join(',') + `/ready:${ready.map((r) => r.number).join(',')}`;
    const last = posted[owner] || {};
    const stale = !last.at || (nowMs - last.at) / 60000 >= REPOST_MIN;
    if (sig === last.sig && !stale) continue;
    const lines = [];
    lines.push(`@${owner} PR readiness (${new Date(nowMs).toISOString().slice(11, 16)}Z): ${ready.length} of ${list.length} ready to squash.`);
    const groups = new Map();
    for (const r of notReady) { const key = r.blockers[0]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(`#${r.number}`); }
    for (const [why, nums] of groups) lines.push(`- ${why}: ${nums.join(' ')}`);
    if (ready.length) lines.push(`- ready for the owner (no conflicts, CI not failing, every thread answered): ${ready.map(tag).join(' ')}`);
    lines.push('Fix the top group first. Reply to threads; resolving and squashing wait for the owner\'s own word (rule 4).');
    const text = lines.slice(0, 10).join('\n');
    // Git Bash occasionally fails to fork or hits a file lock; retry once after a short pause.
    let r = await run('bash', [path.join(CHAT_DIR, 'chat.sh'), 'post', 'chat', 'note', text]);
    if (!r.ok) { await new Promise((ok) => setTimeout(ok, 3000)); r = await run('bash', [path.join(CHAT_DIR, 'chat.sh'), 'post', 'chat', 'note', text]); }
    if (r.ok) posted[owner] = { at: nowMs, sig };
    const errTail = r.err.trim().split('\n').filter(Boolean).slice(-2).join(' / ').slice(-240);
    summary.push(`  -> ${r.ok ? 'posted' : `post failed after retry: ${errTail}`}`);
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ at: new Date(nowMs).toISOString(), rows, posted }, null, 2));
    renameSync(tmp, STATE_FILE);
  } finally {
    rmSync(tmp, { force: true });
  }
  const total = rows.length, readyN = rows.filter((r) => r.ready).length;
  console.log(`pr-nudge ${new Date(nowMs).toISOString()}: ${readyN}/${total} open PRs ready to squash`);
  console.log(summary.join('\n'));
}

main().catch((e) => { console.log(`pr-nudge failed: ${e && e.stack ? e.stack : e}`); process.exit(1); });
