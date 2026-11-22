import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
let scratch, chat, port, dashboard, exited;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'zippermerge-http-'));
  chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'repo');
  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.error?.message || git.stderr);

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  port = listener.address().port;
  listener.close();
  await once(listener, 'close');

  dashboard = spawn(process.execPath, [script, '--port', String(port)], {
    env: {
      ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '', ZM_HUMAN: 'test-human',
      BOARD_CACHE_FILE: path.join(chat, 'state', 'board-cache.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  exited = once(dashboard, 'close');
  const [output] = await Promise.race([
    once(dashboard.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
    exited.then(([code]) => assert.fail(`dashboard exited before listening (${code})`)),
  ]);
  assert.match(String(output), /zippermerge dashboard:/);
});

after(async () => {
  try {
    if (dashboard) {
      dashboard.kill();
      await exited;
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

function request(pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, headers, method: body === undefined ? 'GET' : 'POST',
    }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('dashboard request timed out')));
    req.end(body);
  });
}

test('dashboard checks the Host before routing', async () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]']) {
    assert.equal((await request('/mockups/', { Host: `${host}:${port}` })).status, 200);
  }
  for (const host of [`other.invalid:${port}`, 'localhost', 'localhost:1']) {
    assert.equal((await request('/mockups/', { Host: host })).status, 403);
    const response = await request('/api/post', { Host: host }, '{}');
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.text).error, 'bad host');
  }
});

test('dashboard accepts UTF-8 and JSON-escaped text up to 4000 chars', async () => {
  const index = await request('/');
  assert.equal(index.status, 200);
  const token = /[a-f0-9]{64}/.exec(index.text)?.[0];
  assert.ok(token, 'scratch dashboard supplies a write token');

  const post = (body) => request('/api/post', {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-ZM-Token': token,
  }, body);

  const unicode = '漢'.repeat(4000);
  for (const [text, body] of [
    [unicode, JSON.stringify({ kind: 'note', text: unicode })],
    ['x'.repeat(4000), `{"kind":"note","text":"${'\\u0078'.repeat(4000)}"}`],
  ]) {
    const response = await post(body);
    assert.equal(response.status, 200, response.text);
    const entry = await readFile(path.join(chat, 'log', JSON.parse(response.text).file), 'utf8');
    assert.equal(entry.split('\n\n')[1], `${text}\n`);
  }

  const tooLong = await post(JSON.stringify({ kind: 'note', text: '漢'.repeat(4001) }));
  assert.equal(tooLong.status, 400);
  assert.equal(JSON.parse(tooLong.text).error, 'text must be 1-4000 chars');

  const tooLarge = await post(`{"kind":"note","text":"x"}${' '.repeat(64 * 1024)}`);
  assert.equal(tooLarge.status, 400);
  assert.match(JSON.parse(tooLarge.text).error, /^body too large/);
});
