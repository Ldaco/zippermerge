import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'zm.ts');

export function sh(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}

export function zm(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr };
}

export function zmAsync(cwd: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

export function write(cwd: string, path: string, text: string): void {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A throwaway repo with migrations 001 and 002, and worktrees for each named agent. */
export function makeRepo(agents = ['alpha', 'beta']) {
  const root = mkdtempSync(join(tmpdir(), 'zm-test-'));
  const main = join(root, 'main');
  mkdirSync(main);
  sh(main, 'init', '-b', 'main');
  sh(main, 'config', 'user.name', 'Test');
  sh(main, 'config', 'user.email', 'test@example.invalid');
  write(main, 'db/migrations/001_one.sql', 'select 1;\n');
  write(main, 'db/migrations/002_two.sql', 'select 2;\n');
  write(main, 'docs/notes.md', 'line one\nline two\nline three\n');
  sh(main, 'add', '.');
  sh(main, 'commit', '-m', 'start');
  zm(main, 'init', '--migrations', 'db/migrations', '--human', 'boss', '--port', '0');
  zm(main, 'hooks');
  const worktrees: Record<string, string> = {};
  for (const name of agents) {
    const path = join(root, `wt-${name}`);
    sh(main, 'worktree', 'add', path, '-b', `work/${name}`);
    zm(path, 'join', name);
    worktrees[name] = path;
  }
  return { root, main, worktrees: worktrees as Record<'alpha' | 'beta', string> };
}
