import type { Config } from '../types.ts';
import type { Args } from '../types.ts';
import { join } from 'node:path';
import { recordEvent, whoami } from '../context.ts';
import { checkCommit, stagedFiles } from '../guard.ts';
import { readJson, storeOf } from '../store.ts';

/** Called by the git hooks. Git hands us the real staged set, whichever tool or shell made the commit. */
export async function run({ positionals }: Args) {
  const [name] = positionals;
  if (name !== 'pre-commit') return;
  const cwd = process.cwd();
  const store = storeOf(cwd);
  const config = readJson<Config>(join(store, 'config.json'));
  if (!config) return; // not set up in this repo

  const ctx = { cwd, store, config, me: whoami(cwd) };
  let result: ReturnType<typeof checkCommit>;
  try {
    result = checkCommit(ctx, ctx.me, stagedFiles(cwd));
  } catch (error) {
    // Fail closed: a guard that cannot read the facts must not wave a commit through.
    console.error(`zippermerge: could not check this commit: ${(error as Error).message}`);
    process.exit(1);
  }
  for (const warning of result.warnings) console.error(`zippermerge: ${warning}`);
  if (!result.blocks.length) return;
  console.error('zippermerge: commit blocked');
  for (const block of result.blocks) console.error(`  ${block}`);
  recordEvent(ctx, 'blocked', { reasons: result.blocks });
  process.exit(1);
}
