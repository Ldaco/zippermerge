import type { Config } from '../types.ts';
import type { Args } from '../types.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../errors.ts';
import { git, runGit } from '../git.ts';
import { storeOf, writeAtomic } from '../store.ts';

export const options = {
  migrations: { type: 'string' },
  pattern: { type: 'string' },
  human: { type: 'string' },
  base: { type: 'string' },
  port: { type: 'string' },
  force: { type: 'boolean' },
};

function detectBase(cwd: string): { remote: string | null; base: string } {
  const head = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
  if (head.code === 0) {
    const [remote, ...branch] = head.out.trim().split('/');
    return { remote: remote ?? null, base: branch.join('/') };
  }
  const hasOrigin = runGit(['remote', 'get-url', 'origin'], { cwd }).code === 0;
  for (const name of ['main', 'master']) {
    if (runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd }).code === 0) {
      return { remote: hasOrigin ? 'origin' : null, base: name };
    }
  }
  return { remote: hasOrigin ? 'origin' : null, base: git(['branch', '--show-current'], { cwd }) };
}

function detectHuman(cwd: string): string {
  const name = runGit(['config', 'user.name'], { cwd }).out.trim().split(/\s+/)[0]?.toLowerCase();
  return name && /^[a-z][a-z0-9-]*$/.test(name) ? name : 'human';
}

export async function run({ values }: Args<{ migrations?: string; pattern?: string; human?: string; base?: string; port?: string; force?: boolean }>) {
  const cwd = process.cwd();
  const store = storeOf(cwd);
  const file = join(store, 'config.json');
  if (existsSync(file) && !values.force) {
    throw new UserError(`Already initialized: ${file}. Use --force to rewrite it.`);
  }
  const detected = detectBase(cwd);
  const config: Config = {
    base: values.base ?? detected.base,
    remote: detected.remote,
    human: values.human ?? detectHuman(cwd),
    port: Number(values.port ?? 4747),
    migrations: values.migrations
      ? { dir: values.migrations.replace(/\\/g, '/').replace(/\/$/, ''), pattern: values.pattern ?? '^(\\d+)_.+\\.sql$' }
      : null,
  };
  mkdirSync(store, { recursive: true });
  writeAtomic(file, config);
  console.log(`Initialized ${store}`);
  console.log(JSON.stringify(config, null, 2));
}
