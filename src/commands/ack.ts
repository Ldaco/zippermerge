import type { Args } from '../types.ts';
import { join } from 'node:path';
import { context, requireAgent } from '../context.ts';
import { UserError } from '../errors.ts';
import { markAcked } from '../messages.ts';
import { readJson } from '../store.ts';

export async function run({ positionals }: Args) {
  const [id] = positionals;
  const ctx = context();
  const me = requireAgent(ctx);
  if (!id || !readJson(join(ctx.store, 'messages', `${id}.json`))) throw new UserError(`No message ${id ?? ''}.`);
  markAcked(ctx, me, id);
  console.log(`Acknowledged ${id}.`);
}
