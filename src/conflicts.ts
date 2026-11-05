import type { Agent, ConflictPair, Ctx, Untested } from './types.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { runGit } from './git.ts';

export interface EffectiveHead {
  sha: string;
  head: string;
  dirty: boolean;
}

export type MergeOutcome =
  | { state: 'unknown'; files: string[]; error: string }
  | { state: 'clean' | 'conflict'; files: string[] };

const treeCache = new Map<string, string>(); // head + diff hash -> stash commit, so an unchanged worktree writes no new objects
const pairCache = new Map<string, MergeOutcome>(); // sha pair -> result

/**
 * The agent's work as a commit, including uncommitted edits to tracked files.
 * `git stash create` touches neither the worktree nor the stash list.
 */
function effectiveHead(worktree: string): EffectiveHead | null {
  const head = runGit(['rev-parse', 'HEAD'], { cwd: worktree });
  if (head.code !== 0) return null;
  const sha = head.out.trim();
  const diff = runGit(['diff', 'HEAD'], { cwd: worktree });
  if (diff.code !== 0 || !diff.out) return { sha, head: sha, dirty: false };
  const key = `${sha}:${createHash('sha1').update(diff.out).digest('hex')}`;
  if (!treeCache.has(key)) {
    const stash = runGit(['stash', 'create'], { cwd: worktree });
    if (stash.code !== 0 || !stash.out.trim()) return { sha, head: sha, dirty: true };
    treeCache.set(key, stash.out.trim());
  }
  return { sha: treeCache.get(key)!, head: sha, dirty: true };
}

/** Exit 1 also means a bad ref, so a result only counts with a tree id on the first line. */
export function mergeResult(cwd: string, a: string, b: string): MergeOutcome {
  const key = [a, b].sort().join(':');
  if (pairCache.has(key)) return pairCache.get(key)!;
  const result = runGit(['merge-tree', '--write-tree', '--name-only', a, b], { cwd });
  const lines = result.out.split(/\r?\n/);
  let outcome: MergeOutcome;
  if (!/^[0-9a-f]{40,64}$/.test(lines[0] ?? '') || (result.code !== 0 && result.code !== 1)) {
    outcome = { state: 'unknown', files: [], error: result.err.trim() || `exit ${result.code}` };
  } else if (result.code === 0) {
    outcome = { state: 'clean', files: [] };
  } else {
    const end = lines.indexOf('', 1);
    outcome = { state: 'conflict', files: lines.slice(1, end === -1 ? undefined : end) };
  }
  if (outcome.state !== 'unknown') pairCache.set(key, outcome);
  return outcome;
}

export function sweep(ctx: Ctx, agents: Agent[], base: string) {
  const heads = new Map<string, EffectiveHead>();
  const pairs: ConflictPair[] = [];
  const untested: Untested[] = [];
  for (const agent of agents) {
    if (!existsSync(agent.worktree)) {
      untested.push({ who: agent.name, why: 'worktree is gone' });
      continue;
    }
    const effective = effectiveHead(agent.worktree);
    if (effective) heads.set(agent.name, effective);
    else untested.push({ who: agent.name, why: 'cannot read HEAD' });
  }
  const names = [...heads.keys()];
  const test = (a: string, shaA: string, b: string, shaB: string, kind: ConflictPair['kind']) => {
    if (shaA === shaB) return;
    const result = mergeResult(ctx.cwd, shaA, shaB);
    if (result.state === 'unknown') untested.push({ who: `${a} and ${b}`, why: result.error });
    if (result.state === 'conflict') pairs.push({ a, b, kind, files: result.files });
  };
  // Agent against agent comes first. It is the question nothing else answers.
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      test(names[i]!, heads.get(names[i]!)!.sha, names[j]!, heads.get(names[j]!)!.sha, 'cross');
    }
  }
  for (const name of names) test(name, heads.get(name)!.sha, ctx.config.base, base, 'base');
  return { pairs, untested, heads };
}
