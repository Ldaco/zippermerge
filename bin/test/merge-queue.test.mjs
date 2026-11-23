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
const literalBackslash = 'literal\\backslash.mjs';
const ciPrs = new Set([42, 57, 58, 59, 60, 61, 62]);
const updatedAt = (number) => number === 42 ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z';

// Install the fixture in child processes only. All Git operations except the
// simulated failed trial run against the real scratch repo.
if (process.env.ZM_TEST_FAKE_GH === '1') {
  const execFile = childProcess.execFile;
  childProcess.execFile = (cmd, args, opts, cb) => {
    if (cmd === 'git' && args.includes('merge-tree') && args.includes('refs/heads/broken') && args.includes('refs/heads/alice')) {
      const err = Object.assign(new Error('timed out'), { killed: true });
      return queueMicrotask(() => cb(err, '', ''));
    }
    // Git accepts this filename on POSIX, but Windows cannot create it.
    if (cmd === 'git' && args.includes('merge-tree') && args.includes('refs/heads/bob') && args.includes('refs/heads/carol')) {
      const err = Object.assign(new Error('conflict'), { code: 1 });
      return queueMicrotask(() => cb(err, `oid\0${literalBackslash}\0`, ''));
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
    for (const file of [...paths, 'rebasing.mjs']) await writeFile(path.join(repo, file), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const hot = {
      alice: 'café.mjs clean.mjs error.mjs', bob: 'café.mjs missing.mjs backslash.mjs many-checks.mjs partial-checks.mjs legacy-status.mjs stale-checks.mjs',
      carol: 'clean.mjs backslash.mjs', broken: 'error.mjs', ghost: 'missing.mjs',
      quail: 'rebasing.mjs', wren: 'rebasing.mjs', checks: 'many-checks.mjs', partial: 'partial-checks.mjs',
      legacy: 'legacy-status.mjs', stale: 'stale-checks.mjs',
    };
    const alternate = path.join(scratch, 'wt-alternate');
    git('worktree', 'add', '-qb', 'alternate', alternate, 'main');
    const rebasing = path.join(scratch, 'wt-rebasing');
    git('worktree', 'add', '-qb', 'rebasing', rebasing, 'main');
    const change = async (tree, files, content) => {
      for (const file of files) await writeFile(path.join(tree, file), `${content}\n`);
      execFileSync('git', ['-C', tree, 'commit', '-qam', content], { stdio: 'pipe' });
    };
    await change(rebasing, ['rebasing.mjs'], 'rebasing');
    for (const [slug, files] of Object.entries(hot)) {
      const tree = path.join(scratch, `wt-${slug}`);
      if (!['ghost', 'legacy', 'stale'].includes(slug)) git('worktree', 'add', '-qb', slug, tree, 'main');
      if (slug === 'alice' || slug === 'bob') await change(tree, paths, slug);
      if (slug === 'wren') await change(tree, ['rebasing.mjs'], slug);
      const prs = { alice: '#42 #123456', bob: '#43', carol: '#61', broken: '#60', checks: '#62', partial: '#59', legacy: '#58', stale: '#57' }[slug] || '';
      const extra = { alice: `\n- ${alternate} -> alternate`, quail: `\n- ${rebasing} -> rebasing` }[slug] || '';
      const worktrees = `${tree} -> ${slug}${extra}`;
      await writeFile(path.join(chat, 'status', `${slug}.md`), `# ${slug}\nWorktrees/branches: ${worktrees}\nHot files: ${files}\nPRs: ${prs}\n`);
    }
    const stopped = childProcess.spawnSync('git', ['-C', rebasing, 'rebase', 'wren'], { encoding: 'utf8' });
    assert.equal(stopped.status, 1, stopped.stderr);
    await writeFile(path.join(chat, 'locks', 'main-freeze.md'), 'owner: alice\nwhy: landing #42 and #123456\n');
    await writeFile(path.join(chat, 'state', 'pr-nudge.json'), JSON.stringify({ rows: [
      { number: 44, blockers: ['hold: lands via #42'] },
      { number: 45, blockers: ['hold: lands via #123456'] },
      ...[57, 58, 59, 60].map((number) => ({ number, ready: true, ci: 'success', blockers: [] })),
    ] }));
    await Promise.all(['pr-nudge.mjs', 'pr-review-pages.mjs', 'config.mjs'].map((file) =>
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
        env, cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
      });
      child.output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { child.output += chunk; });
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
    await t.test('worktrees stopped in rebase leave the overlap unverified', () => {
      assert.equal(board.worktrees.items.find((w) => w.name === 'wt-rebasing').op, 'rebase');
      assert.equal(overlap('rebasing.mjs').trialRan, false);
      assert.doesNotMatch(overlap('rebasing.mjs').suggestion, /no textual conflict/);
    });
    await t.test('a literal backslash in a Git filename is kept in conflict attribution', () => {
      assert.equal(overlap('backslash.mjs').confirmed, false);
      assert.ok(board.landingOrder.some((item) => item.source === 'merge-tree' && item.file === literalBackslash));
    });
    await t.test('landing suggestions require green CI', () => {
      assert.equal(overlap('café.mjs').first, null);
      assert.match(overlap('café.mjs').suggestion, /fix failing CI/i);
      assert.equal(overlap('error.mjs').first, null);
      assert.equal(overlap('clean.mjs').first, 'carol');
    });
    await t.test('known failures and incomplete check runs on page two both withhold green', () => {
      assert.equal(overlap('many-checks.mjs').first, null);
      assert.equal(board.prs.items.find((pr) => pr.number === 62).checks.conclusion, 'failure');
      assert.equal(overlap('partial-checks.mjs').first, null);
      assert.equal(board.prs.items.find((pr) => pr.number === 59).checks.conclusion, 'unknown');
    });
    await t.test('a failing legacy commit status prevents green even when every check run passed', () => {
      assert.equal(overlap('legacy-status.mjs').first, null);
      assert.equal(board.prs.items.find((pr) => pr.number === 58).checks.conclusion, 'failure');
    });
    await t.test('stale and successful check runs together do not earn green', () => {
      assert.equal(overlap('stale-checks.mjs').first, null);
      assert.equal(board.prs.items.find((pr) => pr.number === 57).checks.conclusion, 'unknown');
    });
    await t.test('current CI takes precedence over cached ready queue rows', () => {
      for (const [number, status, blocker] of [
        [59, 'needs-work', /CI checks unknown/],
        [57, 'needs-work', /CI checks unknown/],
        [58, 'needs-work', /CI failing/],
        [60, 'ci', /CI still running/],
      ]) {
        const row = board.mergeQueue.queue.find((pr) => pr.number === number);
        assert.equal(row.status, status, `PR #${number}`);
        assert.match(row.blockers.join(' '), blocker);
      }
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
    await t.test('the complete PR list survives repeated changes before the page boundary', async () => {
      assert.deepEqual(new Set(board.prs.items.map((p) => p.number)), new Set(numbers));
      assert.equal(board.mergeQueue.counts.queue, numbers.length - 2);
      assert.deepEqual(await once(launch(path.join(nudge, 'bin', 'pr-nudge.mjs')), 'exit'), [0, null]);
      const state = JSON.parse(await readFile(path.join(nudge, 'state', 'pr-nudge.json'), 'utf8'));
      assert.equal(state.rows.length, numbers.length);
      assert.ok(state.rows.find((row) => row.number === 59).blockers.includes('CI checks unknown'));
      assert.equal(state.rows.find((row) => row.number === 123456).unresolved, 1);
    });
    await t.test('the standalone report includes review authors beyond the first PR page', async () => {
      const child = launch(fileURLToPath(new URL('../pr-thread-authors.mjs', import.meta.url)));
      assert.deepEqual(await once(child, 'close'), [0, null]);
      assert.match(child.output, /#123456: reviewer x1/);
    });
  });
}

function fakeGh(args) {
  if (args[1] === 'graphql') {
    const query = args.find((arg) => arg.startsWith('query='));
    if (!query.includes('reviewThreads')) {
      assert.match(query, /after:\s*\$endCursor/);
      assert.match(query, /field:\s*CREATED_AT,\s*direction:\s*ASC/);
      const size = Number(/first:\s*(\d+)/.exec(query)?.[1]);
      assert.ok(size > 0);
      const after = Number(args.find((arg) => arg.startsWith('endCursor=pr-'))?.slice('endCursor=pr-'.length) || 0);
      const open = after ? numbers : [...numbers, 123457];
      const remaining = open.filter((number) => number > after);
      const nodes = remaining.slice(0, size).map((number) => ({
        number, title: `PR ${number}`, isDraft: number === 43, baseRefName: 'main',
        updatedAt: updatedAt(number), headRefName: `feature-${number}`, headRefOid: ciPrs.has(number) ? String(number) : null,
      }));
      const pageInfo = { hasNextPage: remaining.length > size, endCursor: `pr-${nodes.at(-1)?.number}` };
      return { data: { repository: { pullRequests: { nodes, pageInfo } } } };
    }
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
    const page = Number(url.searchParams.get('page') || 1);
    const start = (page - 1) * size;
    // The newest PR reopens before each first page and closes before each next page.
    const open = page === 1 ? [123457, ...numbers.toReversed()] : numbers.toReversed();
    return open.slice(start, start + size).map((number) => ({
      number, title: `PR ${number}`, draft: number === 43, base: { ref: 'main' }, updated_at: updatedAt(number),
      head: { ref: `feature-${number}`, sha: ciPrs.has(number) ? String(number) : undefined },
    }));
  }
  if (url.pathname.endsWith('/check-runs')) {
    const sha = Number(url.pathname.split('/').at(-2));
    const page = Number(url.searchParams.get('page') || 1);
    const check = (id, conclusion = 'success') => ({ id, status: conclusion ? 'completed' : 'in_progress', conclusion });
    if (sha === 59 || sha === 62) {
      if (page === 1) return { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => check(i + 1)) };
      if (sha === 59) throw new Error('second check page unavailable');
      return { total_count: 101, check_runs: [check(101, 'failure')] };
    }
    if (sha === 57) return { total_count: 2, check_runs: [check(1), check(2, 'stale')] };
    return { total_count: 1, check_runs: [check(1, sha === 42 ? 'failure' : sha === 60 ? null : 'success')] };
  }
  if (url.pathname.endsWith('/status')) {
    const sha = Number(url.pathname.split('/').at(-2));
    if (sha === 58) return { total_count: 1, state: 'failure', statuses: [{ state: 'failure', context: 'continuous-integration/jenkins' }] };
    return { total_count: 0, state: 'pending', statuses: [] };
  }
  if (/\/pulls\/\d+$/.test(url.pathname)) return { state: 'open', merged: false, mergeable: true, ms: 'clean', base: 'main' };
  throw new Error(`Unexpected gh command: ${args.join(' ')}`);
}
