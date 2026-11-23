import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');
const config = JSON.stringify(new URL('../config.mjs', import.meta.url).href);
const guardScript = fileURLToPath(new URL('../guard.mjs', import.meta.url));
const captureScript = fileURLToPath(new URL('../capture.mjs', import.meta.url));
const bash = promisify(execFile);
const msysPath = (p) => p.replaceAll('\\', '/').replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`);

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
  const node = (args, extra, input) => spawnSync(process.execPath, args, { ...chatOptions(extra), input });
  const runNode = (code, extra) => ok(node(['--input-type=module', '-e', code], extra));
  const capture = (event, extra) => node([captureScript], { TEMP: board, TMP: board, ZM_SLUG: 'agent', ...extra }, JSON.stringify(event));
  const initRepo = (...migrations) => {
    git('init', '--bare', remote);
    git('init', '-b', 'main', repo);
    mkdirSync(path.join(repo, 'migs'));
    for (const migration of migrations) writeFileSync(path.join(repo, 'migs', migration), '');
    git('-C', repo, 'add', '.');
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    git('-C', repo, 'remote', 'add', 'origin', remote);
    git('-C', repo, 'push', 'origin', 'main');
  };
  const advanceMain = (migration) => {
    const behind = git('-C', repo, 'rev-parse', 'refs/remotes/origin/main').trim();
    writeFileSync(path.join(repo, 'migs', migration), '');
    git('-C', repo, 'add', '.');
    git('-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'advance main');
    git('-C', repo, 'push', 'origin', 'main');
    const latest = git('-C', repo, 'rev-parse', 'refs/heads/main').trim();
    git('-C', repo, 'update-ref', 'refs/remotes/origin/main', behind);
    return { behind, latest };
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
  return { board, repo, chat, chatAsync, git, node, runNode, capture, initRepo, advanceMain, timestamp, clock };
}

function ok(result) {
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}${result.stderr}`);
  return result.stdout;
}

function rejected(result, message) {
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, message);
}

function capturedEvents(board) {
  const activity = path.join(board, 'activity');
  if (!existsSync(activity)) return [];
  return readdirSync(activity).sort().flatMap((day) =>
    readFileSync(path.join(activity, day, 'agent.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
}

async function waitForPause(board) {
  const paused = path.join(board, 'paused');
  for (let i = 0; i < 100 && !existsSync(paused); i++) await delay(50);
  assert.ok(existsSync(paused), 'break reached the age check');
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

test('concurrent migration claims use fresh main while the shared tracking ref is locked', async (t) => {
  const { board, repo, chatAsync, git, initRepo, advanceMain } = fixture(t);
  initRepo('010_first.sql');
  const { behind } = advanceMain('024_latest.sql');
  const fetchHead = path.join(repo, '.git', 'FETCH_HEAD');
  const previousFetch = `${behind}\t\tbranch 'main' of origin\n`;
  writeFileSync(fetchHead, previousFetch);
  // Hold Git's tracking-ref lock as a concurrent fetch would while updating the stale ref.
  writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');

  const claims = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    chatAsync(['migration', `agent${i}`, `item_${i}`, 'ref'])));
  const failures = claims.filter(({ status }) => status === 'rejected');
  assert.deepEqual(failures.map(({ reason }) => reason.stderr), []);
  for (const { value } of claims) assert.match(value.stdout, /origin\/main max 24/);
  assert.deepEqual(readdirSync(path.join(board, 'claims')).sort(), Array.from({ length: 8 }, (_, i) =>
    `migration-${String(i + 25).padStart(3, '0')}.md`));
  assert.equal(git('-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/zippermerge/claim-main').trim(), '');
  assert.equal(readFileSync(fetchHead, 'utf8'), previousFetch);
});

test('both migration commands refresh origin/main and FETCH_HEAD for the guard and dashboard', (t) => {
  const { repo, chat, git, initRepo, advanceMain } = fixture(t);
  initRepo('010_first.sql');
  const { behind, latest } = advanceMain('024_latest.sql');
  const fetchHead = path.join(repo, '.git', 'FETCH_HEAD');
  for (const [args, number] of [
    [['migration', 'agent', 'next', 'ref'], '025'],
    [['claim-number', 'agent', '26', 'later', 'ref'], '026'],
  ]) {
    git('-C', repo, 'update-ref', 'refs/remotes/origin/main', behind);
    rmSync(fetchHead, { force: true });
    assert.match(ok(chat(args)), new RegExp(`CLAIMED ${number}`));
    const tracking = git('-C', repo, 'rev-parse', 'refs/remotes/origin/main').trim();
    const fetched = existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8').split('\t')[0] : '';
    assert.deepEqual({ tracking, fetched }, { tracking: latest, fetched: latest });
    assert.equal(git('-C', repo, 'rev-parse', 'FETCH_HEAD').trim(), latest);
  }
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

test('both migration commands warn about and skip prefixes above the supported range on main', (t) => {
  const { chat, initRepo } = fixture(t);
  const outliers = ['1000000_over.sql', '20240101120000_timestamp.sql', '999999999999999999999999_huge.sql'];
  initRepo('000000000000024_latest.sql', ...outliers);
  for (const [args, claimed] of [
    [['migration', 'agent', 'next', 'ref'], /CLAIMED 025 \(origin\/main max 24/],
    [['claim-number', 'agent', '26', 'later', 'ref'], /CLAIMED 026/],
  ]) {
    const result = chat(args);
    assert.match(ok(result), claimed);
    for (const outlier of outliers) assert.ok(result.stderr.includes(outlier), result.stderr);
    assert.match(result.stderr, /warning/i);
  }
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
  writeFileSync(path.join(board, 'config.env'), `ZM_REPO=${msysPath(repo)}\n`);
  const load = `import { execFileSync } from 'node:child_process';
    import { REPO } from ${config};
    console.log(execFileSync('git', ['-C', REPO, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());`;
  const top = runNode(load, { ZM_REPO: undefined }).trim();
  assert.equal(realpathSync.native(top).toLowerCase(), realpathSync.native(repo).toLowerCase());
});

test('Windows repo aliases stay in scope for the guard and capture hook', { skip: process.platform !== 'win32' }, (t) => {
  const { board, repo, git, node, capture, initRepo } = fixture(t);
  initRepo('009_first.sql');
  const top = realpathSync.native(repo);
  // Junctions exercise alias resolution even when NTFS short-name creation is disabled.
  const alias = path.join(board, 'repo-alias');
  symlinkSync(top, alias, 'junction');
  writeFileSync(path.join(board, 'config.env'), `ZM_REPO=${alias}\n`);
  const edited = ['migs/001_Duplicate.sql', 'migs/New/Nested.sql'];
  writeFileSync(path.join(repo, edited[0]), '');
  git('-C', repo, 'add', edited[0]);

  const env = { ZM_REPO: undefined };
  const guard = node([guardScript, 'check', '--cwd', top], env);
  assert.equal(guard.status, 2, guard.stdout + guard.stderr);
  assert.match(guard.stdout, /at or below origin\/main/);

  const reservations = path.join(board, 'reservations');
  mkdirSync(reservations);
  writeFileSync(path.join(reservations, 'other.md'), `owner: other\npattern: migs/**\nexpires_epoch: ${Math.floor(Date.now() / 1000) + 600}\n`);
  const warnings = edited.map((rel) => ok(capture({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: alias, session_id: 'windows-alias',
    tool_input: { file_path: path.join(alias, rel) },
  }, env)));
  assert.deepEqual(capturedEvents(board).map(({ file }) => file), edited);
  for (const [i, rel] of edited.entries()) assert.ok(warnings[i].includes(`${rel} is reserved by other`), warnings[i]);
});

test('capture accepts a Windows Git Bash ZM_REPO_COMMON override', { skip: process.platform !== 'win32' }, (t) => {
  const { board, repo, capture, initRepo } = fixture(t);
  initRepo('009_first.sql');
  ok(capture({ hook_event_name: 'Stop', cwd: realpathSync.native(repo), session_id: 'windows-common' },
    { ZM_REPO_COMMON: msysPath(path.join(repo, '.git')) }));
  assert.deepEqual(capturedEvents(board).map(({ event }) => event), ['stop']);
});

test('Windows Git Bash working directories and file paths work in guard and capture', { skip: process.platform !== 'win32' }, (t) => {
  const { board, repo, git, node, capture, initRepo } = fixture(t);
  initRepo('009_first.sql');
  const rel = 'migs/001_duplicate.sql';
  writeFileSync(path.join(repo, rel), '');
  git('-C', repo, 'add', rel);
  const cwd = msysPath(repo);
  const guard = node([guardScript, 'check', '--cwd', cwd]);
  const hook = node([guardScript, 'hook'], {}, JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command: 'git commit -m test' } }));
  ok(capture({ hook_event_name: 'Stop', cwd, session_id: 'windows-cwd' }));
  ok(capture({
    hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd, session_id: 'windows-cwd',
    tool_input: { file_path: `${cwd}/${rel}` },
  }));

  const events = capturedEvents(board);
  assert.deepEqual([guard.status, hook.status, events.map(({ event }) => event)], [2, 2, ['stop', 'edit']]);
  assert.equal(events[1].file, rel);
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

test('abandoned change gates do not block lock acquisition, release, or stale-lock recovery', (t) => {
  const { board, chat, clock } = fixture(t);
  const now = clock(5000);
  const locks = path.join(board, 'locks');
  mkdirSync(locks);
  mkdirSync(path.join(locks, '.main-freeze.change'));
  mkdirSync(path.join(locks, '.full-test-suite.change'));

  assert.match(ok(chat(['lock', 'main-freeze', 'agent', 'new lock'], now)), /LOCKED main-freeze/);
  assert.match(ok(chat(['unlock', 'main-freeze', 'agent'], now)), /UNLOCKED main-freeze/);
  writeFileSync(path.join(locks, 'full-test-suite.md'), 'owner: old\nsince_epoch: 1000\n');
  assert.match(ok(chat(['break', 'full-test-suite', 'agent'], now)), /held by old/);
});

test('a force-killed gate holder leaves the stale lock recoverable', async (t) => {
  const { board, chat, chatAsync, clock } = fixture(t);
  ok(chat(['lock', 'main-freeze', 'old', 'stale'], clock(1000)));
  const now = clock(5000);
  const owner = chatAsync(['break', 'main-freeze', 'interrupted'], { ...now, TEST_PAUSE: '1' });
  const outcome = owner.catch((error) => error);
  try {
    await waitForPause(board);
    assert.ok(owner.child.kill('SIGKILL'));
  } finally {
    writeFileSync(path.join(board, 'resume'), '');
    await outcome;
  }
  assert.equal((await outcome).signal, 'SIGKILL');
  assert.match(ok(chat(['break', 'main-freeze', 'recovery'], now)), /held by old/);
  assert.match(ok(chat(['lock', 'main-freeze', 'new', 'fresh'], now)), /LOCKED main-freeze/);
  assert.match(ok(chat(['unlock', 'main-freeze', 'new'], now)), /UNLOCKED main-freeze/);
});

test('a break racing a handoff cannot remove the fresh lock', async (t) => {
  const { board, chat, chatAsync, clock } = fixture(t);
  ok(chat(['lock', 'main-freeze', 'old', 'stale'], clock(1000)));
  const now = clock(5000);
  const breaker = chatAsync(['break', 'main-freeze', 'breaker'], { ...now, TEST_PAUSE: '1' });
  try {
    await waitForPause(board);
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
