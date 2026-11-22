import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');
const config = JSON.stringify(new URL('../config.mjs', import.meta.url).href);
const bash = promisify(execFile);

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zm-chat-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const board = path.join(dir, 'board');
  const repo = path.join(dir, 'scratch-repo');
  const remote = path.join(dir, 'scratch-origin');
  const bin = path.join(dir, 'bin');
  for (const p of [board, bin]) mkdirSync(p);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|ZM_|PATH$)/i.test(key)));
  env.PATH = process.env.PATH;
  const chatEnv = { CHAT_DIR: board.replaceAll('\\', '/'), ZM_REPO: repo, ZM_MIG_DIR: 'migs' };
  const chatOptions = (extra) => ({ cwd: dir, env: { ...env, ...chatEnv, ...extra }, encoding: 'utf8', timeout: 12000 });
  const chat = (args, extra) => spawnSync('bash', [script, ...args], chatOptions(extra));
  const chatAsync = (args, extra) => bash('bash', [script, ...args], chatOptions(extra));
  const git = (...args) => ok(spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' }));
  const runNode = (code, extra) => ok(spawnSync(process.execPath, ['--input-type=module', '-e', code], chatOptions(extra)));
  const initRepo = (migration) => {
    git('init', '--bare', remote);
    git('init', '-b', 'main', repo);
    mkdirSync(path.join(repo, 'migs'));
    writeFileSync(path.join(repo, 'migs', migration), '');
    git('-C', repo, 'add', '.');
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    git('-C', repo, 'remote', 'add', 'origin', remote);
    git('-C', repo, 'push', 'origin', 'main');
  };
  const timestamp = '20261122T000000Z';
  const clock = (epoch) => ({ PATH: `${bin}${path.delimiter}${env.PATH}`, TEST_EPOCH: String(epoch) });
  writeFileSync(path.join(bin, 'date'), `#!/usr/bin/env bash
case "$2" in
  +%s)
    if [ -n "\${TEST_PAUSE:-}" ]; then
      : > "$CHAT_DIR/paused"
      while [ ! -f "$CHAT_DIR/resume" ]; do sleep 0.05; done
    fi
    printf '%s\\n' "$TEST_EPOCH"
    ;;
  +%Y%m%dT%H%M%SZ) printf '%s\\n' '${timestamp}' ;;
  +%Y-%m-%dT%H:%M:%SZ) printf '%s\\n' '2026-11-22T00:00:00Z' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return { board, repo, chat, chatAsync, git, runNode, initRepo, timestamp, clock };
}

function ok(result) {
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}${result.stderr}`);
  return result.stdout;
}

function rejected(result, message) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, message);
}

test('migration claims require a fresh origin/main and an existing migration directory', (t) => {
  const { board, repo, chat, git, initRepo } = fixture(t);
  initRepo('0010_first.sql');
  rejected(chat(['migration', 'agent', 'next', 'ref'], { ZM_MIG_DIR: 'missing' }), /migration directory/i);
  rejected(chat(['claim-number', 'agent', '11', 'next', 'ref'], { ZM_MIG_DIR: 'missing' }), /migration directory/i);
  git('-C', repo, 'remote', 'set-url', 'origin', path.join(board, 'unreachable'));
  rejected(chat(['migration', 'agent', 'next', 'ref']), /fetch/i);
  git('-C', repo, 'remote', 'rename', 'origin', 'renamed');
  rejected(chat(['claim-number', 'agent', '11', 'next', 'ref']), /fetch/i);
  assert.deepEqual(readdirSync(path.join(board, 'claims')), []);
  rejected(chat(['migration', 'agent', 'next', 'ref'], { ZM_REPO: path.join(board, 'missing-repo') }), /fetch/i);
});

test('an existing migration directory with no numbered files starts at 001', (t) => {
  const { chat, initRepo } = fixture(t);
  initRepo('.gitkeep');
  assert.match(ok(chat(['migration', 'agent', 'first', 'ref'])), /CLAIMED 001/);
});

test('claim-number rejects overflow and large gaps without carrying forward historical outliers', (t) => {
  const { board, chat, initRepo } = fixture(t);
  initRepo('0010_first.sql');
  rejected(chat(['claim-number', 'agent', '99999999999999999999', 'next', 'ref']), /digits/i);
  rejected(chat(['claim-number', 'agent', '5000', 'next', 'ref']), /50/i);
  assert.deepEqual(readdirSync(path.join(board, 'claims')), []);
  writeFileSync(path.join(board, 'claims', 'migration-5000.md'), 'owner: agent\n');
  writeFileSync(path.join(board, 'claims', 'migration-7766279631452241919.md'), 'owner: agent\n');
  assert.match(ok(chat(['migration', 'agent', 'next', 'ref'])), /CLAIMED 011 \(origin\/main max 10/);
  assert.match(ok(chat(['claim-number', 'agent', '000061', 'later', 'ref'])), /CLAIMED 061/);
  assert.match(ok(chat(['claim-number', 'agent', '61', 'later', 'ref'])), /ALREADY YOURS 061/);
  assert.match(ok(chat(['migration', 'agent', 'after', 'ref'])), /CLAIMED 062/);
});

test('Bash and Node agree on config.env and preserve explicit environment values', (t) => {
  const { board, repo, chat, runNode, initRepo } = fixture(t);
  initRepo('009_first.sql');
  writeFileSync(path.join(board, 'config.env'), `\uFEFF  ZM_HUMAN=  'boss'  \r\n  ZM_REPO="${repo.replaceAll('\\', '/')}"\r\n  ZM_MIG_DIR=migs/\r\nZM_PR_REPO= project/repo # literal`);
  const fromFile = { ZM_REPO: undefined, ZM_MIG_DIR: undefined };
  rejected(chat(['post', 'boss', 'note', 'test'], fromFile), /slug 'boss' is reserved/);
  assert.match(ok(chat(['migration', 'agent', 'next', 'ref'], fromFile)), /CLAIMED 010 .* create migs\/010_next.sql/);
  const load = `import { REPO, MIG_DIR, HUMAN, PR_REPO } from ${config};
    console.log(JSON.stringify([REPO, MIG_DIR, HUMAN, PR_REPO]));`;
  assert.deepEqual(JSON.parse(runNode(load, fromFile)), [repo.replaceAll('\\', '/'), 'migs', 'boss', 'project/repo # literal']);
  rejected(chat(['post', 'override', 'note', 'test'], { ...fromFile, ZM_HUMAN: 'override' }), /slug 'override' is reserved/);
  assert.equal(JSON.parse(runNode(load, { ...fromFile, ZM_HUMAN: 'override' }))[2], 'override');
});

test('Node uses a Windows-native ZM_REPO when config.env contains a Git Bash path', { skip: process.platform !== 'win32' }, (t) => {
  const { board, repo, runNode, initRepo } = fixture(t);
  initRepo('009_first.sql');
  const slashRepo = repo.replaceAll('\\', '/');
  const msysRepo = slashRepo.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`);
  writeFileSync(path.join(board, 'config.env'), `ZM_REPO=${msysRepo}\n`);
  const load = `import { execFileSync } from 'node:child_process';
    import { REPO } from ${config};
    console.log(execFileSync('git', ['-C', REPO, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());`;
  assert.equal(runNode(load, { ZM_REPO: undefined }).trim(), slashRepo);
});

test('same-second lock and reservation releases preserve every history record', (t) => {
  const { board, chat, clock, timestamp } = fixture(t);
  const stale = clock(1000);
  const now = clock(5000);
  for (let i = 0; i < 2; i++) {
    ok(chat(['lock', 'main-freeze', 'agent', `release ${i}`], now));
    ok(chat(['unlock', 'main-freeze', 'agent'], now));
    ok(chat(['lock', 'main-freeze', 'agent', `break ${i}`], stale));
    ok(chat(['break', 'main-freeze', 'other'], now));
    const id = `${timestamp}_agent`;
    ok(chat(['reserve', 'agent', 'file', `reservation ${i}`], now));
    ok(chat(['unreserve', 'agent', id], now));
  }
  for (const [history, reason] of [['locks/released', 'release'], ['locks/broken', 'break'], ['reservations/released', 'reservation']]) {
    const dir = path.join(board, history);
    const reasons = readdirSync(dir).map((file) => /^why: (.*)$/m.exec(readFileSync(path.join(dir, file), 'utf8'))?.[1]);
    assert.deepEqual(reasons.sort(), [`${reason} 0`, `${reason} 1`], history);
  }
});

test('a break racing a handoff cannot remove the fresh lock', async (t) => {
  const { board, chat, chatAsync, clock } = fixture(t);
  ok(chat(['lock', 'main-freeze', 'old', 'stale'], clock(1000)));
  const now = clock(5000);
  const breaker = chatAsync(['break', 'main-freeze', 'breaker'], { ...now, TEST_PAUSE: '1' });
  try {
    for (let i = 0; i < 100 && !existsSync(path.join(board, 'paused')); i++) await delay(50);
    assert.ok(existsSync(path.join(board, 'paused')), 'break reached the age check');
    const handoff = (async () => {
      try {
        await chatAsync(['unlock', 'main-freeze', 'old'], now);
      } catch (error) {
        assert.match(error.stderr, /not held/);
      }
      return chatAsync(['lock', 'main-freeze', 'new', 'fresh'], now);
    })();
    await Promise.race([handoff, delay(2000)]);
    writeFileSync(path.join(board, 'resume'), '');
    const [broken] = await Promise.all([breaker, handoff]);
    assert.match(broken.stdout, /held by old/);
    rejected(chat(['break', 'main-freeze', 'breaker'], now), /only 0 min old/);
    assert.match(ok(chat(['unlock', 'main-freeze', 'new'], now)), /UNLOCKED/);
  } finally {
    writeFileSync(path.join(board, 'resume'), '');
    await breaker.catch(() => {});
  }
});
