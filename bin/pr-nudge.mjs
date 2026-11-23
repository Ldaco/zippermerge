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
import { PR_RATE_LIMIT_HEADER, requestPrApi } from './github-pr-pages.mjs';
import { ciBlocker } from './pr-ci.mjs';
import { holdFor } from './pr-holds.mjs';
import { completeReviewThreads, openPrReviewPages } from './pr-review-pages.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(HERE, '..');
const STATE_DIR = path.join(CHAT_DIR, 'state');
const STATE_FILE = path.join(STATE_DIR, 'pr-nudge.json');
const HOLDS_FILE = path.join(STATE_DIR, 'pr-holds.json');
const REPO = PR_REPO;
if (!REPO) process.exit(0); // no GitHub repo configured
const BOARD_URL = process.env.BOARD_URL || `http://127.0.0.1:${process.env.PORT || 4747}/api/board`;
const POST = process.argv.includes('--post');
const REPOST_MIN = 60;
let rateLimitUntil = 0;
let checkDashboardBackoff = false;
let dashboardBlocker = '';

async function dashboardBackoffReason() {
  try {
    const res = await fetch(BOARD_URL, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    const deadline = res.headers.get(PR_RATE_LIMIT_HEADER);
    if (res.ok && /^\d+$/.test(deadline ?? '')) return deadline === '0' ? '' : 'dashboard is in GitHub rate-limit backoff';
  } catch { /* no current rate-limit status */ }
  return 'dashboard backoff status is unavailable';
}

async function requestNudgePrApi(args) {
  if (!rateLimitUntil && !dashboardBlocker && checkDashboardBackoff) {
    const reason = await dashboardBackoffReason();
    dashboardBlocker ||= reason;
  }
  if (rateLimitUntil || dashboardBlocker) return { ok: false, out: '', err: dashboardBlocker || 'GitHub rate-limit backoff active' };
  const result = await requestPrApi(args);
  if (result.rateLimitUntil > rateLimitUntil) {
    rateLimitUntil = result.rateLimitUntil;
    console.error(`pr-nudge: skipping during GitHub rate-limit backoff until ${rateLimitUntil}`);
  }
  return result;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') });
    });
  });
}

async function mergeInfo(num) {
  const r = await requestNudgePrApi(['api', `repos/${REPO}/pulls/${num}`, '--jq', '{state: .state, merged: .merged, mergeable: .mergeable, ms: .mergeable_state, base: .base.ref, headSha: .head.sha, draft: .draft}']);
  if (!r.ok) return { error: r.err.trim().split('\n')[0].slice(0, 160) };
  try { return JSON.parse(r.out); } catch { return { error: 'bad json from gh' }; }
}

// Rule: agents reply to review threads, the PR owner resolves them. So "unanswered" (no reply after
// the opening comment, or the reviewer spoke last) is the agents' job; answered-but-unresolved waits for the owner.
async function threadInfo() {
  const map = new Map();
  try {
    for await (const nodes of openPrReviewPages(REPO, requestNudgePrApi)) {
      for (const n of nodes) {
        if (n.reviewDecision === undefined) continue;
        try {
          const threads = await completeReviewThreads(REPO, n.number, n.reviewThreads, requestNudgePrApi);
          const open = threads.filter((t) => !t.isResolved);
          const unanswered = open.filter((t) => {
            const first = t.comments.nodes[0]?.author?.login;
            const last = t.last.nodes[0]?.author?.login;
            return t.comments.totalCount < 2 || last === first;
          }).length;
          map.set(n.number, { unresolved: open.length, unanswered, awaitingResolve: open.length - unanswered, decision: n.reviewDecision || null });
        } catch { /* this PR's review data stays unknown */ }
      }
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
function classify(p, m, t, hold) {
  const ci = ciBlocker(p.checks);
  const failing = ci?.state === 'failure';
  const pending = ci?.state === 'pending';
  const draft = Boolean(p.draft || m.draft);
  const blockers = [];
  if (m.error) blockers.push(`could not read merge state (${m.error})`);
  else if (!p.sha || !m.headSha) blockers.push('PR head unknown');
  else if (p.sha !== m.headSha) blockers.push('PR head changed since the board scan');
  else if (!p.baseRef || !m.base) blockers.push('PR base branch unknown');
  else if (p.baseRef !== m.base) blockers.push('PR base branch changed since the board scan');
  if (draft) blockers.push('draft');
  if (ci && !pending) blockers.push(ci.text);
  if (!t) blockers.push('review threads unknown');
  if (t && t.decision === 'CHANGES_REQUESTED') blockers.push('changes requested');
  if (t && t.unanswered > 0) blockers.push(`${t.unanswered} unanswered review thread${t.unanswered > 1 ? 's' : ''}`);
  if (m.ms === 'dirty') blockers.push('merge conflicts with base');
  if (m.ms === 'behind') blockers.push('behind base, update branch');
  if (m.ms === 'blocked' && !failing) blockers.push(pending ? ci.text : 'blocked: review or required check');
  if (m.ms === 'unstable' && !failing) blockers.push('a non-required check is failing');
  if (m.ms === 'unknown' || m.mergeable === null) blockers.push('GitHub still computing mergeability');
  if (!blockers.length && pending) blockers.push(ci.text);
  // Answered threads still count as unresolved to GitHub, which can make mergeable_state 'blocked'; that is the owner's step.
  const humansStep = t && t.awaitingResolve > 0 ? `${t.awaitingResolve} answered thread${t.awaitingResolve > 1 ? 's' : ''} for the owner to resolve` : '';
  if (hold) blockers.unshift(hold);
  const ready = !blockers.length && (m.ms === 'clean' || (m.ms === 'blocked' && humansStep));
  return { draft, ready, blockers, humansStep };
}

async function main() {
  let board;
  try {
    const res = await fetch(BOARD_URL, { signal: AbortSignal.timeout(45000) });
    board = await res.json();
    checkDashboardBackoff = res.headers?.has(PR_RATE_LIMIT_HEADER) ?? false;
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
  if (rateLimitUntil) return;
  if (dashboardBlocker) {
    console.log(`pr-nudge: skipping because ${dashboardBlocker}`);
    return;
  }
  let holdRules;
  try { holdRules = JSON.parse(readFileSync(HOLDS_FILE, 'utf8')); } catch { /* no configured holds */ }
  const rows = prs.map((p, i) => {
    const m = infos[i] || {};
    const t = threads.get(p.number) || null;
    const base = m.base || p.baseRef || '';
    const k = classify(p, m, t, holdFor({ ...p, baseRef: base }, holdRules));
    const ci = (p.checks && p.checks.conclusion) || 'none';
    return { number: p.number, title: String(p.title || '').slice(0, 90), owner: p.owner || null, base, head: p.headRef || '', headSha: p.sha || null, ms: m.ms || null, ci, unresolved: t ? t.unresolved : null, open: m.state !== 'closed' && !m.merged, ...k };
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
  const posted = prevPosted && typeof prevPosted === 'object' && !Array.isArray(prevPosted) ? prevPosted : {};
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
