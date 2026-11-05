import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard } from '../src/board.ts';
import { context } from '../src/context.ts';
import { globToRegex } from '../src/glob.ts';
import { startServer } from '../src/server.ts';
import { makeRepo, sh, write, zm, zmAsync } from './helpers.ts';

test('every worktree shares one store', () => {
  const { main, worktrees } = makeRepo();
  assert.equal(context(main).store, context(worktrees.alpha).store);
});

test('a name like constructor does not break anything', () => {
  const { main, root } = makeRepo();
  const wt = `${root}/wt-c`;
  sh(main, 'worktree', 'add', wt, '-b', 'work/c');
  assert.equal(zm(wt, 'join', 'constructor').code, 0);
  zm(wt, 'send', '--to', 'all', 'hello');
  const board = buildBoard(context(main));
  assert.ok(board.agents.some((a) => a.name === 'constructor'));
});

test('agents cannot act as the human', () => {
  const { worktrees } = makeRepo();
  assert.notEqual(zm(worktrees.alpha, 'join', 'boss').code, 0);
});

test('messages stay unread until handed over, and arrive in full', () => {
  const { worktrees } = makeRepo();
  const long = 'x'.repeat(5000);
  zm(worktrees.alpha, 'send', '--to', 'beta', long);
  assert.ok(zm(worktrees.beta, 'inbox', '--peek').out.includes(long));
  assert.ok(zm(worktrees.beta, 'inbox').out.includes(long), 'a peek must not consume it');
  assert.ok(zm(worktrees.beta, 'inbox').out.includes('Nothing new'));
});

test('only a real reply closes an ask', () => {
  const { main, worktrees } = makeRepo();
  const id = zm(worktrees.alpha, 'send', '--to', 'beta', '--kind', 'ask', 'can you look?').out.trim();
  zm(worktrees.beta, 'send', '--to', 'alpha', 'something unrelated');
  let ask = buildBoard(context(main)).messages.find((m) => m.id === id);
  assert.equal(ask!.answeredBy, null);
  zm(worktrees.beta, 'reply', id, 'yes');
  ask = buildBoard(context(main)).messages.find((m) => m.id === id);
  assert.ok(ask!.answeredBy);
});

test('concurrent claims all get different numbers', async () => {
  const { worktrees } = makeRepo();
  const runs: ReturnType<typeof zmAsync>[] = [];
  for (let i = 0; i < 8; i += 1) runs.push(zmAsync(i % 2 ? worktrees.alpha : worktrees.beta, 'claim', `race${i}`));
  const results = await Promise.all(runs);
  const numbers = results.map((r) => Number(/CLAIMED (\d+)/.exec(r.out)?.[1]));
  assert.equal(new Set(numbers).size, 8, results.map((r) => r.out).join('\n'));
  assert.deepEqual([...numbers].sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a claim fails closed when the base cannot be read', () => {
  const { main, worktrees } = makeRepo();
  zm(main, 'init', '--force', '--migrations', 'db/migrations', '--human', 'boss', '--base', 'no-such-branch');
  assert.notEqual(zm(worktrees.alpha, 'claim', 'x').code, 0);
});

test('the commit guard reads the real staged set', () => {
  const { worktrees } = makeRepo();
  const wt = worktrees.alpha;
  // Staged in the same breath as the commit, the shape that slipped past a command-string guard.
  write(wt, 'db/migrations/003_sneaky.sql', 'select 3;\n');
  sh(wt, 'add', '-A');
  const blocked = sh(wt, 'commit', '-m', 'unclaimed');
  assert.notEqual(blocked.code, 0, blocked.out);
  assert.match(blocked.out, /nobody claimed 3/);

  assert.match(zm(wt, 'claim', 'real').out, /CLAIMED 3/);
  const landed = sh(wt, 'commit', '-m', 'claimed');
  assert.equal(landed.code, 0, landed.out);
});

test('you cannot use a number another agent holds, or one already on base', () => {
  const { worktrees } = makeRepo();
  zm(worktrees.alpha, 'claim', 'mine');
  write(worktrees.beta, 'db/migrations/003_theirs.sql', 'x\n');
  sh(worktrees.beta, 'add', '-A');
  assert.match(sh(worktrees.beta, 'commit', '-m', 'x').out, /belongs to alpha/);
  sh(worktrees.beta, 'reset', '--hard');

  write(worktrees.beta, 'db/migrations/002_old.sql', 'x\n');
  sh(worktrees.beta, 'add', '-A');
  assert.match(sh(worktrees.beta, 'commit', '-m', 'x').out, /already at 2/);
});

test('an exclusive reservation blocks other agents and really is exclusive', () => {
  const { worktrees } = makeRepo();
  assert.match(zm(worktrees.alpha, 'reserve', 'docs/**', '--exclusive').out, /RESERVED/);
  assert.notEqual(zm(worktrees.beta, 'reserve', 'docs/notes.md', '--exclusive').code, 0);
  write(worktrees.beta, 'docs/notes.md', 'changed\n');
  sh(worktrees.beta, 'add', '-A');
  assert.match(sh(worktrees.beta, 'commit', '-m', 'x').out, /exclusive reservation/);
});

test('a lock has one winner and only the holder can release it', async () => {
  const { worktrees } = makeRepo();
  const results = await Promise.all([zmAsync(worktrees.alpha, 'lock', 'suite'), zmAsync(worktrees.beta, 'lock', 'suite')]);
  assert.equal(results.filter((r) => r.code === 0).length, 1);
  const holder = results[0].code === 0 ? worktrees.beta : worktrees.alpha;
  assert.notEqual(zm(holder, 'unlock', 'suite').code, 0);
});

test('run waits its turn and records the wait', async () => {
  const { main, worktrees } = makeRepo();
  const sleeper = 'node -e "setTimeout(()=>{},1200)"';
  const first = zmAsync(worktrees.alpha, 'run', '--lock', 'suite', '--', sleeper);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = zmAsync(worktrees.beta, 'run', '--lock', 'suite', '--', 'node -e "0"');
  await Promise.all([first, second]);
  const { measures, locks } = buildBoard(context(main));
  assert.equal(measures.runs, 2);
  assert.ok(measures.waitedMs > 200, `waited ${measures.waitedMs}`);
  assert.equal(locks.length, 0);
});

test('the sweep sees conflicts between agents, including uncommitted edits', () => {
  const { main, worktrees } = makeRepo();
  write(worktrees.alpha, 'docs/notes.md', 'line one\nALPHA\nline three\n');
  sh(worktrees.alpha, 'commit', '-am', 'alpha edit');
  write(worktrees.beta, 'docs/notes.md', 'line one\nBETA\nline three\n'); // not committed
  const board = buildBoard(context(main));
  const pair = board.conflicts.pairs.find((p) => p.kind === 'cross');
  assert.ok(pair, JSON.stringify(board.conflicts));
  assert.deepEqual(pair.files, ['docs/notes.md']);
  assert.equal(board.counts.amber, 1);
});

test('a colliding number committed with --no-verify still goes red', () => {
  const { main, worktrees } = makeRepo();
  write(worktrees.alpha, 'db/migrations/003_a.sql', 'a\n');
  sh(worktrees.alpha, 'add', '-A');
  sh(worktrees.alpha, 'commit', '--no-verify', '-m', 'a');
  write(worktrees.beta, 'db/migrations/003_b.sql', 'b\n');
  sh(worktrees.beta, 'add', '-A');
  sh(worktrees.beta, 'commit', '--no-verify', '-m', 'b');
  const board = buildBoard(context(main));
  assert.equal(board.counts.red, 1, JSON.stringify(board.attention));
});

test('a git failure shows as unknown, not as all clear', () => {
  const { main } = makeRepo();
  zm(main, 'init', '--force', '--migrations', 'db/migrations', '--human', 'boss', '--base', 'no-such-branch');
  const board = buildBoard(context(main));
  assert.equal(board.baseSha, null);
  assert.ok(board.counts.red >= 1);
});

test('globs match paths and refuse silly patterns', () => {
  assert.ok(globToRegex('docs/**').test('docs/a/b.md'));
  assert.ok(!globToRegex('docs/*').test('docs/a/b.md'));
  assert.ok(globToRegex('web/').test('web/x.ts'));
  assert.throws(() => globToRegex('*'.repeat(20)));
});

test('the server checks host, origin and token, and never serves the token', async () => {
  const { main } = makeRepo();
  const { server, token, port } = await startServer(context(main), { port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const note = (headers: Record<string, string>) =>
    fetch(`${base}/api/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ to: ['all'], body: 'hi' }),
    }).then((r) => r.status);
  try {
    const page = await (await fetch(base)).text();
    const board = await (await fetch(`${base}/api/board`)).text();
    assert.ok(!page.includes(token) && !board.includes(token));
    assert.equal(await note({ Origin: base }), 401, 'no token');
    assert.equal(await note({ 'X-ZM-Token': token }), 403, 'no origin');
    assert.equal(await note({ Origin: 'http://evil.test', 'X-ZM-Token': token }), 403, 'bad origin');
    assert.equal(await note({ Origin: base, 'X-ZM-Token': token }), 200);
    assert.equal((await fetch(`${base}/../../package.json`)).status, 404);
  } finally {
    server.close();
  }
});
