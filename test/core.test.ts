import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context } from '../src/context.ts';
import { makeRepo, sh, write, zm, zmAsync } from './helpers.ts';

test('every worktree shares one store', () => {
  const { main, worktrees } = makeRepo();
  assert.equal(context(main).store, context(worktrees.alpha).store);
});
