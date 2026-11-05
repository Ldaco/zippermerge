import type { Args } from '../types.ts';
import { context, requireAgent } from '../context.ts';
import { unlock } from '../locks.ts';

export async function run({ positionals }: Args) {
  const ctx = context();
  unlock(ctx, positionals[0], requireAgent(ctx));
  console.log(`UNLOCKED ${positionals[0]}`);
}
