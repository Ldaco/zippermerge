import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../context.ts';
import { runGit } from '../git.ts';

const MARK = '# zippermerge';
const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'zm.ts').replace(/\\/g, '/');

/** Installs into the shared hooks dir, so one install covers every worktree. Existing hooks keep running. */
export async function run() {
  const ctx = context();
  const configured = runGit(['config', 'core.hooksPath'], { cwd: ctx.cwd }).out.trim();
  const repoRoot = dirname(ctx.store);
  const hooksDir = configured ? (isAbsolute(configured) ? configured : resolve(ctx.cwd, configured)) : join(repoRoot, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const file = join(hooksDir, 'pre-commit');
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARK)) {
    renameSync(file, `${file}.zm-chained`);
    console.log(`Kept your existing hook, it now runs first: ${file}.zm-chained`);
  }
  writeFileSync(
    file,
    `#!/bin/sh
${MARK}
chained="$(dirname "$0")/pre-commit.zm-chained"
if [ -x "$chained" ]; then "$chained" "$@" || exit $?; fi
exec node "${bin}" hook pre-commit
`,
  );
  chmodSync(file, 0o755);
  console.log(`Installed ${file}`);
}
