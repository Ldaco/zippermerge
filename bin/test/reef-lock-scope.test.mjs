import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const bashPath = (file) => file.replaceAll('\\', '/');
const shellPath = (file) => process.platform === 'win32'
  ? bashPath(file).replace(/^([A-Z]):/i, (_, drive) => '/' + drive.toLowerCase())
  : file;
const script = bashPath(fileURLToPath(new URL('../../chat.sh', import.meta.url)));
const captureScript = fileURLToPath(new URL('../capture.mjs', import.meta.url));

function ok(result) {
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  return result.stdout;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'zm-reef-lock-'));
  const board = path.join(root, 'board with spaces');
  const dyt = path.join(root, 'dyt checkout');
  const zippermerge = path.join(root, 'zippermerge checkout');
  for (const dir of [board, dyt, zippermerge]) mkdirSync(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:GIT_|ZM_)/i.test(name)));
  Object.assign(env, { CHAT_DIR: bashPath(board), ZM_REPO: bashPath(dyt), ZM_SLUG: 'reader', TMPDIR: root, TMP: root, TEMP: root });
  const options = (cwd) => ({ cwd, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const git = (cwd, ...args) => ok(spawnSync('git', args, options(cwd)));
  const init = (cwd, url) => {
    git(cwd, 'init', '-q', '-b', 'main');
    if (url) git(cwd, 'remote', 'add', 'origin', url);
  };
  init(dyt, 'https://github.com/Ldaco/draw-your-thoughts.git');
  init(zippermerge, 'https://github.com/Ldaco/zippermerge.git');
  const live = [];
  t.after(async () => {
    for (const { child, finished } of live) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await finished;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const chat = (cwd, ...args) => spawnSync('bash', [script, ...args], options(cwd));
  const hook = (cwd, command) => spawnSync(process.execPath, [captureScript, '--block-only'], {
    ...options(cwd),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
  });
  const wait = (cwd, slug, action = 'lock --wait full-test-suite') => {
    const child = spawn('bash', [script, ...action.split(' '), slug, 'fixture'], options(cwd));
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error, stdout, stderr }));
      child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
    const queued = async () => {
      for (let i = 0; i < 200; i++) {
        if (/WAITING/.test(stdout) || child.exitCode !== null) break;
        await delay(50);
      }
      assert.match(stdout, /WAITING/, stderr);
    };
    live.push({ child, finished });
    return { child, finished, queued };
  };
  return { root, board, dyt, zippermerge, git, init, chat, hook, wait };
}

test('the suite lock follows Git repository identity across paths and clones', (t) => {
  const { root, dyt, zippermerge, git, init, chat, hook } = fixture(t);
  const nested = path.join(dyt, 'nested');
  const clone = path.join(root, 'dyt other clone');
  mkdirSync(nested);
  mkdirSync(clone);
  init(clone, 'git@github.com:LDACO/DRAW-YOUR-THOUGHTS.git');
  git(dyt, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const tree = path.join(root, 'dyt worktree');
  git(dyt, 'worktree', 'add', '-q', '--detach', tree);

  assert.match(ok(chat(nested, 'lock', 'full-test-suite', 'owner', 'full suite')), /LOCKED full-test-suite/);
  for (const cwd of [dyt, clone, tree]) {
    assert.equal(chat(cwd, 'lock', 'full-test-suite', 'other', 'same repo').status, 2);
  }
  assert.match(ok(chat(zippermerge, 'lock', 'full-test-suite', 'other', 'different repo')), /LOCKED full-test-suite/);
  assert.match(ok(chat(zippermerge, 'board')), /owner=owner[\s\S]*owner=other|owner=other[\s\S]*owner=owner/);
  assert.equal(chat(clone, 'unlock', 'full-test-suite', 'other').status, 1);

  assert.equal(hook(dyt, 'npm test').status, 2);
  assert.equal(hook(tree, 'npm test').status, 2);
  assert.equal(hook(clone, 'npm test').status, 2);
  assert.equal(hook(dyt, 'npm test -- src/single.test.ts').status, 0);
  assert.equal(hook(zippermerge, 'npm test').status, 0);
  assert.equal(hook(zippermerge, 'npm run build').status, 2);
  assert.equal(hook(dyt, `cd '${shellPath(zippermerge)}' && npm test`).status, 0);
  assert.equal(hook(zippermerge, `env -C '${shellPath(dyt)}' npm test`).status, 2);
  assert.equal(hook(zippermerge, `npm --prefix '${shellPath(dyt)}' test`).status, 2);
  assert.equal(hook(zippermerge, `(cd '${shellPath(dyt)}' && npm test); npm test`).status, 2);

  assert.match(ok(chat(zippermerge, 'unlock', '--repo', shellPath(dyt), 'full-test-suite', 'owner')), /UNLOCKED/);
  assert.equal(hook(dyt, 'npm run build').status, 0);
  assert.equal(hook(zippermerge, 'npm run build').status, 2);
  assert.match(ok(chat(dyt, 'lock', 'full-test-suite', 'owner')), /LOCKED full-test-suite/);
});

test('parallel waiters acquire in FIFO order and a killed waiter cannot stop hand-off', async (t) => {
  const { board, dyt, zippermerge, chat, wait } = fixture(t);
  ok(chat(dyt, 'lock', 'full-test-suite', 'owner', 'long suite'));
  const locks = path.join(board, 'locks');
  const file = path.join(locks, readdirSync(locks).find((name) => name.endsWith('.md')));
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace(/^since_epoch: \d+$/m, 'since_epoch: 1000'));
  const first = wait(dyt, 'z-first');
  await first.queued();
  const abandoned = wait(dyt, 'abandoned');
  await abandoned.queued();
  const last = wait(dyt, 'a-last');
  await last.queued();

  const status = ok(chat(dyt, 'board'));
  assert.match(status, /LOCK HELD:.*owner=owner.*age=\d+ min/);
  assert.match(status, /WARNING:.*60 min/);
  assert.match(status, /LOCK WAITING:.*z-first[\s\S]*LOCK WAITING:.*abandoned[\s\S]*LOCK WAITING:.*a-last/);
  assert.doesNotMatch(status, /LOCK HELD:.*owner=(?:z-first|abandoned|a-last)/);
  assert.match(ok(chat(zippermerge, 'lock', 'full-test-suite', 'independent', 'other repo')), /LOCKED/);

  abandoned.child.kill('SIGKILL');
  await abandoned.finished;
  ok(chat(dyt, 'unlock', 'full-test-suite', 'owner'));
  assert.equal(chat(dyt, 'lock', 'full-test-suite', 'latecomer', 'must not cut in').status, 2);
  assert.match(ok(await first.finished), /LOCKED full-test-suite/);
  assert.equal(last.child.exitCode, null);
  ok(chat(dyt, 'unlock', 'full-test-suite', 'z-first'));
  assert.match(ok(await last.finished), /LOCKED full-test-suite/);
  assert.doesNotMatch(ok(chat(dyt, 'board')), /LOCK WAITING:|abandoned/);
});

test('simultaneous nonblocking requests produce one owner in an unconfigured local repo', async (t) => {
  const { root, chat, init, wait } = fixture(t);
  const repo = path.join(root, 'local repo');
  mkdirSync(repo);
  init(repo);
  const slugs = ['one', 'two', 'three'];
  const results = await Promise.all(slugs.map((slug) => wait(repo, slug, 'lock full-test-suite').finished));
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 2, 2]);
  const owner = slugs[results.findIndex(({ status }) => status === 0)];
  assert.match(ok(chat(repo, 'board')), new RegExp('LOCK HELD:.*owner=' + owner));
  assert.match(ok(chat(repo, 'unlock', 'full-test-suite', owner)), /UNLOCKED/);
});
