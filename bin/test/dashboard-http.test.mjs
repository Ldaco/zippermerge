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
let scratch, chat, repo, port, dashboard, exited;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'zippermerge-http-'));
  chat = path.join(scratch, 'chat');
  repo = path.join(scratch, 'repo');
  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.error?.message || git.stderr);

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  port = listener.address().port;
  listener.close();
  await once(listener, 'close');

  await startDashboard(port);
});

async function startDashboard(configuredPort) {
  const args = [];
  if (configuredPort === 80) {
    // Exercise the port-80 HTTP policy without requiring a privileged or unoccupied port 80.
    const redirectListen = `
      import http from 'node:http';
      const listen = http.Server.prototype.listen;
      http.Server.prototype.listen = function (requestedPort, ...options) {
        return listen.call(this, requestedPort === 80 ? ${port} : requestedPort, ...options);
      };
    `;
    args.push('--import', `data:text/javascript,${encodeURIComponent(redirectListen)}`);
  }
  dashboard = spawn(process.execPath, [...args, script, '--port', String(configuredPort)], {
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
}

async function stopDashboard() {
  if (!dashboard) return;
  dashboard.kill();
  await exited;
  dashboard = undefined;
}

after(async () => {
  try {
    await stopDashboard();
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

async function writeToken(headers) {
  const index = await request('/', headers);
  assert.equal(index.status, 200);
  const token = /[a-f0-9]{64}/.exec(index.text)?.[0];
  assert.ok(token, 'scratch dashboard supplies a write token');
  return token;
}

function postNote(token, body, headers = {}) {
  return request('/api/post', {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-ZM-Token': token,
    ...headers,
  }, body);
}

test('dashboard accepts UTF-8 and JSON-escaped text up to 4000 chars', async () => {
  const token = await writeToken();
  const post = (body) => postNote(token, body);

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

test('dashboard accepts browser Origins on the default HTTP port', async () => {
  await stopDashboard();
  await startDashboard(80);
  const token = await writeToken({ Host: '127.0.0.1' });
  const body = JSON.stringify({ kind: 'note', text: 'Default-port browser note' });

  for (const host of ['127.0.0.1', 'localhost', '[::1]', 'localhost:80']) {
    const response = await postNote(token, body, { Host: host, Origin: `http://${host}` });
    assert.equal(response.status, 200, `${host}: ${response.text}`);
  }
  for (const origin of ['http://localhost:81', 'https://localhost', 'http://other.invalid']) {
    const response = await postNote(token, body, { Host: 'localhost', Origin: origin });
    assert.equal(response.status, 403, origin);
    assert.equal(JSON.parse(response.text).error, 'bad origin');
  }
});
