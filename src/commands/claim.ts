import type { Args } from '../types.ts';
import { context, recordEvent, requireAgent } from '../context.ts';
import { claimNumber } from '../migrations.ts';

export async function run({ positionals }: Args) {
  const ctx = context();
  const agent = requireAgent(ctx);
  const claim = claimNumber(ctx, agent, positionals[0]);
  recordEvent(ctx, 'claim', { number: claim.number, file: claim.file });
  console.log(`CLAIMED ${claim.number}: create ${claim.path}`);
}
