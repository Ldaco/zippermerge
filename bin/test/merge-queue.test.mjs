import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const numbers = [...Array.from({ length: 62 }, (_, i) => i + 1), 123456];

// Install the fixture in child processes only. All Git operations except the
// simulated failed trial run against the real scratch repo.
if (process.env.ZM_TEST_FAKE_GH === '1') {
  const execFile = childProcess.execFile;
  childProcess.execFile = (cmd, args, opts, cb) => {
    if (cmd === 'git' && args.includes('merge-tree') && args.includes('refs/heads/broken') && args.includes('refs/heads/alice')) {
      const err = Object.assign(new Error('timed out'), { killed: true });
      return queueMicrotask(() => cb(err, '', ''));
    }
    if (cmd !== 'gh') return execFile(cmd, args, opts, cb);
    try {
      const value = fakeGh(args);
      return queueMicrotask(() => cb(null, JSON.stringify(value), ''));
    } catch (err) {
      return queueMicrotask(() => cb(err, '', ''));
    }
  };
  syncBuiltinESMExports();
} else {
  test('scratch board and nudge handle conflicts and the full PR list', { timeout: 30000 }, async (t) => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'zippermerge-merge-test-'));
    const chat = path.join(scratch, 'chat');
    const repo = path.join(scratch, 'repo');
    const nudge = path.join(scratch, 'nudge');
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await rm(scratch, { recursive: true, force: true });
    });

    const dirs = [repo, path.join(chat, 'status'), path.join(chat, 'locks'), path.join(chat, 'state'), path.join(nudge, 'bin')];
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'core.quotePath', 'true');
    git('config', 'core.hooksPath', path.join(scratch, 'hooks'));
    const paths = ['café.mjs', 'a b.txt'];
    for (const file of paths) await writeFile(path.join(repo, file), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const hot = {
      alice: 'café.mjs clean.mjs error.mjs', bob: 'café.mjs missing.mjs', carol: 'clean.mjs',
      broken: 'error.mjs', ghost: 'missing.mjs',
    };
    const alternate = path.join(scratch, 'wt-alternate');
    git('worktree', 'add', '-qb', 'alternate', alternate, 'main');
    for (const [slug, files] of Object.entries(hot)) {
      const tree = path.join(scratch, `wt-${slug}`);
      if (slug !== 'ghost') git('worktree', 'add', '-qb', slug, tree, 'main');
      if (slug === 'alice' || slug === 'bob') {
        for (const file of paths) await writeFile(path.join(tree, file), `${slug}\n`);
        execFileSync('git', ['-C', tree, 'commit', '-qam', slug], { stdio: 'pipe' });
      }
      const prs = { alice: '#42 #123456', bob: '#43', carol: '#61', broken: '#60' }[slug] || '';
      const worktrees = slug === 'alice' ? `${tree} -> ${slug}\n- ${alternate} -> alternate` : `${tree} -> ${slug}`;
      await writeFile(path.join(chat, 'status', `${slug}.md`), `# ${slug}\nWorktrees/branches: ${worktrees}\nHot files: ${files}\nPRs: ${prs}\n`);
    }
    await writeFile(path.join(chat, 'locks', 'main-freeze.md'), 'owner: alice\nwhy: landing #42 and #123456\n');
    await writeFile(path.join(chat, 'state', 'pr-nudge.json'), JSON.stringify({ rows: [
      { number: 44, blockers: ['hold: lands via #42'] },
      { number: 45, blockers: ['hold: lands via #123456'] },
    ] }));
    await Promise.all(['pr-nudge.mjs', 'config.mjs'].map((file) =>
      copyFile(new URL(`../${file}`, import.meta.url), path.join(nudge, 'bin', file))));

    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const url = `http://127.0.0.1:${port}/api/board`;
    const env = {
      ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: 'test/repo',
      ZM_TEST_FAKE_GH: '1', BOARD_URL: url, BOARD_CACHE_FILE: path.join(chat, 'board-cache.json'),
    };
    const launch = (script, ...args) => {
      const child = spawn(process.execPath, ['--import', import.meta.url, script, ...args], {
        env, cwd: repo, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true,
      });
      children.push(child);
      return child;
    };
    launch(fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url)), '--port', String(port));

    let board;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { board = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json(); } catch { /* starting */ }
      if (board?.prs?.fetchedAt && board.conflicts.pairsTested) break;
      await delay(200);
    }
    assert.ok(board?.prs?.fetchedAt && board.conflicts.pairsTested, 'dashboard finished both scans');
    const overlap = (file) => board.landingOrder.find((item) => item.source === 'overlap' && item.file === file);

    await t.test('trial merges report literal conflict paths', () => {
      const conflict = board.conflicts.pairs.find((p) => p.kind === 'cross-session' && p.a.owner === 'alice' && p.b.owner === 'bob');
      assert.deepEqual(new Set(conflict.files), new Set(paths));
      assert.equal(overlap('café.mjs').confirmed, true);
    });
    await t.test('only tested-clean overlaps earn the clean result', () => {
      assert.equal(overlap('clean.mjs').trialRan, true);
      assert.match(overlap('clean.mjs').suggestion, /no textual conflict/);
      for (const file of ['error.mjs', 'missing.mjs']) {
        assert.equal(overlap(file).trialRan, false, file);
        assert.doesNotMatch(overlap(file).suggestion, /no textual conflict/, file);
      }
    });
    await t.test('landing suggestions require green CI', () => {
      assert.equal(overlap('café.mjs').first, null);
      assert.match(overlap('café.mjs').suggestion, /fix failing CI/i);
      assert.equal(overlap('error.mjs').first, null);
      assert.equal(overlap('clean.mjs').first, 'carol');
    });
    await t.test('small and large PR numbers land and carry riders', () => {
      assert.deepEqual(board.mergeQueue.runway.prs, [42, 123456]);
      for (const [number, rider] of [[42, 44], [123456, 45]]) {
        const row = board.mergeQueue.queue.find((p) => p.number === number);
        assert.equal(row.status, 'landing');
        assert.deepEqual(row.riders, [rider]);
        assert.equal(board.mergeQueue.riding.find((p) => p.number === rider).with, number);
      }
    });
    await t.test('PRs beyond the first pages reach the board, queue and nudge', async () => {
      assert.deepEqual(board.prs.items.map((p) => p.number), numbers);
      assert.equal(board.mergeQueue.counts.queue, numbers.length - 2);
      assert.deepEqual(await once(launch(path.join(nudge, 'bin', 'pr-nudge.mjs')), 'exit'), [0, null]);
      const state = JSON.parse(await readFile(path.join(nudge, 'state', 'pr-nudge.json'), 'utf8'));
      assert.equal(state.rows.length, numbers.length);
      assert.equal(state.rows.find((row) => row.number === 123456).unresolved, 1);
    });
  });
}

function fakeGh(args) {
  if (args[1] === 'graphql') {
    const cursor = args.includes('endCursor=more');
    const nodes = (cursor ? numbers.slice(60) : numbers.slice(0, 60)).map((number) => ({
      number, reviewDecision: null, reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: number === 123456 ? [{ isResolved: false, comments: { totalCount: 1, nodes: [{ author: { login: 'reviewer' } }] }, last: { nodes: [{ author: { login: 'reviewer' } }] } }] : [],
      },
    }));
    return { data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: !cursor, endCursor: 'more' } } } } };
  }
  const url = new URL(args[1], 'https://example.invalid');
  if (url.searchParams.get('state') === 'closed') return [];
  if (url.searchParams.get('state') === 'open') {
    const size = Number(url.searchParams.get('per_page'));
    const start = (Number(url.searchParams.get('page') || 1) - 1) * size;
    return numbers.slice(start, start + size).map((number) => ({
      number, title: `PR ${number}`, draft: number === 43, base: { ref: 'main' },
      head: { ref: `feature-${number}`, sha: [42, 60, 61].includes(number) ? String(number) : undefined },
    }));
  }
  if (url.pathname.endsWith('/check-runs')) {
    if (url.pathname.includes('/60/')) return { check_runs: [{ status: 'in_progress', conclusion: null }] };
    return { check_runs: [{ status: 'completed', conclusion: url.pathname.includes('/42/') ? 'failure' : 'success' }] };
  }
  if (/\/pulls\/\d+$/.test(url.pathname)) return { state: 'open', merged: false, mergeable: true, ms: 'clean', base: 'main' };
  throw new Error(`Unexpected gh command: ${args.join(' ')}`);
}
