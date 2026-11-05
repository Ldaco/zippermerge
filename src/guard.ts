import type { Ctx } from './types.ts';
import { baseRef } from './context.ts';
import { runGit } from './git.ts';
import { claimFor, migrationsAt, noteClaimFile, parseMigration } from './migrations.ts';

/** What is really staged, read from the index git is about to commit. */
export interface StagedFile {
  status: string;
  path: string;
}

export function stagedFiles(cwd: string): StagedFile[] {
  // inherit: during `git commit -a` git points GIT_INDEX_FILE at a temporary index.
  const result = runGit(['diff', '--cached', '--name-status', '--no-renames', '-z'], { cwd, inherit: true });
  if (result.code !== 0) throw new Error(`Cannot read the staged files: ${result.err.trim()}`);
  const parts = result.out.split('\0').filter(Boolean);
  const files: StagedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
  return files;
}

/** Returns { blocks: string[], warnings: string[] } for a commit by `me`. */
export function checkCommit(ctx: Ctx, me: string | null, files: StagedFile[]): { blocks: string[]; warnings: string[] } {
  const blocks: string[] = [];
  const warnings: string[] = [];
  if (!me) {
    warnings.push('No agent identity in this worktree, so checks are advisory. Agents should run: zippermerge join <name>');
  }

  const { migrations } = ctx.config;
  if (migrations) {
    const prefix = `${migrations.dir}/`;
    const added = files.filter((f) => f.status === 'A' && f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'));
    if (added.length) {
      const onBase = migrationsAt(ctx, baseRef(ctx));
      const baseMax = Math.max(0, ...onBase.map((m) => m.number));
      for (const { path } of added) {
        const parsed = parseMigration(ctx.config, path);
        if (!parsed) continue;
        const claim = claimFor(ctx, parsed.number);
        if (parsed.number <= baseMax) {
          blocks.push(`${parsed.file}: ${ctx.config.base} is already at ${baseMax}. Run: zippermerge claim <slug>, and rename.`);
        } else if (!claim) {
          blocks.push(`${parsed.file}: nobody claimed ${parsed.number}. Run: zippermerge claim <slug>, and use the number it gives you.`);
        } else if (me && claim.agent !== me) {
          blocks.push(`${parsed.file}: ${parsed.number} belongs to ${claim.agent}. Run: zippermerge claim <slug>.`);
        } else if (claim.file !== parsed.file) {
          noteClaimFile(ctx, claim, parsed.file);
        }
      }
    }
  }

  return { blocks, warnings };
}
