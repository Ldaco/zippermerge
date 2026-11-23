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

const preload = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env.MOCK_GRAPH;
const items = mode.endsWith('-limit')
  ? Array.from({ length: 7 }, (_, i) => ({ number: 7 + i, owner: 'alpha' }))
  : [{ number: 7 }];
globalThis.fetch = async () => ({ json: async () => ({ prs: { rateLimited: mode === 'backoff', items } }) });
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
  if (mode === (graphql ? 'graph-limit' : 'rest-limit')) {
    setImmediate(() => cb(new Error('gh failed'), '', 'API rate limit exceeded (HTTP 403)'));
  } else if (graphql) {
    const later = args.includes('endCursor=thread-100');
    const response = later ? process.env.MOCK_NEXT_GRAPH : mode;
    if (response === 'error') cb(new Error('gh failed'), '', 'connection reset');
    else cb(null, mode === 'rest-limit' ? '${graph(completeReview)}' : response, '');
  } else {
    setImmediate(() => cb(null, JSON.stringify({ state: 'open', mergeable: true, ms: 'clean', base: 'main' }), ''));
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
  for (const file of ['pr-nudge.mjs', 'pr-review-pages.mjs', 'github-pr-pages.mjs', 'pr-ci.mjs', 'config.mjs']) {
    copyFileSync(new URL(`../${file}`, import.meta.url), path.join(bin, file));
  }
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const mock = path.join(root, 'mock.mjs');
  writeFileSync(mock, preload);
  const state = path.join(stateDir, 'pr-nudge.json');
  return {
    state,
    run(response, next = '', ...args) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.join(bin, 'pr-nudge.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: 'test/repo', MOCK_GRAPH: response, MOCK_NEXT_GRAPH: next },
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
    const { stdout, stderr } = run(mode, '', '--post');
    assert.doesNotMatch(stdout, /mock owner note/);
    assert.equal(readFileSync(state, 'utf8'), previous);
    assert.match(stdout + stderr, /skipping.*rate.limit/i);
    assert.ok((stdout.match(/mock GitHub call/g) || []).length < 8, stdout);
  });
}
