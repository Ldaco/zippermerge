import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../guard.mjs', import.meta.url));
const capture = fileURLToPath(new URL('../capture.mjs', import.meta.url));

function fixture(t, base = '005_base.sql') {
  const scratch = mkdtempSync(path.join(tmpdir(), 'pearl-guard-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'repo');
  const chat = path.join(scratch, 'chat');
  mkdirSync(path.join(repo, 'migrations'), { recursive: true });
  for (const dir of ['claims', 'locks', 'status']) mkdirSync(path.join(chat, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|ZM_)/i.test(key)) delete env[key];
  }
  Object.assign(env, { CHAT_DIR: chat, ZM_REPO: repo, ZM_SLUG: 'beta', REPO: repo, HOME: scratch });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', path.join(scratch, 'hooks'));
  git('config', 'commit.gpgSign', 'false');
  function stage(name) {
    writeFileSync(path.join(repo, 'migrations', name), '-- fixture\n');
    git('add', '--', 'migrations/' + name);
  }
  stage(base);
  git('-c', 'user.name=Fixture', '-c', 'user.email=pearl@example.invalid', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  function hook(script, command, cwd = repo) {
    // Only submit text to the hook. The proposed command is never executed.
    const input = JSON.stringify({ cwd, session_id: 'fixture', tool_name: 'Bash',
      hook_event_name: 'PreToolUse', tool_input: { command } });
    const result = spawnSync(process.execPath, script === guard ? [guard, 'hook'] : [capture],
      { input, env, cwd, encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    return result;
  }
  const freeze = () => writeFileSync(path.join(chat, 'locks', 'main-freeze.md'), 'owner: alpha\n');
  return { chat, repo, scratch, git, env, freeze, stage, hook };
}

function blocked(result, diagnostic) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, diagnostic);
}

for (const [issue, forms] of [
  [11, ['git commit -m x', 'env git commit -m x', 'command git commit -m x', 'time git commit -m x',
    '! git commit -m x', 'bash -c "git commit -m x"', 'if true; then git commit -m x; fi',
    '{ git commit -m x; }', '/usr/bin/git commit -m x', '\\git commit -m x']],
  [12, ['git add . && \\\n  git commit -m x', 'git \\\ncommit']],
  [13, ['cd ~/repo && git commit -m x', 'cd $(git rev-parse --show-toplevel) && git commit -m x',
    'cd "$REPO" && git commit -m x', '(cd /tmp); git commit -m x']],
]) {
  test('guard routes issue #' + issue + ' forms to the migration check', (t) => {
    const { hook, stage } = fixture(t);
    stage('003_bad.sql');
    for (const command of forms) blocked(hook(guard, command), /003_bad\.sql.*highest \(005\)/);
  });
}

test('an unidentified session gets an identity hint when main is frozen (#124)', (t) => {
  const { env, freeze, hook } = fixture(t);
  freeze();
  delete env.ZM_SLUG;
  blocked(hook(guard, 'git commit'), /held by alpha.*could not identify this session.*--slug or ZM_SLUG/);
  env.ZM_SLUG = 'beta';
  const known = hook(guard, 'git commit');
  blocked(known, /held by alpha/);
  assert.doesNotMatch(known.stderr, /could not identify/);
});

for (const [base, name, claim] of [
  ['999_base.sql', '1000_next.sql', '1000'],
  ['041_base.sql', '042_next.sql', '042'],
  ['041_base.sql', '0042_next.sql', '042'],
]) {
  test('migration ownership for ' + name + ' uses claim ' + claim + ' (#133)', (t) => {
    const { chat, env, stage, hook } = fixture(t, base);
    writeFileSync(path.join(chat, 'claims', 'migration-' + claim + '.md'), 'owner: alpha\n');
    stage(name);
    blocked(hook(guard, 'git commit'), /claimed by alpha/);
    env.ZM_SLUG = 'alpha';
    assert.equal(hook(guard, 'git commit').status, 0);
  });
}

for (const setting of ['unset', 'missing', 'non-repository']) {
  test('both hooks diagnose ' + setting + ' repository configuration (#134)', (t) => {
    const { env, chat, freeze, hook } = fixture(t);
    freeze();
    if (setting === 'unset') delete env.ZM_REPO;
    else env.ZM_REPO = setting === 'missing' ? path.join(chat, 'missing') : chat;
    const decision = hook(guard, 'git commit');
    assert.match(decision.stderr, /zippermerge.*ZM_REPO/i);
    assert.equal(decision.status, 2);
    assert.match(hook(capture, 'git status').stderr, /zippermerge.*ZM_REPO/i);
  });
}

test('a linked worktree is a valid configured repository (#134)', (t) => {
  const { env, scratch, git, freeze, hook } = fixture(t);
  env.ZM_REPO = path.join(scratch, 'linked');
  git('worktree', 'add', '-qb', 'topic', env.ZM_REPO);
  freeze();
  blocked(hook(guard, 'git commit'), /held by alpha/);
});

test('main-freeze covers local history changes on the target branch (#135)', (t) => {
  const { repo, env, scratch, git, freeze, stage, hook } = fixture(t);
  freeze();
  for (const command of ['git merge feature', 'git cherry-pick HEAD', 'git revert HEAD', 'git am patch']) {
    blocked(hook(guard, command), /main-freeze is held by alpha/);
  }
  for (const command of ['git status', 'git pull', 'git rebase feature', 'echo git merge']) {
    assert.equal(hook(guard, command).status, 0, command);
  }
  git('worktree', 'add', '-qb', 'topic', path.join(scratch, 'topic'));
  const fromTopic = hook(guard, 'git -C ../repo merge feature', path.join(scratch, 'topic'));
  blocked(fromTopic, /main-freeze is held by alpha/);
  assert.equal(hook(guard, 'git -C ../topic merge feature', repo).status, 0);
  env.ZM_SLUG = 'alpha';
  stage('003_old.sql');
  assert.equal(hook(guard, 'git merge feature').status, 0);
  blocked(hook(guard, 'git merge feature; git commit'), /003_old\.sql/);
});
