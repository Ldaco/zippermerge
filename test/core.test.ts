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
