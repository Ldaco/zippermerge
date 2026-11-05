import type { Agent } from '../types.ts';
import { join } from 'node:path';
import { sweep } from '../conflicts.ts';
import { baseRef, context } from '../context.ts';
import { git } from '../git.ts';
import { listJson } from '../store.ts';

export async function run() {
  const ctx = context();
  const agents = listJson<Agent>(join(ctx.store, 'agents'));
  const base = git(['rev-parse', baseRef(ctx)], { cwd: ctx.cwd });
  const { pairs, untested } = sweep(ctx, agents, base);
  if (!pairs.length) console.log('No conflicts found.');
  for (const pair of pairs) console.log(`${pair.a} and ${pair.b}: ${pair.files.join(', ')}`);
  for (const item of untested) console.log(`UNTESTED ${item.who}: ${item.why}`);
}
