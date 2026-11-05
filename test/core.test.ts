import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context } from '../src/context.ts';
import { makeRepo, sh, write, zm, zmAsync } from './helpers.ts';

test('every worktree shares one store', () => {
  const { main, worktrees } = makeRepo();
  assert.equal(context(main).store, context(worktrees.alpha).store);
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
