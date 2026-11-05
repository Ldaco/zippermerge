import type { Args } from '../types.ts';
import { context, recordEvent, requireAgent } from '../context.ts';
import { reserve } from '../reservations.ts';

export const options = {
  exclusive: { type: 'boolean' },
  why: { type: 'string' },
  'ttl-min': { type: 'string' },
};

export async function run({ values, positionals }: Args<{ exclusive?: boolean; why?: string; 'ttl-min'?: string }>) {
  const ctx = context();
  const agent = requireAgent(ctx);
  const ttlMs = Number(values['ttl-min'] ?? 60) * 60 * 1000;
  const record = reserve(ctx, { agent, glob: positionals[0] ?? '', exclusive: values.exclusive, why: values.why, ttlMs });
  recordEvent(ctx, 'reserve', { glob: record.glob, exclusive: record.exclusive });
  console.log(`RESERVED ${record.glob}${record.exclusive ? ' (exclusive)' : ''} until ${record.expiresAt}`);
}
