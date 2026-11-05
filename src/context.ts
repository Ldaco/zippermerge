import type { Config, Ctx, ZmEvent } from './types.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors.ts';
import { git, runGit } from './git.ts';
import { appendRecord, readJson, storeOf } from './store.ts';

const IDENTITY_FILE = 'zippermerge-agent';

export function identityFile(cwd: string): string {
  return join(git(['rev-parse', '--absolute-git-dir'], { cwd }), IDENTITY_FILE);
}

/** Identity belongs to the worktree, or to whatever launched the agent. Never to a command argument. */
export function whoami(cwd: string): string | null {
  if (process.env.ZM_AGENT) return process.env.ZM_AGENT;
  try {
    return readFileSync(identityFile(cwd), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function context(cwd = process.cwd()): Ctx {
  const store = storeOf(cwd);
  const config = readJson<Config>(join(store, 'config.json'));
  if (!config) throw new UserError('Not initialized here. Run: zippermerge init');
  return { cwd, store, config, me: whoami(cwd) };
}

export function requireAgent(ctx: Ctx): string {
  if (!ctx.me) throw new UserError('No agent identity in this worktree. Run: zippermerge join <name>');
  if (ctx.me === ctx.config.human) throw new UserError(`Agents cannot act as ${ctx.config.human}.`);
  return ctx.me;
}

export function validName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(name);
}

/** The branch work lands on, preferring the remote's copy when there is one. */
export function baseRef(ctx: Ctx): string {
  const { remote, base } = ctx.config;
  if (remote) {
    const ref = `refs/remotes/${remote}/${base}`;
    if (runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: ctx.cwd }).code === 0) return ref;
  }
  return `refs/heads/${base}`;
}

export function recordEvent(ctx: Ctx, type: string, data: Partial<ZmEvent> = {}) {
  return appendRecord(join(ctx.store, 'events'), { agent: ctx.me ?? null, type, ...data });
}
