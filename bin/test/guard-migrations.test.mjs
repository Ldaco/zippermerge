// Exercise the Bash hook against a scratch repo and board.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../guard.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-guard-'));
const chat = path.join(scratch, 'chat');
const repo = path.join(scratch, 'repo space');
const repoArg = '"repo space"';
const other = path.join(scratch, 'other');
const env = {
  ...process.env,
  CHAT_DIR: chat,
  ZM_REPO: repo,
  ZM_REPO_COMMON: path.join(repo, '.git'),
  ZM_MIG_DIR: 'migrations',
  ZM_SLUG: 'guard-test',
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
  mkdirSync(path.join(repo, 'nested'));
  mkdirSync(other);
  git('init', '-q', '--template=', '-b', 'main');
  execFileSync('git', ['-C', other, 'init', '-q', '--template='], { env, stdio: 'pipe' });
  writeFileSync(path.join(repo, 'migrations', '005_main.sql'), '');
  git('add', '--', 'migrations');
  git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(scratch, 'hooks')}`,
    'commit', '-qm', 'Seed migrations');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(repo, 'migrations', '003_staged.sql'), '');
  git('add', '--', 'migrations');
  mkdirSync(path.join(chat, 'claims'));
  writeFileSync(path.join(chat, 'claims', 'migration-003.md'), 'owner: guard-test\n');
  mkdirSync(path.join(chat, 'locks'));
  writeFileSync(path.join(chat, 'locks', 'main-freeze.md'), 'owner: other-session\n');
  mkdirSync(path.join(chat, 'reservations'));
  writeFileSync(path.join(chat, 'reservations', 'guard.md'), [
    'owner: other-session',
    'pattern: migrations/*.sql',
    'mode: exclusive',
    `expires_epoch: ${Math.floor(Date.now() / 1000) + 3600}`,
  ].join('\n'));

  const commit = 'git commit -m test';
  const mustBlock = [
    [commit],
    [`env TEST=1 ${commit}`],
    [`env -u CI ${commit}`],
    [`sudo -u runner ${commit}`],
    [`env -i -u CI --unset=DEBUG -uTERM -- TEST=1 ${commit}`],
    [`sudo -nu runner --group=staff -p "Password: " -- ${commit}`],
    [`env -uCI sudo --non-interactive --user runner -gstaff ${commit}`],
    [`/usr/bin/env -vuCI --chdir=${repoArg} ${commit}`, scratch],
    [`sudo -nD ${repoArg} -u runner ${commit}`, scratch],
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
    [`cd ${repoArg} && cd "$REPO" && ${commit}`, scratch],
    [`(cd ..); ${commit}`],
    [`(cd ..; (cd ${repoArg}); cd ${repoArg}; ${commit})`],
    [`cd ${repoArg} && ${commit}`, scratch],
    [`git -C ${repoArg} commit -m test`, scratch],
    [`cat <<'EOF'\ncd ..\nEOF\n${commit}`],
    [`cat <<FIRST <<-'SECOND'\ncd ..\nFIRST\n\tcd ..\n\tSECOND\n${commit}`],
    [`sh <<'EOF'\n${commit}\nEOF`],
    [`bash -s <<'EOF'\n${commit}\nEOF`],
    [`echo hash#literal; ${commit} # comment`],
    [`/usr/bin/nohup ${commit}`],
    [`nice -n 5 ${commit}`],
    [`nice --adjustment=5 env ${commit}`],
    ["printf 'x\\n' | xargs -n 1 git commit -m"],
    ["printf 'x\\n' | xargs -0r -I '{}' -- git -c core.editor=true commit -m '{}'"],
    [`/usr/bin/time -o timing.txt ${commit}`],
    [`doas -n -u runner -- ${commit}`],
    [`env -S '${commit}'`],
    [`env --split-string='${commit}'`],
    [`env -ivS '-u CI git -c "core.editor=ed -s" commit' -m test`],
    ["env -S 'git\\_commit -m test'"],
    [`env -C 'repo space/nested' ${commit}`, scratch],
    [`git -C ${repoArg} -C nested commit -m test`, scratch],
    [`{ cd ..; } & ${commit}`],
    [`{ cd ..; } | cat; ${commit}`],
    [`{ cd ..; { cd ${repoArg}; }; } & ${commit}`],
    [`cd .. & ${commit}`],
    [`bash -o errexit -c '${commit}'`],
    [`bash -O extglob -c '${commit}'`],
    [`bash --rcfile startup -eO extglob -c '${commit}'`],
    [`git --git-dir 'repo space/.git' --work-tree ${repoArg} commit -m test`, scratch],
    [`git --git-dir='repo space/.git' --work-tree=${repoArg} commit -m test`, scratch],
    [`GIT_DIR='repo space/.git' GIT_WORK_TREE=${repoArg} ${commit}`, scratch],
    [`env GIT_DIR='repo space/.git' GIT_WORK_TREE=${repoArg} ${commit}`, scratch],
    [`git -C ${repoArg} --git-dir .git --work-tree . commit -m test`, scratch],
    [`env -C ../other git commit -m first; ${commit}`],
    [`bash -c 'git -C ../other commit -m first'; ${commit}`],
    [`bash -c 'git -C ../other commit -m first; ${commit}'`],
    [`git -C ../other commit -m first; ${commit}`],
  ];
  const mustAllow = [
    [`echo "${commit}"`],
    [`command -v ${commit}`],
    ['env -u git commit -m test'],
    ['sudo -u git commit -m test'],
    [`sudo --user runner -l ${commit}`],
    [`env -C .. ${commit}`],
    [`sudo --chdir .. ${commit}`],
    [`env -C ${repoArg} git status; ${commit}`, scratch],
    [`bash -c 'echo "${commit}"'`],
    ["git 'co\\\nmmit' -m test"],
    [`cd ..; ${commit}`],
    [`(cd ..; ${commit})`],
    [`(cd ${repoArg}); ${commit}`, scratch],
    [`cat <<'EOF'\n${commit}\nEOF`],
    [`cat <<-EOF\n\t${commit}\n\tEOF`],
    [`# note; env -u CI ${commit}`],
    [`echo "safe" # note; ${commit}`],
    [`{ cd ..; }; ${commit}`],
    [`{ cd ${repoArg}; } | cat; ${commit}`, scratch],
    [`env -S 'echo' ${commit}`],
    [`env -S 'echo ; ${commit}'`],
    [`doas -C doas.conf ${commit}`],
    [`sh 3<<'EOF'\n${commit}\nEOF`],
    [`git --git-dir=../other/.git --work-tree=../other commit -m test`],
    [`env -u CI git --version commit`],
    ['git --help commit'],
    ['git --exec-path commit'],
    ['git --list-cmds=builtins commit'],
  ];
  const failures = [];
  for (const [command, cwd] of mustBlock) {
    const { status, stderr } = fire(command, cwd);
    if (status !== 2 || !/BLOCK migrations\/003_staged\.sql is numbered 003/.test(stderr)
      || !/BLOCK main-freeze is held/.test(stderr) || !/BLOCK migrations\/003_staged\.sql is exclusively reserved/.test(stderr)) {
      failures.push(`${JSON.stringify(command)}: expected all three policy blocks, got ${status} ${stderr}`);
    }
  }
  for (const [command, cwd] of mustAllow) {
    const { status, stderr } = fire(command, cwd);
    if (status !== 0 || stderr) failures.push(`${JSON.stringify(command)}: expected exit 0, got ${status} ${stderr}`);
  }
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (!scripts.test.includes('bin/test/*.test.mjs') && !scripts.test.includes('bin/test/guard-migrations.test.mjs')) {
    failures.push('npm test must discover the guard regression file');
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('all guard cases passed');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
