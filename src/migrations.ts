import type { Claim, Config, Ctx } from './types.ts';
import { basename, join } from 'node:path';
import { baseRef } from './context.ts';
import { UserError } from './errors.ts';
import { git } from './git.ts';
import { listJson, readJson, writeExclusive, writeAtomic } from './store.ts';
import { renameSync, mkdirSync } from 'node:fs';

const claimsDir = (ctx: Ctx) => join(ctx.store, 'claims');

export interface ParsedMigration {
  file: string;
  number: number;
  digits: number;
}

export function parseMigration(config: Config, file: string): ParsedMigration | null {
  const match = new RegExp(config.migrations!.pattern).exec(basename(file));
  return match ? { file: basename(file), number: Number(match[1]), digits: match[1]!.length } : null;
}

/** Throws if the ref cannot be read, so nothing allocates from a guess. */
export function migrationsAt(ctx: Ctx, ref: string): ParsedMigration[] {
  const { dir } = ctx.config.migrations!;
  return git(['ls-tree', '--name-only', ref, '--', `${dir}/`], { cwd: ctx.cwd })
    .split('\n')
    .filter(Boolean)
    .map((file) => parseMigration(ctx.config, file))
    .filter((migration): migration is ParsedMigration => Boolean(migration));
}

export function loadClaims(ctx: Ctx): Claim[] {
  return listJson<Claim>(claimsDir(ctx));
}

export function claimNumber(ctx: Ctx, agent: string, slug: string | undefined): Claim {
  if (!ctx.config.migrations) throw new UserError('No migrations configured. Run: zippermerge init --force --migrations <dir>');
  if (!slug || !/^[a-z0-9_-]+$/i.test(slug)) throw new UserError('Usage: zippermerge claim <slug>, letters, digits, _ and -.');
  const onBase = migrationsAt(ctx, baseRef(ctx));
  const width = Math.max(3, ...onBase.map((m) => m.digits));
  let number = Math.max(0, ...onBase.map((m) => m.number), ...loadClaims(ctx).map((c) => c.number)) + 1;
  for (;;) {
    const padded = String(number).padStart(width, '0');
    const claim: Claim = {
      number,
      agent,
      slug,
      file: `${padded}_${slug}.sql`,
      path: `${ctx.config.migrations.dir}/${padded}_${slug}.sql`,
      ts: new Date().toISOString(),
    };
    if (writeExclusive(join(claimsDir(ctx), `${padded}.json`), claim)) return claim;
    number += 1; // someone else won this number between our read and our write
  }
}

export function claimFor(ctx: Ctx, number: number): Claim | null {
  return loadClaims(ctx).find((claim) => claim.number === number) ?? null;
}

export function noteClaimFile(ctx: Ctx, claim: Claim, file: string): void {
  const name = `${String(claim.number).padStart(file.split('_')[0]!.length, '0')}.json`;
  const current = readJson<Claim>(join(claimsDir(ctx), name));
  if (current) writeAtomic(join(claimsDir(ctx), name), { ...current, file });
}

export function releaseClaim(ctx: Ctx, agent: string, number: number): void {
  const claim = claimFor(ctx, number);
  if (!claim) throw new UserError(`No claim on ${number}.`);
  if (claim.agent !== agent) throw new UserError(`${number} belongs to ${claim.agent}.`);
  const released = join(claimsDir(ctx), 'released');
  mkdirSync(released, { recursive: true });
  const name = `${claim.file.split('_')[0]}.json`;
  renameSync(join(claimsDir(ctx), name), join(released, `${name.replace('.json', '')}-${Date.now()}.json`));
}
