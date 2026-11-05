import type { Ctx, Reservation } from './types.ts';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { UserError } from './errors.ts';
import { globToRegex } from './glob.ts';
import { listJson, writeExclusive } from './store.ts';

const dir = (ctx: Ctx) => join(ctx.store, 'reservations');
const fileFor = (ctx: Ctx, glob: string) => join(dir(ctx), `${createHash('sha1').update(glob).digest('hex').slice(0, 16)}.json`);

export function loadReservations(ctx: Ctx): Reservation[] {
  const now = Date.now();
  return listJson<Reservation>(dir(ctx)).filter((r) => Date.parse(r.expiresAt) > now);
}

/** Two globs overlap if either could match the other's literal prefix. Deliberately cautious. */
function overlaps(a: string, b: string): boolean {
  const prefix = (glob: string) => glob.split('*')[0]!;
  return prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a));
}

export interface NewReservation {
  agent: string;
  glob: string;
  exclusive?: boolean | undefined;
  why?: string | undefined;
  ttlMs: number;
}

export function reserve(ctx: Ctx, { agent, glob, exclusive, why, ttlMs }: NewReservation): Reservation {
  globToRegex(glob);
  const now = Date.now();
  // Expired records are dead weight. Clearing them here keeps the exclusive create below honest.
  for (const old of listJson<Reservation>(dir(ctx))) {
    if (Date.parse(old.expiresAt) <= now) rmSync(fileFor(ctx, old.glob), { force: true });
  }
  const others = loadReservations(ctx).filter((r) => r.agent !== agent);
  const clash = others.find((r) => (exclusive || r.exclusive) && overlaps(r.glob, glob));
  if (clash) throw new UserError(`${glob} overlaps ${clash.agent}'s reservation on ${clash.glob}.`);
  const record = { glob, agent, exclusive: Boolean(exclusive), why: why ?? '', ts: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
  if (!writeExclusive(fileFor(ctx, glob), record)) {
    throw new UserError(`${glob} was reserved a moment ago. Check: zippermerge reservations`);
  }
  return record;
}

export function unreserve(ctx: Ctx, agent: string, glob: string | undefined): void {
  const mine = loadReservations(ctx).find((r) => r.glob === glob && r.agent === agent);
  if (!mine) throw new UserError(`You hold no reservation on ${glob}.`);
  rmSync(fileFor(ctx, mine.glob), { force: true });
}
