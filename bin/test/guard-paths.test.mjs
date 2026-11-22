// node bin/test/guard-paths.test.mjs : exercises the guard against scratch repos.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../guard.mjs', import.meta.url));

function fixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-guard-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'repo');
  const hooks = path.join(scratch, 'hooks');
  mkdirSync(path.join(chat, 'reservations'), { recursive: true });
  mkdirSync(path.join(chat, 'status'));
  mkdirSync(repo);
  mkdirSync(hooks);
  const env = {
    ...process.env,
    CHAT_DIR: chat,
    ZM_REPO: repo,
    ZM_REPO_COMMON: path.join(repo, '.git'),
    ZM_MIG_DIR: 'migrations',
  };
  for (const key of [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) delete env[key];

  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.hooksPath', hooks);
  git('config', 'core.quotePath', 'true');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'diff.renames', 'true');

  function stage(file, contents = 'fixture\n') {
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    git('add', '--', file);
  }

  function reserve(pattern, mode = 'exclusive') {
    const expiration = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(path.join(chat, 'reservations', 'other.md'),
      `owner: other\npattern: ${pattern}\nmode: ${mode}\nexpires_epoch: ${expiration}\n`);
  }

  function check(exitCode) {
    const result = spawnSync(process.execPath, [script, 'check', '--slug', 'tester', '--cwd', repo], {
      env, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, '');
    assert.equal(result.status, exitCode, result.stdout);
    return result.stdout;
  }

  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Fixture');
  return { chat, git, stage, reserve, check, commit };
}

test('staged Unicode paths match reservations and hot files', (t) => {
  const { chat, stage, reserve, check } = fixture(t);
  reserve('*.ts');
  writeFileSync(path.join(chat, 'status', 'other.md'), 'Hot files: café.ts\n');
  stage('café.ts');
  const output = check(2);
  assert.match(output, /BLOCK café\.ts is exclusively reserved by other/);
  assert.match(output, /WARN café\.ts is in other's Hot files/);
});

test('a staged deletion warns under a shared reservation', (t) => {
  const { git, stage, reserve, check, commit } = fixture(t);
  stage('src/a.ts');
  commit();
  reserve('src/**', 'shared');
  git('rm', '--', 'src/a.ts');
  assert.match(check(0), /WARN src\/a\.ts is reserved \(shared\) by other/);
});

test('both paths of a staged rename are checked against exclusive reservations', (t) => {
  const { git, stage, reserve, check, commit } = fixture(t);
  stage('src/a.ts');
  commit();
  git('mv', '--', 'src/a.ts', 'a.ts');
  reserve('src/**');
  assert.match(check(2), /BLOCK src\/a\.ts is exclusively reserved by other/);
  reserve('*.ts');
  assert.match(check(2), /BLOCK a\.ts is exclusively reserved by other/);
});

test('trailing-slash reservations cover nested paths', (t) => {
  const { stage, reserve, check } = fixture(t);
  reserve('src/');
  stage('src-other/nested/a.ts');
  assert.equal(check(0), '');
  stage('src/nested/a.ts');
  assert.match(check(2), /BLOCK src\/nested\/a\.ts is exclusively reserved by other/);
});

test('a staged migration deletion does not require a claim', (t) => {
  const { git, stage, check, commit } = fixture(t);
  stage('migrations/001_old.sql');
  commit();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  stage('migrations/002_obsolete.sql');
  commit();
  git('rm', '--', 'migrations/002_obsolete.sql');
  assert.equal(check(0), '');
});

test('a tracked Unicode migration is recognized on origin/main', (t) => {
  const { git, stage, check, commit } = fixture(t);
  const migration = 'migrations/001_café.sql';
  stage(migration);
  commit();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  stage(migration, 'updated\n');
  assert.equal(check(0), '');
  stage('migrations/002_café.sql');
  assert.match(check(2), /BLOCK migration 002 unclaimed/);
});
