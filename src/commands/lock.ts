import type { Args } from '../types.ts';
import { context, requireAgent } from '../context.ts';
import { tryLock } from '../locks.ts';

export const options = {
  why: { type: 'string' },
  'ttl-min': { type: 'string' },
};

export async function run({ values, positionals }: Args<{ why?: string; 'ttl-min'?: string }>) {
  const ctx = context();
  const agent = requireAgent(ctx);
  const ttlMs = Number(values['ttl-min'] ?? 30) * 60 * 1000;
  const result = tryLock(ctx, positionals[0], { agent, why: values.why ?? '', ttlMs });
  if (result.ok) {
    console.log(`LOCKED ${positionals[0]} until ${result.lock.expiresAt}`);
    return;
  }
  console.log(`BUSY ${positionals[0]}: held by ${result.holder?.agent ?? 'unknown'}${result.holder?.why ? ` (${result.holder.why})` : ''}`);
  process.exitCode = 1;
}
