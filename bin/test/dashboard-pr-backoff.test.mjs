import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Drive the dashboard's normal pollers without opening a port or contacting GitHub.
const harness = String.raw`
import cp from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const timeouts = new Map();
const intervals = new Map();
const timer = { unref() {} };
globalThis.setTimeout = (cb, ms) => { timeouts.set(ms, cb); return timer; };
globalThis.setInterval = (cb, ms) => { intervals.set(ms, cb); return timer; };
let handleRequest;
http.createServer = (handler) => { handleRequest = handler; return { listen() {} }; };

const minute = 60000;
let now = Math.floor(Date.now() / 1000) * 1000;
Date.now = () => now;
let limit = process.env.TEST_RATE_LIMIT_FROM;
const calls = [];
const checks = new Map();
const ciScenario = ['inflight-ci', 'inflight-inventory', 'mixed-errors'].includes(limit);
let inventory;
const rateError = new Error('gh failed');
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === process.execPath && args[0]?.endsWith('pr-nudge.mjs')) {
    calls.push('nudge');
    if (limit === 'nudge-deadline') return cb(null, '', 'pr-nudge: skipping during GitHub rate-limit backoff until ' + (now + 20 * minute) + '\n');
    const error = limit === 'nudge' ? 'pr-nudge: skipping during GitHub rate-limit backoff\n' : '';
    return cb(null, '', error);
  }
  if (cmd !== 'gh') return cb(null, '', '');
  const endpoint = args[1];
  const send = (body, status = 200, headers = '', stderr = '') => {
    const prefix = args.includes('--include') ? 'HTTP/2.0 ' + status + '\n' + headers + '\r\n' : '';
    cb(status >= 400 ? rateError : null, prefix + JSON.stringify(body), stderr);
  };
  if (endpoint.includes('state=open') || endpoint === 'graphql') {
    calls.push('open');
    const nodes = ciScenario ? Array.from({ length: 7 }, (_, i) => ({ number: 7 - i, headRefOid: 'sha' + (7 - i) })) : [];
    const body = { data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false } } } } };
    if (limit === 'open') return send({}, 429, '', 'gh: Too Many Requests (HTTP 429)');
    if (limit === 'inflight-inventory') { inventory = () => send(body); return; }
    return send(body);
  }
  if (endpoint.includes('state=closed')) {
    calls.push('merged');
    if (limit === 'merged') return send({}, 429, '', 'gh: Too Many Requests (HTTP 429)');
    if (limit === 'inflight-inventory' || limit === 'cached') return send({}, 403, '', 'HTTP 403');
    if (limit === 'retry-after') return send({}, 429, 'Retry-After: 1200\r\n', 'HTTP 429');
    if (limit === 'reset') {
      const reset = (now + 30 * minute) / 1000;
      return send({}, 403, 'X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ' + reset + '\r\n', 'HTTP 403');
    }
    const mergedAt = new Date().toISOString();
    const rows = limit === 'detail' ? [11, 12].map((number) => ({ number, mergedAt })) : [];
    return send(rows);
  }
  if (endpoint.includes('/commits/')) {
    const [, sha, kind] = /commits\/sha(\d+)\/([^?]+)/.exec(endpoint);
    calls.push(kind + ':' + sha);
    if (kind === 'status') return send({ state: 'pending', total_count: 0 });
    if (limit === 'inflight-ci' && Number(sha) <= 4) {
      checks.set(sha, (status) => send({ total_count: 0, check_runs: [] }, status, '', 'HTTP ' + status));
      return;
    }
    if (limit === 'mixed-errors' && sha === '1') return send({}, 502, '', 'HTTP 502');
    if (limit === 'mixed-errors' && sha === '2') return send({}, 403, '', 'HTTP 403');
    return send({ total_count: 0, check_runs: [] });
  }
  calls.push('detail:' + endpoint.split('/').at(-1));
  send({}, 429, '', 'gh: Too Many Requests (HTTP 429)');
};
syncBuiltinESMExports();
await import(process.env.TEST_DASHBOARD_URL);

const ordered = { open: 3000, merged: 5000, nudge: 20000 };
const fire = async (cb) => { cb?.(); await new Promise(setImmediate); };
const startup = (name) => fire(timeouts.get(ordered[name]));
async function readBoard() {
  let snapshot;
  await handleRequest({ method: 'GET', url: '/api/board', headers: { host: '127.0.0.1:4747' } }, {
    writeHead() {}, end(body) { snapshot = JSON.parse(body); },
  });
  return snapshot.prs;
}

let result;
if (limit === 'inflight-ci') {
  await startup('open');
  await fire(() => checks.get('1')(403));
  await startup('merged');
  await startup('nudge');
  result = { calls, rateLimited: (await readBoard()).rateLimited };
} else if (limit === 'inflight-inventory') {
  await startup('open');
  await startup('merged');
  await fire(inventory);
  result = { calls, rateLimited: (await readBoard()).rateLimited };
} else if (limit === 'mixed-errors') {
  await startup('open');
  const { error, rateLimited } = await readBoard();
  result = { error, rateLimited };
} else if (limit === 'cached') {
  const before = (await readBoard()).rateLimited;
  now += 1000;
  await startup('merged');
  const after = (await readBoard()).rateLimited;
  now += 15 * minute - 1000;
  const nearEnd = (await readBoard()).rateLimited;
  now += 1000;
  result = { before, after, nearEnd, expired: (await readBoard()).rateLimited };
} else {
  const first = ['detail', 'retry-after', 'reset'].includes(limit) ? 'merged' : limit === 'nudge-deadline' ? 'nudge' : limit;
  await startup(first);
  for (const name of Object.keys(ordered)) {
    if (name !== first) await startup(name);
  }
  const during = calls.splice(0);
  const minutes = limit === 'reset' ? 30 : ['retry-after', 'nudge-deadline'].includes(limit) ? 20 : 15;
  limit = '';
  now += 15 * minute;
  await fire(timeouts.get(15 * minute));
  if (minutes > 15) {
    await fire(intervals.get(3 * minute));
    await fire(intervals.get(5 * minute));
  }
  const atFallback = calls.splice(0);
  if (minutes > 15) {
    now += (minutes - 15) * minute;
    await fire(timeouts.get(minutes * minute) || timeouts.get((minutes - 15) * minute));
  }
  await fire(intervals.get(3 * minute));
  await fire(intervals.get(5 * minute));
  result = { during, atFallback, after: calls };
}
console.log(JSON.stringify(result));
`;

function runScenario(t, source) {
  const root = mkdtempSync(path.join(tmpdir(), 'zippermerge-pr-backoff-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chat = path.join(root, 'chat');
  const repo = path.join(root, 'repo');
  mkdirSync(chat);
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: harness,
    encoding: 'utf8',
    env: {
      ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: 'test/repo',
      BOARD_CACHE_FILE: path.join(chat, 'board-cache.json'),
      TEST_DASHBOARD_URL: new URL('../../dashboard/server.mjs', import.meta.url).href,
      PORT: '4747', TEST_RATE_LIMIT_FROM: source,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

for (const [source, expected] of [
  ['open', ['open']],
  ['merged', ['merged']],
  ['detail', ['merged', 'detail:11']],
  ['nudge', ['nudge']],
]) {
  test(`all dashboard pollers back off after a rate limit from ${source}`, (t) => {
    const { during, atFallback, after } = runScenario(t, source);
    assert.deepEqual(during, expected);
    assert.deepEqual([...atFallback, ...after], ['open', 'merged', 'nudge']);
  });
}

test('a rate-limited CI request stops new work before the refresh settles', (t) => {
  const { calls, rateLimited } = runScenario(t, 'inflight-ci');
  assert.deepEqual(calls, ['open', 'check-runs:1', 'check-runs:2', 'check-runs:3', 'check-runs:4']);
  assert.equal(rateLimited, true);
});

test('an inventory response cannot start CI work during another poller’s backoff', (t) => {
  const { calls, rateLimited } = runScenario(t, 'inflight-inventory');
  assert.deepEqual(calls, ['open', 'merged']);
  assert.equal(rateLimited, true);
});

test('the refresh preserves its first diagnostic when a later check hits the limit', (t) => {
  assert.deepEqual(runScenario(t, 'mixed-errors'), { error: 'HTTP 502', rateLimited: true });
});

test('a cached board response exposes the current backoff when it starts and expires', (t) => {
  assert.deepEqual(runScenario(t, 'cached'), { before: false, after: true, nearEnd: true, expired: false });
});

for (const [source, first] of [['retry-after', 'merged'], ['reset', 'merged'], ['nudge-deadline', 'nudge']]) {
  test(`a deadline from ${source} extends backoff beyond the fallback`, (t) => {
    const { during, atFallback, after } = runScenario(t, source);
    assert.deepEqual(during, [first]);
    assert.deepEqual(atFallback, []);
    assert.deepEqual(after, ['open', 'merged', 'nudge']);
  });
}
