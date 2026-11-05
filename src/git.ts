import { spawnSync } from 'node:child_process';

// Git sets these inside hooks. Left in place they would point commands
// aimed at another worktree back at this one.
const HOOK_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
];

export interface GitOptions {
  cwd?: string;
  inherit?: boolean;
}

export interface GitResult {
  code: number | null;
  out: string;
  err: string;
}

export function runGit(args: string[], { cwd, inherit = false }: GitOptions = {}): GitResult {
  const env = { ...process.env };
  if (!inherit) for (const name of HOOK_ENV) delete env[name];
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    code: result.status,
    out: result.stdout ?? '',
    err: result.stderr ?? (result.error ? String(result.error) : ''),
  };
}

export function git(args: string[], options?: GitOptions): string {
  const result = runGit(args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.err.trim() || `exit ${result.code}`}`);
  }
  return result.out.replace(/\r?\n$/, '');
}
