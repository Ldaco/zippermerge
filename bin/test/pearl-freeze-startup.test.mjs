import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../guard.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'pearl-freeze-startup-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const repo = path.join(root, 'repo');
  const chat = path.join(root, 'chat');
  mkdirSync(path.join(chat, 'locks'), { recursive: true });
  writeFileSync(path.join(chat, 'locks', 'main-freeze.md'), 'owner: alpha\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(GIT_|ZM_)/i.test(key)) delete env[key];
  Object.assign(env, { CHAT_DIR: chat, ZM_REPO: repo, ZM_SLUG: 'beta', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') });
  execFileSync('git', ['init', '-qb', 'main', repo], { env });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env });
  function check(command, expected) {
    const input = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } });
    const result = spawnSync(process.execPath, [guard, 'hook'], { input, env, encoding: 'utf8', cwd: repo });
    assert.ifError(result.error);
    assert.equal(result.status, expected, command + '\n' + result.stderr);
    if (expected === 2) assert.match(result.stderr, /main-freeze is held by alpha/, command);
  }
  return { git, check };
}

test('worktree add checks the -b branch in either option position', t => {
  const { check } = fixture(t);
  for (const args of ['../w2 -b w2', '-b feature/topic "../topic tree" main', '../main main -b topic']) {
    check('git worktree add ' + args, 0);
  }
});

test('protected worktree destinations and ambiguous options stay blocked', t => {
  const { git, check } = fixture(t);
  git('symbolic-ref', 'refs/heads/alias-main', 'refs/heads/main');
  for (const args of ['-b main ../w', '../w -b MAIN', '-b alias-main ../w', '-B main ../w',
    '-b topic ../w -B main', '-b topic ../w -b main', '-- ../main -b topic']) {
    check('git worktree add ' + args, 2);
  }
});

test('standard Git LFS downloads and inspection are allowed under a freeze', t => {
  const { check } = fixture(t);
  for (const args of ['pull', 'pull origin', 'fetch origin main', 'ls-files --long', 'status', 'env', 'version']) {
    check('git lfs ' + args, 0);
  }
});

test('LFS writes, unknown verbs and configured aliases stay conservative', t => {
  const { git, check } = fixture(t);
  for (const args of ['push origin main', 'migrate import', 'prune', 'fetch --prune', 'track "*.bin"',
    'install', 'unknown']) check('git lfs ' + args, 2);
  check('git notes add', 2);
  check('git -c alias.lfs=status lfs pull', 2);
  git('config', 'alias.lfs', 'status');
  check('git lfs pull', 2);
});
