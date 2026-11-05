import type { Args } from '../types.ts';
import { context, recordEvent, requireAgent } from '../context.ts';
import { releaseClaim } from '../migrations.ts';

export async function run({ positionals }: Args) {
  const ctx = context();
  const agent = requireAgent(ctx);
  const number = Number(positionals[0]);
  releaseClaim(ctx, agent, number);
  recordEvent(ctx, 'release', { number });
  console.log(`Released ${number}.`);
}
