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
    assert.equal(decision.status, 0);
    const warning = JSON.parse(decision.stdout);
    assert.equal(warning.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(warning.hookSpecificOutput.additionalContext, decision.stderr.trim());
    assert.equal(warning.systemMessage, decision.stderr.trim());
    assert.match(warning.systemMessage, /guard.*inactive/i);
    assert.equal(warning.hookSpecificOutput.permissionDecision, undefined);
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
  for (const command of ['git status', 'echo git merge']) {
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

const historyChanges = [
  'rebase feature', 'rebase -i HEAD~2', 'rebase --onto a b c', 'rebase --continue',
  'pull', 'pull --rebase', 'pull origin main', 'reset --hard HEAD~1', 'reset --soft HEAD~1',
  'update-ref refs/heads/main HEAD~1', 'branch -f main feature', 'fetch . feature:main',
  'push . feature:main', 'checkout -B main feature', 'switch -C main feature',
  'read-tree -u -m', 'stash pop', 'filter-branch -f',
];

test('a freeze protects HEAD and named or indeterminate ref destinations', (t) => {
  const { freeze, hook, repo, scratch, git, env } = fixture(t);
  const topic = path.join(scratch, 'topic');
  git('worktree', 'add', '-qb', 'topic', topic);
  git('config', 'alias.mm', 'merge');
  freeze();
  function check(cwd, commands) {
    const missed = commands.filter(command => {
      const result = hook(guard, 'git ' + command, cwd);
      return result.status !== 2 || !result.stderr.includes('main-freeze is held by alpha');
    });
    assert.deepEqual(missed, []);
  }
  check(repo, historyChanges);
  check(topic, ['branch -f main feature', 'update-ref refs/heads/main HEAD~1',
    'fetch . feature:refs/heads/main', 'push . feature:refs/heads/main',
    'checkout -B main feature', 'switch -C main feature', 'filter-branch -f',
    'rebase --onto a b main', 'mm x', '-c alias.m=merge m feature',
    'config alias.mm merge && git mm x']);
  git('branch', 'other');
  for (const command of ['git reset --soft HEAD~1', 'git stash pop', 'git branch -f other HEAD',
    'git update-ref refs/heads/other HEAD', 'git fetch . topic:refs/heads/other',
    'git push . topic:refs/heads/other']) {
    const result = hook(guard, command, topic);
    assert.equal(result.status, 0, command + '\n' + result.stderr);
  }
  git('symbolic-ref', 'refs/heads/alias-main', 'refs/heads/main');
  check(topic, ['update-ref refs/heads/alias-main HEAD']);
  git('worktree', 'add', '-q', '--detach', path.join(scratch, 'detached'), 'HEAD');
  assert.equal(hook(guard, 'git merge feature', path.join(scratch, 'detached')).status, 0);
  env.ZM_SLUG = 'alpha';
  for (const command of historyChanges) assert.equal(hook(guard, 'git ' + command).status, 0, command);
});

test('freeze allows standalone recovery, help and path-only resets', (t) => {
  const { freeze, hook } = fixture(t);
  freeze();
  const allowed = ['merge --abort', 'merge --quit', 'cherry-pick --abort', 'revert --quit',
    'am --abort', 'rebase --abort', 'merge -h', 'merge --help', 'revert --help',
    'reset HEAD -- migrations', 'branch --show-current', 'status'];
  const unexpectedlyBlocked = allowed.filter(command => hook(guard, 'git ' + command).status !== 0);
  assert.deepEqual(unexpectedlyBlocked, []);
  blocked(hook(guard, 'git merge --no-commit --dry-run x'), /held by alpha/);
});

test('unusable scope warns without blocking an unrelated project or a non-Git directory', (t) => {
  const { env, repo, chat, scratch, hook, freeze } = fixture(t);
  const unrelated = path.join(scratch, 'unrelated');
  execFileSync('git', ['init', '-q', unrelated], { env });
  freeze();
  for (const setting of [undefined, '', scratch, path.join(repo, 'migrations'), path.join(repo, 'migrations/005_base.sql')]) {
    if (setting === undefined) delete env.ZM_REPO;
    else env.ZM_REPO = setting;
    for (const cwd of [unrelated, chat]) {
      const result = hook(guard, 'git commit -m x', cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /WARN.*ZM_REPO.*config\.env/);
    }
  }
  env.ZM_REPO = repo;
  env.ZM_REPO_COMMON = path.join(scratch, 'missing-common');
  const result = hook(guard, 'git merge x', unrelated);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN.*ZM_REPO_COMMON.*config\.env/);
});

test('a configured bare repository protects its linked main worktree', (t) => {
  const { env, repo, scratch, freeze, hook } = fixture(t);
  const bare = path.join(scratch, 'central.git');
  const worktree = path.join(scratch, 'linked-main');
  execFileSync('git', ['clone', '-q', '--bare', repo, bare], { env });
  execFileSync('git', ['--git-dir', bare, 'worktree', 'add', '-q', worktree, 'main'], { env });
  env.ZM_REPO = bare;
  freeze();
  blocked(hook(guard, 'git commit', worktree), /main-freeze is held by alpha/);
});

test('a non-owner can do routine work in a linked topic worktree during a freeze', (t) => {
  const { git, scratch, freeze, hook } = fixture(t);
  const topic = path.join(scratch, 'topic');
  git('worktree', 'add', '-qb', 'topic', topic);
  git('branch', 'feature');
  git('remote', 'add', 'origin', path.join(scratch, 'remote.git'));
  git('config', 'branch.topic.remote', 'origin');
  git('config', 'branch.topic.merge', 'refs/heads/topic');
  freeze();
  const allowed = ['checkout feature', 'checkout -b new', 'switch feature', 'switch -c n2',
    'push origin topic', 'push -u origin topic', 'push', 'fetch', 'fetch origin', 'fetch --all --prune',
    'pull', 'pull --rebase', 'rebase main', 'stash', 'stash list', 'branch x', 'branch -d feature',
    'tag v1', 'worktree add ../new-tree', 'worktree list', 'worktree remove ../new-tree',
    'restore .', 'checkout -- f', 'clean -fd', 'remote -v', 'config user.name x', 'config --get user.name',
    'gc', 'apply p', 'submodule update', 'sparse-checkout list', 'bisect start'];
  const blockedCommands = allowed.filter(command => hook(guard, 'git ' + command, topic).status !== 0);
  assert.deepEqual(blockedCommands, []);
});

test('explicit main destinations and configured ref mappings respect the freeze from topic', (t) => {
  const { git, scratch, freeze, hook } = fixture(t);
  const topic = path.join(scratch, 'topic');
  git('worktree', 'add', '-qb', 'topic', topic);
  git('remote', 'add', 'origin', path.join(scratch, 'remote.git'));
  git('config', 'branch.topic.remote', 'origin');
  git('config', 'branch.topic.merge', 'refs/heads/main');
  git('config', 'push.default', 'upstream');
  freeze();
  for (const command of ['push origin topic:main', 'push origin HEAD:refs/heads/main', 'push',
    'fetch origin topic:main', 'branch -d main', 'worktree add -B main ../next topic',
    'checkout -B main topic', 'switch -C main topic', 'rebase main main']) {
    blocked(hook(guard, 'git ' + command, topic), /held by alpha/);
  }
  git('config', 'remote.origin.fetch', '+refs/heads/topic:refs/heads/main');
  for (const command of ['fetch', 'fetch origin', 'fetch --all --prune', 'pull']) {
    blocked(hook(guard, 'git ' + command, topic), /held by alpha/);
  }
  git('config', 'rebase.updateRefs', 'true');
  blocked(hook(guard, 'git rebase main', topic), /held by alpha/);
  blocked(hook(guard, 'git gh unknown', topic), /held by alpha.*\bgh\b/);
});
