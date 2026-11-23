import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Drive the dashboard's normal pollers without opening a port or contacting GitHub.
const harness = `
import cp from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

const timeouts = new Map();
const intervals = new Map();
const timer = { unref() {} };
globalThis.setTimeout = (cb, ms) => { timeouts.set(ms, cb); return timer; };
globalThis.setInterval = (cb, ms) => { intervals.set(ms, cb); return timer; };
http.createServer = () => ({ listen() {} });

const minute = 60000;
let now = Date.now();
Date.now = () => now;
let limit = process.env.TEST_RATE_LIMIT_FROM;
const calls = [];
const rateError = new Error('gh failed');
cp.execFile = (cmd, args, opts, cb) => {
  if (cmd === process.execPath && args[0]?.endsWith('pr-nudge.mjs')) {
    calls.push('nudge');
    const error = limit === 'nudge' ? 'pr-nudge: skipping during GitHub rate-limit backoff\\n' : '';
    return cb(null, '', error);
  }
  if (cmd !== 'gh') return cb(null, '', '');
  const endpoint = args[1];
  if (endpoint.includes('state=open') || endpoint === 'graphql') {
    calls.push('open');
    const empty = endpoint === 'graphql'
      ? JSON.stringify({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } })
      : '[]';
    return limit === 'open' ? cb(rateError, '', 'API rate limit exceeded (HTTP 403)') : cb(null, empty, '');
  }
  if (endpoint.includes('state=closed')) {
    calls.push('merged');
    if (limit === 'merged') return cb(rateError, '', 'HTTP 403');
    const mergedAt = new Date().toISOString();
    const rows = limit === 'detail' ? [11, 12].map((number) => ({ number, mergedAt })) : [];
    return cb(null, JSON.stringify(rows), '');
  }
  calls.push('detail:' + endpoint.split('/').at(-1));
  cb(rateError, '', 'HTTP 403');
};
syncBuiltinESMExports();
await import(process.env.TEST_DASHBOARD_URL);

const ordered = { open: 3000, merged: 5000, nudge: 20000 };
const first = limit === 'detail' ? 'merged' : limit;
const fire = async (cb) => { cb?.(); await new Promise(setImmediate); };
await fire(timeouts.get(ordered[first]));
for (const [name, delay] of Object.entries(ordered)) {
  if (name !== first) await fire(timeouts.get(delay));
}
const during = calls.splice(0);

now += 15 * minute;
limit = '';
await fire(timeouts.get(15 * minute));
await fire(intervals.get(3 * minute));
await fire(intervals.get(5 * minute));
console.log(JSON.stringify({ during, after: calls }));
`;

for (const [source, expected] of [
  ['open', ['open']],
  ['merged', ['merged']],
  ['detail', ['merged', 'detail:11']],
  ['nudge', ['nudge']],
]) {
  test(`all dashboard pollers back off after a rate limit from ${source}`, (t) => {
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
        TEST_RATE_LIMIT_FROM: source,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { during, after } = JSON.parse(result.stdout);
    assert.deepEqual(during, expected);
    assert.deepEqual(after, ['open', 'merged', 'nudge']);
  });
}
