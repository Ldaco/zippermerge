import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('npm test discovers the merge queue and PR nudge suites', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'zippermerge-suite-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const testDir = path.join(root, 'bin', 'test');
  const chat = path.join(root, 'chat');
  const repo = path.join(root, 'repo');
  mkdirSync(testDir, { recursive: true });
  mkdirSync(chat);
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  copyFileSync(new URL('../../package.json', import.meta.url), path.join(root, 'package.json'));
  for (const name of ['capture-next', 'merge-queue', 'pr-nudge']) {
    writeFileSync(path.join(testDir, `${name}.test.mjs`), `console.log('ran ${name}')\n`);
  }
  const env = { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '' };
  // The nested Node runner needs its own reporter rather than the parent's IPC stream.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('npm test', { cwd: root, env, shell: true, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stdout, /ran merge-queue/);
  assert.match(run.stdout, /ran pr-nudge/);
});
