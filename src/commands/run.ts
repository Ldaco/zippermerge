import type { Args } from '../types.ts';
import { spawnSync } from 'node:child_process';
import { context, recordEvent, requireAgent } from '../context.ts';
import { UserError } from '../errors.ts';
import { tryLock, unlock } from '../locks.ts';

export const options = {
  lock: { type: 'string' },
  'ttl-min': { type: 'string' },
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs a heavy command under a lock, waiting its turn, and records how long the wait was. */
export async function run({ values, positionals }: Args<{ lock?: string; 'ttl-min'?: string }>) {
  const ctx = context();
  const agent = requireAgent(ctx);
  const resource = values.lock ?? 'heavy';
  const command = positionals.join(' ');
  if (!command) throw new UserError('Usage: zippermerge run --lock <name> -- <command>');
  const ttlMs = Number(values['ttl-min'] ?? 120) * 60 * 1000;

  const asked = Date.now();
  let announced = false;
  for (;;) {
    const result = tryLock(ctx, resource, { agent, why: command, ttlMs });
    if (result.ok) break;
    if (!announced) {
      console.log(`Waiting for ${resource}, held by ${result.holder?.agent ?? 'unknown'}.`);
      recordEvent(ctx, 'wait', { resource, holder: result.holder?.agent ?? null });
      announced = true;
    }
    sleep(300);
  }
  const waitedMs = Date.now() - asked;

  const started = Date.now();
  recordEvent(ctx, 'run-start', { resource, command, waitedMs });
  let code = 1;
  try {
    code = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ctx.cwd }).status ?? 1;
  } finally {
    recordEvent(ctx, 'run-end', { resource, command, waitedMs, durationMs: Date.now() - started, code });
    unlock(ctx, resource, agent);
  }
  process.exitCode = code;
}
