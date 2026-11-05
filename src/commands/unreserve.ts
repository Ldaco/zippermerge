import type { Args } from '../types.ts';
import { context, recordEvent, requireAgent } from '../context.ts';
import { unreserve } from '../reservations.ts';

export async function run({ positionals }: Args) {
  const ctx = context();
  unreserve(ctx, requireAgent(ctx), positionals[0]);
  recordEvent(ctx, 'unreserve', { glob: positionals[0] });
  console.log(`RELEASED ${positionals[0]}`);
}
