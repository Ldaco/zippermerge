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
  const corpus = [
    ['nested wrappers and assignment prefix', true, `FLAG="two words" env -ivuCI -- sudo -nu runner -- nice -n-5 nohup -- ${commit}`],
    ['option operand can look like Git', false, 'env --unset git commit -m test'],
    ['attached long value and explicit terminator', true, `sudo --user=runner --non-interactive -- ${commit}`],
    ['short flag followed by option operand', true, `/usr/bin/time -po timing.txt ${commit}`],
    ['wrapper information request', false, `nohup --version ${commit}`],
    ['xargs operands and quoted command', true, 'printf "x\\n" | xargs -n1 -P 1 -- "git" commit -m'],
    ['escaped backslash leaves the next line independent', true, [': \\\\', commit].join('\n')],
    ['quoted command text has no shell keyword semantics', false, `'!' ${commit}`],
    ['env recognizes the legacy dash after its option terminator', true, `env -- - FLAG=1 ${commit}`],
    ['fixed timeout operand before executable', true, `timeout --signal=TERM -k5s 10s ${commit}`],
    ['timeout operand is not its executable', false, 'timeout git commit -m test'],
    ['command buffer option and subshell', true, `(stdbuf -oL -- \\\n${commit})`],
    ['detached command option and terminator', true, `setsid --wait -- ${commit}`],
    ['GNU argv expansion from a shell prefix assignment', true, "VALIDATOR_GIT=git env -S '\${VALIDATOR_GIT} commit -m x'"],
    ['GNU argv expansion before a split command and remaining argv', true, "VALIDATOR_GIT=git env -i --split-string='-u CI \${VALIDATOR_GIT} commit' -m x"],
    ['GNU argv expansion retains whitespace inside one argument', false, "VALIDATOR_GIT='git commit' env -S '\${VALIDATOR_GIT} -m x'"],
    ['GNU split-string single quotes suppress expansion', false, "VALIDATOR_GIT=git env -S \"'\\\${VALIDATOR_GIT}' commit -m x\""],
    ['unquoted here-doc substitutes commands', true, `cat <<EOF\n$(${commit})\nEOF`],
    ['unquoted here-doc substitutes even inside text quotes', true, `cat <<EOF\n'$(${commit})'\nEOF`],
    ['unquoted here-doc continues its delimiter', true, `cat <<EOF\nE\\\nOF\n${commit}`],
    ['quoted here-doc keeps substitutions as text', false, `cat <<'EOF'\n$(${commit})\nEOF`],
    ['unquoted here-doc honors escaped substitution', false, `cat <<EOF\n\\$(${commit})\nEOF`],
    ['last stdin redirection is a here-doc', true, `sh </dev/null <<'EOF'\n${commit}\nEOF`],
    ['here-doc duplicated down a descriptor chain', true, `sh 4<<'EOF' 3<&4 <&3\n${commit}\nEOF`],
    ['here-string supplies the shell script', true, `bash <<< '${commit}'`],
    ['file redirection supersedes here-doc stdin', false, `sh <<'EOF' </dev/null\n${commit}\nEOF`],
    ['file redirection supersedes here-string stdin', false, `sh <<< '${commit}' </dev/null`],
    ['syntax-check command string', false, `bash -n -o errexit -c '${commit}'`],
    ['syntax-check stdin script', false, `bash -ns <<'EOF'\n${commit}\nEOF`],
    ['named syntax-check option', false, `bash -o noexec -c '${commit}'`],
    ['later shell flag enables execution', true, `bash -n +n -c '${commit}'`],
    ['Git selectors expand the shell directory', true, 'git --git-dir "$PWD/.git" --work-tree "$PWD" commit -m x'],
    ['single quotes preserve literal Git selector characters', false, "git --git-dir '$PWD/.git' --work-tree '$PWD' commit -m x"],
    ['Git selector option assignment expands after a cd', true,
      `cd ${repoArg}; git --git-dir="$PWD/.git" --work-tree="$PWD" commit -m x`, scratch],
    ['Git directory obtained through command substitution', true, 'GIT_DIR="$(git rev-parse --absolute-git-dir)" git commit -m x'],
    ['unresolved selector conservatively uses the current repo', true, 'git --git-dir "$UNKNOWN_GIT_PATH" commit -m x'],
    ['uncalled function does not change directory', true, `draft() { cd ..; }; ${commit}`],
    ['uncalled function does not run Git', false, `draft() { ${commit}; }; git log`],
    ['called function executes its body', true, `draft() { ${commit}; }; draft`],
    ['called function changes the current directory', false, `draft() { cd ..; }; draft; ${commit}`],
    ['short-circuit OR leaves the directory alone', true, `true || cd ..; ${commit}`],
    ['short-circuit AND leaves the directory alone', true, `false && cd ..; ${commit}`],
    ['unknown branch preserves both possible directories', true, `git status || cd ..; ${commit}`],
    ['successful AND follows the directory change', false, `true && cd ..; ${commit}`],
    ['failed OR follows the directory change', false, `false || cd ..; ${commit}`],
    ['unreached commands do not trigger the guard', false, `true || ${commit}; false && ${commit}`],
    ['comment parenthesis belongs to the substitution', true, `echo "$(# note )\n${commit}\n)"`],
    ['document parenthesis belongs to the substitution', true, `echo "$(cat <<'EOF'\n)\nEOF\n${commit}\n)"`],
    ['nested substitutions share the same shell lexing', true, `echo "$(echo "$(# note )\n${commit}\n)")"`],
    ['arithmetic expansion can execute a nested substitution', true,
      `cat <<EOF\n$(( $(${commit} >&2; printf 1) + 2 ))\nEOF`],
    ['a substitution ignores a command-looking comment', false, `echo "$(# ${commit}\nprintf safe\n)"`],
    ['quote removal on an escaped letter in the executable', true, 'g\\it commit -m x'],
    ['quote removal on an escaped letter in the subcommand', true, 'git com\\mit -m x'],
    ['escaped shell separators are command arguments', false, `echo \\; ${commit}`],
    ['uncalled dashed function cannot change the directory', true, `draft-plan() { cd ..; }; ${commit}`],
    ['uncalled dashed function cannot run Git', false, `draft-plan() { ${commit}; }; git log`],
    ['called dashed function runs Git', true, `draft-plan() { ${commit}; }; draft-plan`],
    ['unquoted shell input expands literal printf output', true, `sh <<EOF\n$(printf '%s\\n' '${commit}')\nEOF`],
    ['unquoted shell input can include several generated lines', true,
      `sh <<EOF\n$(printf '%s\\n' ': generated' '${commit}')\nEOF`],
    ['generated text remains data in a non-shell command', false, `cat <<EOF\n$(printf '%s\\n' '${commit}')\nEOF`],
    ['command-looking output can be discarded by the shell', false, `sh <<EOF\n$(printf '%s\\n' 'echo ${commit}')\nEOF`],
    ['false condition leaves the directory unchanged', true, `if false; then cd ..; fi; ${commit}`],
    ['inactive else leaves the directory unchanged', true, `if true; then :; else cd ..; fi; ${commit}`],
    ['inactive body cannot run Git', false, `if false; then ${commit}; fi`],
    ['only the selected elif body runs', true, `if false; then cd ..; elif false; then cd ..; else ${commit}; fi`],
    ['selected branch can change the current directory', false, `if true; then cd ..; fi; ${commit}`],
    ['unknown condition preserves the guarded alternative', true, `if git status; then cd ..; fi; ${commit}`],
    ['negation applies to a subshell', true, `! (true) || ${commit}`],
    ['negation applies to a brace group', true, `! { true; } || ${commit}`],
    ['negation applies to the pipeline result', true, `! false | true || ${commit}`],
    ['negated failed subshell skips OR', false, `! (false) || ${commit}`],
    ['negated failed pipeline skips OR', false, `! true | false || ${commit}`],
    ['brace group passes its input document to sh', true, `{ sh; } <<'EOF'\n${commit}\nEOF`],
    ['subshell passes its here-string to Bash', true, `(bash) <<< '${commit}'`],
    ['command overrides input inherited from a group', false, `{ sh </dev/null; } <<'EOF'\n${commit}\nEOF`],
    ['inherited descriptors can be copied by a child command', true, `{ sh <&3; } 3<<'EOF'\n${commit}\nEOF`],
    ['exported assignment reaches the next command', true,
      "export VALIDATOR_GIT=git; env -S '\${VALIDATOR_GIT} commit -m x'"],
    ['exported assignment survives a brace group', true,
      "{ export VALIDATOR_GIT=git; }; env -S '\${VALIDATOR_GIT} commit -m x'"],
    ['subshell export stays in its own environment', false,
      "(export VALIDATOR_GIT=git); env -S '\${VALIDATOR_GIT} commit -m x'"],
    ['command builtin preserves the cd side effect', true, `command -- cd ${repoArg}; ${commit}`, scratch],
    ['reserved time preserves the cd side effect', true, `time -p cd ${repoArg}; ${commit}`, scratch],
    ['external wrapper does not run a shell builtin in the caller', false, `env cd ${repoArg}; ${commit}`, scratch],
    ['Bash command-string positional argument selects Git', true, "bash -c '\"$1\" commit -m x' _ git"],
    ['Bash argument zero is distinct from the first positional', false, "bash -c '\"$1\" commit -m x' git echo"],
    ['Bash stdin mode binds positional arguments', true, "bash -s -- git <<'EOF'\n\"$1\" commit -m x\nEOF"],
    ['function positional argument selects the directory', true, `draft() { cd "$1"; }; draft ${repoArg}; ${commit}`, scratch],
    ['called function can forward quoted arguments', true, `draft() { "$@"; }; draft ${commit}`],
  ];
  const cases = [
    ...mustBlock.map(([command, cwd]) => ['previous block regression', true, command, cwd]),
    ...mustAllow.map(([command, cwd]) => ['previous allow regression', false, command, cwd]),
    ...corpus,
  ];
  const failures = [];
  for (const [name, block, command, cwd] of cases) {
    const { status, stderr } = fire(command, cwd);
    const policyBlocks = /BLOCK migrations\/003_staged\.sql is numbered 003/.test(stderr)
      && /BLOCK main-freeze is held/.test(stderr) && /BLOCK migrations\/003_staged\.sql is exclusively reserved/.test(stderr);
    const matches = block ? status === 2 && policyBlocks : status === 0 && !stderr;
    if (!matches) {
      failures.push(`${name} ${JSON.stringify(command)}: expected ${block ? 'all three policy blocks' : 'exit 0'}, got ${status} ${stderr}`);
    }
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
