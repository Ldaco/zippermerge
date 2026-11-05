import type { Ctx, Lock } from './types.ts';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { recordEvent } from './context.ts';
import { UserError } from './errors.ts';
import { listJson, readJson, stamp, writeExclusive } from './store.ts';

const locksDir = (ctx: Ctx) => join(ctx.store, 'locks');
const lockFile = (ctx: Ctx, resource: string) => join(locksDir(ctx), `${resource}.json`);

function checkName(resource: string | undefined): asserts resource is string {
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(resource ?? '')) {
    throw new UserError('A lock name is letters, digits, dot, underscore and hyphen.');
  }
}

export function loadLocks(ctx: Ctx): Lock[] {
  return listJson<Lock>(locksDir(ctx));
}

function retire(ctx: Ctx, resource: string): boolean {
  const released = join(locksDir(ctx), 'released');
  mkdirSync(released, { recursive: true });
  try {
    renameSync(lockFile(ctx, resource), join(released, `${resource}-${stamp()}.json`));
    return true;
  } catch {
    return false; // only one caller wins the rename
  }
}

/** Returns { ok: true, lock } or { ok: false, holder }. An expired lock is taken over. */
export type LockResult = { ok: true; lock: Lock } | { ok: false; holder: Lock | null };

export function tryLock(
  ctx: Ctx,
  resource: string | undefined,
  { agent, why = '', ttlMs = 30 * 60 * 1000 }: { agent: string; why?: string; ttlMs?: number },
): LockResult {
  checkName(resource);
  const now = Date.now();
  const lock: Lock = {
    resource,
    agent,
    why,
    ts: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  if (writeExclusive(lockFile(ctx, resource), lock)) {
    recordEvent(ctx, 'lock', { resource, why });
    return { ok: true, lock };
  }
  const holder = readJson<Lock>(lockFile(ctx, resource));
  if (holder && Date.parse(holder.expiresAt) < now && retire(ctx, resource)) {
    recordEvent(ctx, 'lock-expired', { resource, holder: holder.agent });
    return tryLock(ctx, resource, { agent, why, ttlMs });
  }
  return { ok: false, holder };
}

export function unlock(ctx: Ctx, resource: string | undefined, agent: string): void {
  checkName(resource);
  const holder = readJson<Lock>(lockFile(ctx, resource));
  if (!holder) throw new UserError(`${resource} is not locked.`);
  if (holder.agent !== agent) throw new UserError(`${resource} is held by ${holder.agent}.`);
  retire(ctx, resource);
  recordEvent(ctx, 'unlock', { resource });
}
