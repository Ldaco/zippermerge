import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

test('GET /api/board serves multiple residual conflicts and isolates conflict attention errors', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zm-board-conflicts-'));
  let child, closed;
  t.after(async () => {
    try {
      if (child) { child.kill(); await closed; }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const repo = path.join(root, 'repo');
  const chat = path.join(root, 'chat');
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(chat, 'status'), { recursive: true });
  await mkdir(path.join(chat, 'locks'));
  await writeFile(path.join(chat, 'locks', 'main-freeze.md'), 'owner: alice\nsince_epoch: ' + Math.floor(Date.now() / 1000) + '\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(repo, 'config', 'commit.gpgSign', 'false');

  // Six of the eight branch conflicts are inherited from main. The scanner
  // groups the other two into one amber coordination item for this owner pair.
  const inherited = Array.from({ length: 6 }, (_, i) => 'src/shared-' + i + '.txt');
  const residual = ['src/left.txt', 'src/right.txt'];
  const files = [...inherited, ...residual];
  async function commitFiles(tree, names, content) {
    for (const name of names) await writeFile(path.join(tree, name), content + '\n');
    git(tree, 'add', 'src');
    git(tree, 'commit', '-qm', content);
  }
  await commitFiles(repo, files, 'base');
  for (const owner of ['alice', 'bob']) {
    const tree = path.join(root, 'wt-' + owner);
    git(repo, 'worktree', 'add', '-qb', owner, tree, 'main');
    await commitFiles(tree, files, owner);
    await writeFile(path.join(chat, 'status', owner + '.md'), '# ' + owner + '\nWorktrees/branches: ' + tree + ' -> ' + owner + '\n');
  }
  await commitFiles(repo, inherited, 'upstream');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  // Enable fault injection only after exercising an unmodified native basename.
  const fault = path.join(root, 'fail-formatting');
  const preload = [
    "import path from 'node:path'; import { existsSync } from 'node:fs';",
    "const basename = path.posix.basename;",
    "path.posix.basename = (...args) => {",
    "  if (args[0] === 'src/left.txt' && existsSync(process.env.FORMAT_FAULT)) throw Error('fixture formatting fault');",
    "  return basename(...args);",
    "};",
  ].join('\n');
  const server = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), server, '--port', String(port)], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '', BOARD_CACHE_FILE: path.join(root, 'board.json'), FORMAT_FAULT: fault },
  });
  closed = once(child, 'close');
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });

  await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });

  async function readBoard(ready) {
    const until = Date.now() + 20000;
    do {
      const response = await fetch('http://127.0.0.1:' + port + '/api/board', { signal: AbortSignal.timeout(10000) });
      const board = await response.json();
      assert.equal(response.status, 200, JSON.stringify(board.error));
      if (ready(board)) return board;
      await delay(200);
    } while (Date.now() < until);
    assert.fail('Timed out waiting for updated conflict attention');
  }
  const board = await readBoard(b => b.conflicts.pairsTested > 0);
  const pair = board.conflicts.pairs.find(p => p.kind === 'cross-session');
  assert.equal(pair.viaMain, true);
  assert.deepEqual(pair.residual, residual);
  const item = board.attention.find(a => a.kind === 'coordinate');
  assert.equal(item.sev, 'amber');
  assert.equal(item.ref, residual.join(', '));
  assert.match(item.text, /alice \+ bob: left\.txt, right\.txt conflicts across 1 branch pairs/);

  await writeFile(fault, '');
  const degraded = await readBoard(b => b.attention.some(a => a.kind === 'unavailable' && /conflict/i.test(a.text)));
  assert.equal(degraded.attention.find(a => a.kind === 'unavailable').sev, 'amber');
  assert.ok(degraded.conflicts.pairs.some(p => p.kind === 'cross-session'));
  assert.ok(degraded.attention.some(a => a.kind === 'freeze' && a.slug === 'alice'));
  assert.equal(degraded.sessions.length, 2);
  const stillDegraded = await readBoard(b => b.now !== degraded.now);
  assert.ok(stillDegraded.attention.some(a => a.kind === 'unavailable'));
  assert.equal(diagnostics.split('fixture formatting fault').length - 1, 1);
});
