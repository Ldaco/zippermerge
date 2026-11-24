import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dashboard = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));

test('dashboard migration numbers match main, worktrees and claims above 999', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pearl-dashboard-migrations-'));
  const repo = path.join(root, 'repo');
  const chat = path.join(root, 'chat');
  const migrations = path.join(repo, 'migrations');
  const env = { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_MIG_DIR: 'migrations', ZM_PR_REPO: '',
    BOARD_CACHE_FILE: path.join(chat, 'state', 'board-cache.json') };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  let server, closed;
  try {
    mkdirSync(migrations, { recursive: true });
    mkdirSync(path.join(chat, 'claims'), { recursive: true });
    git('init', '-qb', 'main');
    for (const name of ['999_base.sql', '1000_landed.sql']) writeFileSync(path.join(migrations, name), '-- base\n');
    git('add', 'migrations');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
      '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'commit', '-qm', 'main migrations');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(migrations, '01001_next.sql'), '-- working copy\n');
    writeFileSync(path.join(chat, 'claims', 'migration-1001.md'), 'number: 1001\nowner: alpha\nname: next\n');

    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    server = spawn(process.execPath, [dashboard, '--port', String(port)], {
      cwd: repo, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    });
    closed = once(server, 'close');
    await Promise.race([once(server.stdout, 'data', { signal: AbortSignal.timeout(10000) }),
      closed.then(([code]) => assert.fail('Dashboard exited before listening: ' + code))]);
    const response = await fetch('http://127.0.0.1:' + port + '/api/board', { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const { migrations: scan } = await response.json();
    assert.equal(scan.error, null);
    assert.equal(scan.mainMax, 1000);
    assert.deepEqual(scan.files.map(({ n, name, onMain, claimOwner }) => [n, name, onMain, claimOwner]), [
      [999, '999_base.sql', true, null],
      [1000, '1000_landed.sql', true, null],
      [1001, '01001_next.sql', false, 'alpha'],
    ]);
  } finally {
    if (server) { server.kill(); await closed; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
