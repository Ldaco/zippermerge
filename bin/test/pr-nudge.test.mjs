import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const completeReview = {
  number: 7,
  reviewDecision: 'APPROVED',
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
};
const graph = (...nodes) => JSON.stringify({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false } } } } });
const reviewWithMoreThreads = {
  ...completeReview,
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'thread-100' } },
};

const preload = String.raw`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.MOCK_GRAPH;
if (mode === 'deadline-limit' || mode === 'early-limit') Date.now = () => 1700000000000;
const midRun = mode === 'mid-run-limit';
const items = mode.endsWith('-limit')
  ? Array.from({ length: 7 }, (_, i) => ({ number: 7 + i, owner: 'alpha', sha: 'board-head', baseRef: 'main' }))
  : [{ number: 7, sha: 'board-head', baseRef: 'main' }];
let dashboardLimited = false;
const pending = [];
globalThis.fetch = async () => ({
  ok: true,
  headers: new Headers(midRun ? { 'X-Zippermerge-Rate-Limit-Until': dashboardLimited ? Date.now() + 900000 : '0' } : {}),
  json: async () => ({ prs: { rateLimited: mode === 'backoff', items } }),
});
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === 'bash') {
    console.log('mock owner note');
    cb(null, '', '');
    return;
  }
  if (cmd !== 'gh') throw new Error('Unexpected command ' + cmd);
  if (mode === 'backoff') throw new Error('Unexpected GitHub call during backoff');
  if (mode.endsWith('-limit')) console.log('mock GitHub call');
  const graphql = args[1] === 'graphql';
  if (mode === 'early-limit') {
    if (args[1].endsWith('/pulls/7')) {
      pending.unshift(() => cb(new Error('gh failed'), 'HTTP/2.0 429\nRetry-After: 1200\r\n\r\n', 'HTTP 429'));
    } else if (args[1].endsWith('/pulls/8')) {
      pending.push(() => cb(new Error('gh failed'), 'HTTP/2.0 403\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1700001800\r\n\r\n', 'HTTP 403'));
    } else {
      pending.push(() => cb(null, graphql ? '${graph(completeReview)}' : '{}', ''));
    }
    if (pending.length === 4) {
      pending.shift()();
      setImmediate(() => {
        console.error('mock held requests complete');
        for (const complete of pending) complete();
      });
    }
    return;
  }
  if (midRun) {
    const response = graphql ? '${graph(reviewWithMoreThreads)}'
      : JSON.stringify({ state: 'open', mergeable: true, ms: 'clean', base: 'main', headSha: 'board-head' });
    if (dashboardLimited) return cb(null, response, '');
    pending.push(() => cb(null, response, ''));
    if (pending.length === 4) {
      dashboardLimited = true;
      for (const complete of pending) setImmediate(complete);
    }
    return;
  }
  if (mode === 'deadline-limit' && graphql) {
    const headers = args.includes('--include') ? 'HTTP/2.0 429\nRetry-After: 1200\r\n\r\n' : '';
    cb(new Error('gh failed'), headers, 'HTTP 429');
  } else if (mode === (graphql ? 'graph-limit' : 'rest-limit')) {
    setImmediate(() => cb(new Error('gh failed'), '', 'API rate limit exceeded (HTTP 403)'));
  } else if (graphql) {
    const later = args.includes('endCursor=thread-100');
    const response = later ? process.env.MOCK_NEXT_GRAPH : mode;
    if (response === 'error') cb(new Error('gh failed'), '', 'connection reset');
    else cb(null, mode === 'rest-limit' ? '${graph(completeReview)}' : response, '');
  } else {
    setImmediate(() => cb(null, JSON.stringify({ state: 'open', mergeable: true, ms: 'clean', base: process.env.MOCK_MERGE_BASE, headSha: process.env.MOCK_MERGE_HEAD }), ''));
  }
};
syncBuiltinESMExports();
`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'zippermerge-nudge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chat = path.join(root, 'chat');
  const repo = path.join(root, 'repo');
  const stateDir = path.join(chat, 'state');
  const bin = path.join(chat, 'bin');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(bin);
  for (const file of ['pr-nudge.mjs', 'pr-review-pages.mjs', 'github-pr-pages.mjs', 'pr-ci.mjs', 'pr-holds.mjs', 'config.mjs']) {
    copyFileSync(new URL(`../${file}`, import.meta.url), path.join(bin, file));
  }
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const mock = path.join(root, 'mock.mjs');
  writeFileSync(mock, preload);
  const state = path.join(stateDir, 'pr-nudge.json');
  return {
    state,
    run(response, next = '', mergeHead = 'board-head', mergeBase = 'main', ...args) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.join(bin, 'pr-nudge.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: 'test/repo', MOCK_GRAPH: response, MOCK_NEXT_GRAPH: next, MOCK_MERGE_HEAD: mergeHead, MOCK_MERGE_BASE: mergeBase },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result;
    },
    readState() {
      return JSON.parse(readFileSync(state, 'utf8'));
    },
  };
}

for (const [name, response] of [
  ['the review query fails', 'error'],
  ['the review query returns invalid JSON', '{'],
  ['the review query returns partial data with errors', JSON.stringify({
    ...JSON.parse(graph(completeReview)), errors: [{ message: 'review data unavailable' }],
  })],
  ['the PR is outside the query window', graph()],
  ['the review thread page is incomplete', graph({
    ...completeReview,
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } },
  })],
]) {
  test(`readiness is withheld when ${name}`, (t) => {
    const { run, readState } = fixture(t);
    run(response);
    const { rows: [row] } = readState();
    assert.equal(row.ready, false);
    assert.match(row.blockers.join(' '), /review threads unknown/i);
  });
}

test('a complete review can mark a clean PR ready', (t) => {
  const { run, readState } = fixture(t);
  run(graph(completeReview));
  const { rows: [row] } = readState();
  assert.equal(row.ready, true);
  assert.deepEqual(row.blockers, []);
});

test('a head change between the board and GitHub reads withholds readiness', (t) => {
  const { run, readState } = fixture(t);
  run(graph(completeReview), '', 'new-head');
  const { rows: [row] } = readState();
  assert.equal(row.ready, false);
  assert.equal(row.headSha, 'board-head');
  assert.match(row.blockers.join(' '), /PR head changed/);
});

test('a base retarget between the board and GitHub reads withholds readiness', (t) => {
  const { run, readState } = fixture(t);
  run(graph(completeReview), '', 'board-head', 'release');
  const { rows: [row] } = readState();
  assert.equal(row.base, 'release');
  assert.equal(row.ready, false);
  assert.match(row.blockers.join(' '), /PR base branch changed/);
});

const firstThreadPage = graph({
  ...completeReview,
  reviewThreads: {
    nodes: Array.from({ length: 100 }, () => ({ isResolved: true })),
    pageInfo: { hasNextPage: true, endCursor: 'thread-100' },
  },
});
const lastThreadPage = (thread) => JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: { nodes: [thread], pageInfo: { hasNextPage: false } } } } },
});

test('readiness uses all review thread pages and withholds it if a later page fails', (t) => {
  const { run, readState } = fixture(t);
  run(firstThreadPage, lastThreadPage({ isResolved: true }));
  assert.equal(readState().rows[0].ready, true);
  run(firstThreadPage, lastThreadPage({ isResolved: false, comments: { totalCount: 1, nodes: [] }, last: { nodes: [] } }));
  assert.deepEqual(readState().rows[0].blockers, ['1 unanswered review thread']);
  run(firstThreadPage, 'error');
  assert.deepEqual(readState().rows[0].blockers, ['review threads unknown']);
});

test('a complete review retains known review blockers', (t) => {
  const { run, readState } = fixture(t);
  run(graph({
    ...completeReview,
    reviewDecision: 'CHANGES_REQUESTED',
    reviewThreads: {
      ...completeReview.reviewThreads,
      nodes: [{ isResolved: false, comments: { totalCount: 1, nodes: [] }, last: { nodes: [] } }],
    },
  }));
  assert.deepEqual(readState().rows[0].blockers, ['changes requested', '1 unanswered review thread']);
});

test('a truncated state file is replaced with fresh state', (t) => {
  const { state, run, readState } = fixture(t);
  writeFileSync(state, '{"at":"x","posted":{');
  run(graph(completeReview));
  assert.equal(readState().rows[0].ready, true);
  assert.deepEqual(readdirSync(path.dirname(state)), ['pr-nudge.json']);
});

test('replacing valid state preserves post history', (t) => {
  const { state, run, readState } = fixture(t);
  const posted = { alpha: { at: 123, sig: 'previous' } };
  writeFileSync(state, JSON.stringify({ posted }));
  run(graph(completeReview));
  assert.deepEqual(readState().posted, posted);
});

for (const posted of ['abc', [1, 2]]) {
  test(`a persisted ${typeof posted === 'string' ? 'string' : 'array'} becomes empty post history`, (t) => {
    const { state, run, readState } = fixture(t);
    writeFileSync(state, JSON.stringify({ posted }));
    run(graph(completeReview));
    assert.deepEqual(readState().posted, {});
  });
}

test('nudge skips GitHub calls and preserves state during board backoff', (t) => {
  const { state, run } = fixture(t);
  const previous = JSON.stringify({ posted: {} });
  writeFileSync(state, previous);
  run('backoff');
  assert.equal(readFileSync(state, 'utf8'), previous);
});

for (const [api, mode] of [['REST', 'rest-limit'], ['GraphQL', 'graph-limit']]) {
  test(`a ${api} rate limit preserves state and suppresses owner notes`, (t) => {
    const { state, run } = fixture(t);
    const previous = JSON.stringify({ posted: { alpha: { at: 123, sig: 'previous' } } });
    writeFileSync(state, previous);
    const { stdout, stderr } = run(mode, '', 'board-head', 'main', '--post');
    assert.doesNotMatch(stdout, /mock owner note/);
    assert.equal(readFileSync(state, 'utf8'), previous);
    assert.match(stdout + stderr, /skipping.*rate.limit/i);
    assert.ok((stdout.match(/mock GitHub call/g) || []).length < 8, stdout);
  });
}

test('nudge reports the server backoff deadline to its caller', (t) => {
  const { run } = fixture(t);
  const { stderr } = run('deadline-limit');
  assert.match(stderr, /GitHub rate-limit backoff until 1700001200000/);
});

test('nudge reports the rate limit before its other requests finish and reports a longer deadline', (t) => {
  const { run } = fixture(t);
  const { stderr } = run('early-limit');
  assert.match(stderr, /backoff until 1700001200000\r?\nmock held requests complete\r?\npr-nudge: skipping during GitHub rate-limit backoff until 1700001800000/);
});

test('nudge stops queued requests when the dashboard enters backoff mid-run', (t) => {
  const { state, run } = fixture(t);
  const previous = JSON.stringify({ posted: {} });
  writeFileSync(state, previous);
  const { stdout, stderr } = run('mid-run-limit', '', 'board-head', 'main', '--post');
  assert.equal(stdout.match(/mock GitHub call/g)?.length, 4, stdout + stderr);
  assert.doesNotMatch(stdout, /mock owner note/);
  assert.equal(readFileSync(state, 'utf8'), previous);
});
