// Exercise the Bash hook against a scratch repo and board.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../guard.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-guard-'));
const chat = path.join(scratch, 'chat');
const repo = path.join(scratch, 'repo');
const env = {
  ...process.env,
  CHAT_DIR: chat,
  ZM_REPO: repo,
  ZM_REPO_COMMON: path.join(repo, '.git'),
  ZM_MIG_DIR: 'migrations',
};
// Keep Git's inherited worktree and index settings out of the fixture.
for (const name of Object.keys(env)) {
  if (name.startsWith('GIT_')) delete env[name];
}
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });

function fire(command, cwd = repo) {
  return spawnSync(process.execPath, [script, 'hook'], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    env,
    encoding: 'utf8',
  });
}

try {
  mkdirSync(chat);
  mkdirSync(path.join(repo, 'migrations'), { recursive: true });
  git('init', '-q', '--template=');
  writeFileSync(path.join(repo, 'migrations', '005_main.sql'), '');
  git('add', '--', 'migrations');
  git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(scratch, 'hooks')}`,
    'commit', '-qm', 'Seed migrations');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(repo, 'migrations', '003_staged.sql'), '');
  git('add', '--', 'migrations');

  const commit = 'git commit -m test';
  const mustBlock = [
    [commit],
    [`env TEST=1 ${commit}`],
    [`env -u CI ${commit}`],
    [`sudo -u runner ${commit}`],
    [`env -i -u CI --unset=DEBUG -uTERM -- TEST=1 ${commit}`],
    [`sudo -nu runner --group=staff -p "Password: " -- ${commit}`],
    [`env -uCI sudo --non-interactive --user runner -gstaff ${commit}`],
    [`/usr/bin/env -vuCI --chdir=repo ${commit}`, scratch],
    [`sudo -nD repo -u runner ${commit}`, scratch],
    [`command ${commit}`],
    [`time ${commit}`],
    [`! ${commit}`],
    [`if true; then ${commit}; fi`],
    [`{ ${commit}; }`],
    [`bash -c "${commit}"`],
    [`sh -lc "command ${commit}"`],
    [`eval 'env ${commit}'`],
    [`/usr/bin/${commit}`],
    ['"C:\\Program Files\\Git\\bin\\git.exe" commit -m test'],
    [`\\${commit}`],
    [`git add . && \\\n  ${commit}`],
    ['git \\\r\ncommit -m test'],
    ['git co\\\nmmit -m test'],
    ['git "co\\\nmmit" -m test'],
    [`cd ~/repo && ${commit}`],
    [`cd "$REPO" && ${commit}`],
    [`cd $(git rev-parse --show-toplevel) && ${commit}`],
    [`cd ./missing && ${commit}`],
    [`cd repo && cd "$REPO" && ${commit}`, scratch],
    [`(cd ..); ${commit}`],
    [`(cd ..; (cd repo); cd repo; ${commit})`],
    [`cd repo && ${commit}`, scratch],
    ['git -C repo commit -m test', scratch],
  ];
  const mustAllow = [
    [`echo "${commit}"`],
    [`command -v ${commit}`],
    ['env -u git commit -m test'],
    ['sudo -u git commit -m test'],
    [`sudo --user runner -l ${commit}`],
    [`env -C .. ${commit}`],
    [`sudo --chdir .. ${commit}`],
    [`env -C repo git status; ${commit}`, scratch],
    [`bash -c 'echo "${commit}"'`],
    ["git 'co\\\nmmit' -m test"],
    [`cd ..; ${commit}`],
    [`(cd ..; ${commit})`],
    [`(cd repo); ${commit}`, scratch],
  ];
  const failures = [];
  for (const [command, cwd] of mustBlock) {
    const { status, stderr } = fire(command, cwd);
    if (status !== 2 || !/BLOCK migrations\/003_staged\.sql is numbered 003/.test(stderr)) {
      failures.push(`${JSON.stringify(command)}: expected migration block, got ${status} ${stderr}`);
    }
  }
  for (const [command, cwd] of mustAllow) {
    const { status, stderr } = fire(command, cwd);
    if (status !== 0 || stderr) failures.push(`${JSON.stringify(command)}: expected exit 0, got ${status} ${stderr}`);
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('all guard cases passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
