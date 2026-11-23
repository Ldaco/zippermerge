import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, extractChatSlug, redact } from '../capture.mjs';
import { findGitCommits, shellCommands } from '../shell-parse.mjs';

const root = path.resolve('shell-corpus');
const repo = path.join(root, 'repo space');
const other = path.join(root, 'other');
const directories = new Set([root, repo, path.join(repo, 'nested'), other]);
const options = {
  cwd: repo,
  environment: {},
  isDirectory: (dir) => directories.has(dir),
  canRedirect: (file) => path.basename(file) !== 'missing-file'
    && !file.includes('missing-input') && !file.includes('missing-directory'),
};

const commit = 'git commit -m x';
const alpha = 'bash ./chat.sh new alpha';
const bravo = 'bash ./chat.sh new bravo';
const doc = (head, body, end = 'EOF') => [head, body, end].join('\n');

const commitCases = [
  // #11 and #12, plus quoting and command position controls.
  [commit], ['env git commit -m x'], ['command git commit -m x'], ['time git commit -m x'],
  ['! git commit -m x'], ['bash -c "git commit -m x"'], ['if true; then git commit -m x; fi'],
  ['{ git commit -m x; }'], ['/usr/bin/git commit -m x'], ['\\git commit -m x'],
  ['git add . && \\\n  git commit -m x'], ['git \\\ncommit'], ['git \\\r\ncommit'],
  ['g\\it commit -m x'], ['git com\\mit -m x'], ['g"i"t co\'mm\'it'],
  ['"C:/Program Files/Git/bin/git.exe" commit'], ['A=x B="a b" git commit'],
  ['echo git commit', false], ['echo "git commit; npm test"', false], ['echo then git commit', false],
  ['command -v git commit', false], ['command -V git commit', false], ['echo x\\; git commit', false],
  ['builtin git commit', false], ['builtin command git commit'], ['echo ok # note\rgit commit'],
  ['git commit-tree x', false], ['git -c alias.x=commit status', false], ['git status commit', false],
  // #44 wrappers, options and word expansion.
  ['env -u CI git commit -m x'], ['sudo -u runner git commit -m x'],
  ['env -i -u A -uB -- git commit'], ['sudo -nu runner -gstaff -- git commit'],
  ['/usr/bin/nohup git commit -m x'], ['nice -n 5 git commit -m x'],
  ["printf 'x\\n' | xargs -n 1 git commit -m"],
  ['/usr/bin/time -o timing.txt git commit -m x'], ['doas -n -u runner -- git commit -m x'],
  ['doas -C /etc/doas.conf git commit', false], ['sudo -l git commit', false],
  ["env -S 'git commit -m x'"], ["env --split-string='git commit -m x'"],
  ["env -S 'git\\_commit -m x'"], ["env -S 'echo ; git commit -m x'", false],
  ["VALIDATOR_GIT=git env -S '${VALIDATOR_GIT} commit -m x'"],
  ["export VALIDATOR_GIT=git; env -S '${VALIDATOR_GIT} commit -m x'"],
  ["export VALIDATOR_GIT=git; unset VALIDATOR_GIT; env -S '${VALIDATOR_GIT} commit -m x'", false],
  ["export VALIDATOR_GIT=git; export -n VALIDATOR_GIT; env -S '${VALIDATOR_GIT} commit -m x'", false],
  ["RUN='git commit'; $RUN -m x"], ["RUN='git commit'; \"$RUN\" -m x", false],
  ["bash -c '$*' _ git commit -m x"], ["bash -c '\"${1:-git}\" commit -m x' _"],
  ["bash -c '\"$1\" commit -m x' _ git"], ['A=git B=$A; "$B" commit -m x'],
  ["bash -c 'exec \"$@\"' _ git commit -m x"],
  ['env -u CI git --version commit', false], ['git --help commit', false],
  ['git --exec-path commit', false], ['git --list-cmds=main commit', false],
  ['git -c core.abbrev=7 --exec-path=/tmp commit'],
  // #44 shell scripts, substitutions and redirects.
  ["bash -o errexit -c 'git commit -m x'"], ["bash -O extglob -c 'git commit -m x'"],
  ["bash -n -o errexit -c 'git commit -m x'", false], ["bash -n +n -lc 'git commit -m x'"],
  [doc("bash -n -s <<'EOF'", commit), false], [doc("cat <<'EOF'", commit), false],
  [doc("sh <<'EOF'", commit)], [doc("sh </dev/null <<'EOF'", commit)],
  [doc("sh <<'EOF' </dev/null", commit), false], [doc("sh 3<<'EOF' <&3", commit)],
  ["bash <<< 'git commit -m x'"], [doc("{ sh; } <<'EOF'", commit)],
  ["(bash) <<< 'git commit -m x'"], [doc("exec 3<<'EOF'", commit) + '\nsh <&3'],
  [doc('cat <<EOF', '$(git commit -m x)')], [doc("cat <<'EOF'", '$(git commit -m x)'), false],
  [doc('cat <<EOF', '\\$(git commit -m x)'), false], [doc('cat <<EOF', 'E\\\nOF', commit)],
  ['# note; env -u CI git commit -m x', false], [doc("cat <<'EOF'", 'cd ..') + '\n' + commit],
  ['cat <<A <<-B\n' + commit + '\nA\n\t' + commit + '\n\tB', false],
  ['echo "$(# note )\ngit commit -m x\n)"'], ['echo "$(cat <<\'EOF\'\n)\nEOF\ngit commit -m x\n)"'],
  ['echo "$(case key in key) git commit -m x;; esac)"'],
  ['false; case key in other) echo noop;; esac && git commit'],
  ['case key in key) cd .. ;& different) git -C "repo space" commit;; esac'],
  [doc('cat <<EOF', '$(( $(git commit -m x >&2; printf 1) + 2 ))')],
  [doc('sh <<EOF', "$(printf '%s\\n' 'git commit -m x')")],
  [doc('sh <<EOF', "$(printf '%b' 'git commit -m x\\n')")],
  [doc('sh <<EOF', "$(echo 'git commit -m x')")],
  [doc('cat <<EOF', "$(printf '%s\\n' 'git commit -m x')"), false],
  [doc('sh <<EOF', "$(printf '%s\\n' 'git commit -m x')")
    .replace(/^/, "printf() { builtin printf '%s\\n' 'echo safe'; }\n"), false],
  ["printf '%s\\n' 'git commit -m x' | sh"],
  // #13 and #44 scope and reachability.
  ['cd ~/repo && git commit -m x'], ['cd $(git rev-parse --show-toplevel) && git commit -m x'],
  ['cd "$REPO" && git commit -m x'], ['(cd /tmp); git commit -m x'],
  ['{ cd ..; } & git commit -m x'], ['{ { cd ..; }; } & git commit -m x'],
  ['cd .. & git commit -m x'], ['{ cd ..; } | cat; git commit -m x'],
  ['draft() { cd ..; }; git commit -m x'], ['draft() { git commit -m x; }; git log', false],
  ['draft-plan() { cd ..; }; git commit -m x'], ['draft-plan() { git commit -m x; }; git log', false],
  ['draft-plan() { git commit -m x; }; draft-plan'],
  ['true || cd ..; git commit -m x'], ['if false; then cd ..; fi; git commit -m x'],
  ['if true; then :; else cd ..; fi; git commit -m x'], ['if false; then git commit -m x; fi', false],
  ['! (true) || git commit -m x'], ['! { true; } || git commit -m x'],
  ['! false | true || git commit -m x'], ['! (false) || git commit -m x', false],
  ['! true || git commit -m x'], ['draft-plan() { return; git commit -m x; }; draft-plan', false],
  ['draft-plan() { return; cd ..; }; draft-plan; git commit -m x'],
  ['true < ./missing-input || git commit -m x'], ['env -C ./missing-directory true || git commit -m x'],
];

const heavyCases = [
  ['pnpm vitest run'], ['yarn vitest run'], ['bun x vitest run'], ['pnpm playwright test'],
  ['pnpm turbo run build'], ['node_modules/.bin/vitest run'], ['npx --yes vitest run'],
  ['sudo npm test'], ['time npm test'], ['cross-env CI=1 vitest run'], ['cd web & npm test'],
  ['vitest run --project web'], ['npx vitest run --reporter verbose'],
  ['playwright test --project chromium'], ['playwright test --workers 4'],
  ['npm exec --package vitest -- vitest run'], ['pnpm dlx --package vitest vitest run'],
  ['pnpm --filter web test', false], ['turbo run build --filter=web', false],
  ['vitest run src/a.test.mjs', false], ['jest --testPathPatterns scratch', false],
  ['playwright test -g title', false], ['npm test -- -t title', false],
  ['npm test -- --project unit'], ['npm run build'], ['tsc -b'], ['echo tsc -b', false],
  ['if false; then npm test; fi', false], ['bash -n -c "npm test"', false], ['bash -c "npm test"'],
  ['npm test >"my log" 2>&1'], ['command -v npm test', false], ['echo npm test', false],
  ['echo "npm test"', false], ['true # ; npm test', false], [doc('cat <<EOF', 'npm test'), false],
  ['true\r\nnpm test'], ['true & npm test'], ['true | npm test'], ['true |& npm test'],
  ['npm \\\r\ntest'], ['true # comment\rnpm test'], ['builtin npm test', false],
];

const chatCases = [
  [alpha], ['bash -e ./chat.sh new alpha'], ['command bash ./chat.sh new alpha'],
  ['env LANG=C bash ./chat.sh new alpha'], ["C=./chat.sh; bash '$C' new alpha", null],
  ['C=./chat.sh; bash "\\$C" new alpha', null], ["C=./chat.sh; bash $'$C' new alpha", null],
  ['C=./chat.sh; bash "$C" new alpha'], ['C=./chat.sh bash "$C" new alpha', null],
  ['bash $\'./ch\\x61t.sh\' new alpha'], ['bash $\'./ch\\141t.sh\' new $\'\\u0061lpha\''],
  ['bash $\'./ch\\U00000061t.sh\' new alpha'],
  ['SLUG=bravo; (SLUG=alpha); bash ./chat.sh new "$SLUG"', 'bravo'],
  ['SLUG=bravo; echo "$(SLUG=alpha)"; bash ./chat.sh new "$SLUG"', 'bravo'],
  ['SLUG=bravo; : | SLUG=alpha; bash ./chat.sh new "$SLUG"', 'bravo'],
  ['SLUG=bravo; { SLUG=alpha; } & bash ./chat.sh new "$SLUG"', 'bravo'],
  ['C="./two words/chat.sh"; bash $C new alpha', null],
  ['C="./two words/chat.sh"; bash "$C" new alpha'], ['C="-e ./chat.sh"; bash $C new alpha'],
  ['bash -o noexec ./chat.sh new alpha', null], ['bash +n ./chat.sh new alpha'],
  ['bash -ne +o noexec ./chat.sh new alpha'], ['bash -o noexce ./chat.sh new alpha', null],
  ['bash -O not_a_shopt ./chat.sh new alpha', null], ['bash -O checkwinsize ./chat.sh new alpha'],
  ['bash -O inherit_errexit ./chat.sh new alpha'], ['bash -O shift_verbose ./chat.sh new alpha'],
  ['bash -c "echo ./chat.sh new alpha"', null], ['command -v bash ./chat.sh new alpha', null],
  ['bash -c "./chat.sh new alpha"'], ['if bash ./chat.sh new alpha; then :; fi'],
  ['if false; then :; elif bash ./chat.sh new alpha; then :; fi'],
  ['until bash ./chat.sh new alpha; do :; done'], ['echo if bash ./chat.sh new alpha', null],
  [doc("git commit -F - <<'EOF'", 'bash /z/chat.sh new alpha'), null],
  ['ls # then bash /z/chat.sh post bravo note hi', null],
  ['echo run bash /z/chat.sh new alpha > x.txt', null], ['grep -n chat.sh post src', null],
  [doc('cat <<EOF', 'body\\\nEOF\n' + alpha), null],
  [doc('cat <<EOF', 'body\\\nEOF\n' + alpha) + '\n' + bravo, 'bravo'],
  ['if false; then ' + alpha + '; fi; ' + bravo, 'bravo'],
  ['if true; then :; else ' + alpha + '; fi; ' + bravo, 'bravo'],
  ['while false; do ' + alpha + '; done; ' + bravo, 'bravo'],
  ['SLUG=bravo; export SLUG=alpha; bash ./chat.sh new "$SLUG"'],
  ['SLUG=alpha; unset SLUG; bash ./chat.sh new "$SLUG"', null],
  ['SLUG=bravo; command -p export SLUG=alpha; bash ./chat.sh new "$SLUG"'],
  ['SLUG=alpha; command -p unset SLUG; bash ./chat.sh new "$SLUG"', null],
  ['printf \'%s\\n\' "$(bash ./chat.sh new alpha)"'], ['out=$(bash ./chat.sh new alpha)'],
  ["printf '%s\\n' '$(bash ./chat.sh new alpha)'", null], ['echo "\\$(bash ./chat.sh new alpha)"', null],
  ['[ -f ./chat.sh ] && ' + alpha + '; ' + bravo, null],
  ['[ -f ./chat.sh ] && ' + alpha + '; ' + alpha],
  [': >missing-directory/output && ' + alpha + '; ' + bravo, null],
  ['if true <missing-file; then ' + alpha + '; fi; ' + bravo, null],
  ['f() { ' + alpha + '; }; ' + bravo, 'bravo'],
  ['function f {\n  ' + alpha + '\n}; ' + bravo, 'bravo'],
  ['f() { echo "$(bash ./chat.sh new alpha)"; }; ' + bravo, 'bravo'],
  ['f() { ' + alpha + '; }; f; ' + bravo], ['exit 0; ' + alpha, null],
  ['(exit 0); ' + alpha], ['./chat.sh lock full-test-suite alpha why', 'alpha', 'lock'],
  ['builtin ./chat.sh new alpha', null],
  ['./chat.sh unlock main-freeze alpha', 'alpha', 'unlock'],
  ['./chat.sh break full-test-suite alpha', 'alpha', 'break'],
  ['./chat.sh guard --slug alpha', 'alpha', 'guard'],
  ['./chat.sh reserve alpha bin/file.mjs why', 'alpha', 'reserve'],
  ['./chat.sh board', null], ['./chat.sh new ../alpha', null],
];

// The same constructs should preserve command position for all three policies.
const executing = [
  (s) => s, (s) => ' true; ' + s, (s) => '( ' + s + ' )',
  (s) => '{ ' + s + '; }', (s) => 'true && ' + s, (s) => 'false || ' + s,
  (s) => 'true & ' + s, (s) => 'echo ok | ' + s, (s) => 'echo ok\r\n' + s,
  (s) => 'if true; then ' + s + '; fi', (s) => 'env -u CI -u DEBUG -- ' + s,
  (s) => 'sudo -u runner -- ' + s, (s) => 'nice -n 5 ' + s,
  (s) => 'command -p ' + s, (s) => 'TEMP="a b" ' + s,
  (s) => '2>/dev/null ' + s, (s) => s + ' 2>&1',
  (s) => s.replace(' ', ' \\\n  '), (s) => 'bash -O extglob -c \'' + s + '\'',
  (s) => 'echo "$(' + s + ')"', (s) => 'echo $(' + s + ')',
];
const inert = [
  (s) => 'echo ' + s, (s) => 'echo "' + s + '"', (s) => 'echo \'$(' + s + ')\'',
  (s) => 'echo x # ; ' + s, (s) => doc("cat <<'EOF'", s), (s) => doc('cat <<EOF', s),
  (s) => 'true || ' + s, (s) => 'false && ' + s, (s) => 'command -v ' + s,
  (s) => 'function dormancy { ' + s + '; }', (s) => 'exit 0; ' + s,
  (s) => 'bash -o noexec -c \'' + s + '\'', (s) => 'if false; then ' + s + '; fi',
  (s) => 'echo > "' + s + '"', (s) => 'cat <<< "' + s + '"',
];
for (const rewrite of executing) {
  commitCases.push([rewrite(commit)]);
  heavyCases.push([rewrite('npm test')]);
  chatCases.push([rewrite(alpha)]);
}
for (const rewrite of inert) {
  commitCases.push([rewrite(commit), false]);
  heavyCases.push([rewrite('npm test'), false]);
  chatCases.push([rewrite(alpha), null]);
}

for (const [source, expected = true] of commitCases) {
  test('commit ' + JSON.stringify(source), () => {
    const { targets, incomplete } = findGitCommits(source, options);
    assert.equal(incomplete, null);
    assert.equal(targets.length > 0, expected);
    if (expected) assert.ok(targets.some(({ cwd }) => cwd === repo));
  });
}
for (const [source, expected = true] of heavyCases) {
  test('heavy ' + JSON.stringify(source), () => assert.equal(classify(source).heavy, expected));
}
for (const [source, slug = 'alpha', sub = 'new'] of chatCases) {
  test('chat ' + JSON.stringify(source), () => {
    assert.deepEqual(extractChatSlug(source), slug ? { slug, via: 'chat.sh ' + sub } : null);
  });
}

test('cwd and repository selectors are command scoped and retain every commit target', () => {
  const cases = [
    ["env -C 'repo space/nested' git commit -m x", [path.join(repo, 'nested')]],
    ["git -C 'repo space' -C nested commit -m x", [path.join(repo, 'nested')]],
    ["command cd 'repo space'; git commit -m x", [repo]],
    ["time cd 'repo space'; git commit -m x", [repo]],
    ["builtin cd 'repo space'; git commit -m x", [repo]],
    ["draft() { cd \"$1\"; }; draft 'repo space'; git commit -m x", [repo]],
    ["{ cd 'repo space'; }; git commit -m x", [repo]],
    ["env cd 'repo space'; git commit -m x", [root]],
    ["env -C other git commit -m first; git -C 'repo space' commit -m second", [other, repo]],
    ["bash -c 'git -C other commit -m first'; git -C 'repo space' commit -m second", [other, repo]],
    ["git -C other commit -m first; git -C 'repo space' commit -m second", [other, repo]],
  ];
  for (const [source, dirs] of cases) {
    const { targets, incomplete } = findGitCommits(source, { ...options, cwd: root });
    assert.equal(incomplete, null, source);
    assert.deepEqual(targets.map(({ cwd }) => cwd), dirs, source);
  }
  const select = [
    ["git --git-dir 'repo space/.git' --work-tree 'repo space' commit -m x", 'repo space/.git', 'repo space'],
    ["GIT_DIR='repo space/.git' GIT_WORK_TREE='repo space' git commit -m x", 'repo space/.git', 'repo space'],
    ['git --git-dir "$PWD/.git" --work-tree "$PWD" commit -m x', repo + '/.git', repo],
    ['GIT_DIR="$(git rev-parse --absolute-git-dir)" git commit -m x', undefined, undefined],
  ];
  for (const [source, gitDir, workTree] of select) {
    const { targets: [target], incomplete } = findGitCommits(source, options);
    assert.equal(incomplete, null, source);
    assert.equal(target.gitDir, gitDir, source);
    assert.equal(target.workTree, workTree, source);
  }
});

const secret = 'demo-1aB2c';
const credentials = [
  (s) => 'curl -u ' + s + ' https://example.test',
  (s) => 'curl --user="' + s + '" https://example.test',
  (s) => "curl -u 'user:" + s + "' https://example.test",
  (s) => 'mysql -p' + s,
  (s) => 'mariadb -p"' + s + '"',
];
for (const wrap of executing) {
  for (const make of credentials) {
    const source = wrap(make(secret));
    // Single quotes cannot be nested inside the shell string added by this rewrite.
    if (source.startsWith('bash -O') && make(secret).includes("'")) continue;
    test('mask ' + JSON.stringify(source), () => assert.ok(!redact(source).includes(secret)));
  }
}
for (const source of [
  'API_KEY="' + secret + '" cmd',
  'cmd "client-secret: ' + secret + '"',
  'curl https://user:' + secret + '@example.test/api',
  'curl -H "Authorization: Basic ' + secret + '"',
  'cmd Bearer ' + secret,
  'echo ghp_AbcDEfgh1234567890123456',
  "curl --user 'user:safe\\\n example'",
  "bash -o noexce -c 'curl --user " + secret + "'",
]) {
  test('redaction marker ' + JSON.stringify(source), () => {
    assert.ok(redact(source).includes('‹redacted›'));
    assert.ok(!redact(source).includes(secret));
  });
}
for (const source of [
  'echo curl -u worker:safe', 'curl -- -u worker:safe', 'mysql -p account',
  'echo "git commit; curl -u worker:safe"', 'npm install project-with-a-long-readable-name-v2',
  'echo https://example.test/a', 'git checkout refs/heads/abcdef0123456789abcdef0123456789abcdef01',
]) {
  test('literal ' + JSON.stringify(source), () => assert.equal(redact(source), source));
}

test('seeded malformed input and benign whitespace rewrites', () => {
  let seed = 113;
  function pick(values) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[(seed >>> 12) % values.length];
  }
  const chunks = ['"', "'", ' ', '\t', '\n', '#', '<<', '>>>', '&&', '|', '$(', ')', '\\', 'x', 'git', '{}'];
  const signature = (source) => shellCommands(source, options).map(({ tool, args }) => [tool, args.map(({ value }) => value)]);
  const canonical = 'env -u CI git commit ; printf ok | npm test';
  for (let i = 0; i < 250; i++) {
    const malformed = Array.from({ length: i % 41 }, () => pick(chunks)).join('');
    assert.doesNotThrow(() => shellCommands(malformed, options));
    assert.doesNotThrow(() => findGitCommits(malformed, options));
    assert.doesNotThrow(() => redact(malformed));
    const rewritten = canonical.split(' ').reduce((line, word) => (
      line ? line + pick([' ', '  ', '\t', ' \\\n ']) + word : word
    ), '');
    assert.deepEqual(signature(rewritten), signature(canonical));
    assert.deepEqual(findGitCommits(rewritten, options), findGitCommits(canonical, options));
    const value = 'leaf-' + i + '-aBc';
    const credential = pick(credentials)(value);
    assert.ok(!redact('env -u CI ' + credential + ' # ' + pick(chunks)).includes(value), credential);
  }
  assert.doesNotThrow(() => shellCommands('echo ' + '$('.repeat(1024), options));
});

const incompleteCases = [
  ["printf '%s' $((1 + $(", /unterminated/i],
  ["printf '%s' 'open", /unterminated/i],
  ['echo "$(printf partial"', /unterminated/i],
  ["cat <<'EOF'\nbody", /here-document/i],
  ['true && \n # no command', /operator/i],
  ['if true; then printf example', /unterminated/i],
  ['case key in key) printf key;;', /unterminated/i],
  ['printf %s "${VAR', /unterminated/i],
  ['echo ' + '$('.repeat(80) + 'true' + ')'.repeat(80), /limit/i],
  ['('.repeat(80) + 'true' + ')'.repeat(80), /limit/i],
  ['f() { f; }; f', /limit/i],
  [Array.from({ length: 10 }, (_, i) => 'maybe && V' + i + '=value').join('; '), /limit/i],
];
for (const [source, reason] of incompleteCases) {
  test('guard blocks incomplete analysis of ' + JSON.stringify(source.slice(0, 72)), () => {
    const guard = fileURLToPath(new URL('../guard.mjs', import.meta.url));
    const input = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: source } });
    const actual = spawnSync(process.execPath, [guard, 'hook'], { input, encoding: 'utf8' });
    assert.equal(actual.status, 2, actual.stderr);
    assert.match(actual.stderr, /guard: BLOCK.*shell analysis/i);
    assert.match(actual.stderr, reason);
    assert.match(findGitCommits(source, options).incomplete ?? '', reason);
    assert.doesNotThrow(() => shellCommands(source, options));
  });
}

test('guard hook returns a block when analysis raises an exception', () => {
  const guard = fileURLToPath(new URL('../guard.mjs', import.meta.url));
  const actual = spawnSync(process.execPath, [guard, 'hook'], { input: '{', encoding: 'utf8' });
  assert.equal(actual.status, 2, actual.stderr);
  assert.match(actual.stderr, /guard: BLOCK.*shell analysis/i);
});

for (const [subject, pattern, expected] of [
  ['b', '[a-c]', ['matched']],
  ['z', '[!a-c]', ['matched']],
  ['b', '[!a-c]', ['fallback']],
  ['prefix42', '"prefix"*', ['matched']],
  ['prefix42', '"prefix*"', ['fallback']],
  ['b', '[a\\-c]', ['fallback']],
  ["'-'", '[a\\-c]', ['matched']],
  ["']'", '[]x]', ['matched']],
  ['b', '"[a-c]"', ['fallback']],
  ['b', '[[:alpha:]]', ['matched', 'fallback']],
  ['b', 'b|[[:alpha:]]', ['matched']],
]) {
  test('case matches ' + subject + ' against ' + pattern, () => {
    const source = 'case ' + subject + ' in ' + pattern + ') printf matched;; *) printf fallback;; esac';
    const printed = shellCommands(source, options).filter(({ tool }) => tool === 'printf');
    assert.deepEqual(printed.map(({ args }) => args[0].value), expected);
  });
}

test('preserves both branches when an extended pattern cannot be decided statically', () => {
  const source = "bash -O extglob -c 'case b in @(a|b)) printf matched;; *) printf fallback;; esac'";
  const printed = shellCommands(source, options).filter(({ tool }) => tool === 'printf');
  assert.deepEqual(printed.map(({ args }) => args[0].value), ['matched', 'fallback']);
  assert.equal(findGitCommits(source, options).incomplete, null);
});

const proxyCredential = 'fixture:synthetic-credential-fixture';
const curlCredentials = [
  'curl --proxy-user "' + proxyCredential + '"',
  'curl --proxy-user="' + proxyCredential + '"',
  'curl -U "' + proxyCredential + '"',
  'curl -U"' + proxyCredential + '"',
  'curl -su "' + proxyCredential + '"',
  'curl -su"' + proxyCredential + '"',
  'curl -vsU "' + proxyCredential + '"',
  'curl -sU"' + proxyCredential + '"',
  'curl -spU"' + proxyCredential + '"',
];
for (const source of curlCredentials) {
  test('redacts curl credentials in ' + source.split('fixture:')[0], () => {
    const output = redact(source);
    assert.ok(output.includes('‹redacted›'));
    assert.ok(!output.includes(proxyCredential));
  });
}
for (const source of [
  'curl -sHuser-agent',
  'curl -sH -u public',
  'curl -- -sUpublic',
]) {
  test('keeps curl data in ' + source, () => assert.equal(redact(source), source));
}

test('both hooks apply the shared parser at their normal entry points', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-parser-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const checkout = path.join(scratch, 'repo space');
  const chat = path.join(scratch, 'chat');
  const status = path.join(chat, 'status');
  const identity = path.join(chat, 'identity');
  const migrations = path.join(checkout, 'migrations');
  mkdirSync(migrations, { recursive: true });
  mkdirSync(path.join(checkout, 'nested'));
  mkdirSync(status, { recursive: true });
  mkdirSync(identity);
  const env = { ...process.env, CHAT_DIR: chat, ZM_REPO: checkout,
    ZM_REPO_COMMON: path.join(checkout, '.git'), ZM_MIG_DIR: 'migrations', ZM_HUMAN: 'human' };
  for (const name of [...Object.keys(env).filter((key) => key.startsWith('GIT_')), 'ZM_SLUG']) delete env[name];
  function git(...args) {
    const result = spawnSync('git', ['-C', checkout, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
  git('init', '-b', 'main');
  git('config', 'user.email', 'parser@example.test');
  git('config', 'user.name', 'Parser Fixture');
  writeFileSync(path.join(migrations, '005_base.sql'), '-- base\n');
  git('add', 'migrations');
  git('commit', '-m', 'Base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(migrations, '003_bad.sql'), '-- staged\n');
  git('add', 'migrations/003_bad.sql');

  function hook(tool, command, cwd = checkout, sid = 'guard-corpus') {
    const file = fileURLToPath(new URL('../' + tool + '.mjs', import.meta.url));
    const args = tool === 'guard' ? [file, 'hook'] : [file];
    const input = JSON.stringify({
      cwd, session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
    });
    return spawnSync(process.execPath, args, { input, env, encoding: 'utf8' });
  }
  for (const command of [
    "env -C 'repo space/nested' git commit -m x",
    "git -C 'repo space' -C nested commit -m x",
    "git --git-dir 'repo space/.git' --work-tree 'repo space' commit -m x",
    "GIT_DIR='repo space/.git' GIT_WORK_TREE='repo space' git commit -m x",
    "git -C .. commit -m first; git -C 'repo space' commit -m second",
    "bash -c 'git -C .. commit -m first'; git -C 'repo space' commit -m second",
    "command cd 'repo space'; git commit -m x",
    "time cd 'repo space'; git commit -m x",
    "builtin cd 'repo space'; git commit -m x",
  ]) {
    const result = hook('guard', command, scratch);
    assert.equal(result.status, 2, command + '\n' + result.stderr);
    assert.match(result.stderr, /003_bad.sql.*origin\/main's highest \(005\)/, command);
  }
  function identityFile(sid) {
    return path.join(identity, sid + '.json');
  }
  function identityOf(sid) {
    return JSON.parse(readFileSync(identityFile(sid), 'utf8')).slug;
  }
  function capture(command, sid, cwd = checkout) {
    const result = hook('capture', command, cwd, sid);
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }
  writeFileSync(path.join(status, 'alpha.md'), '# alpha\n');
  writeFileSync(path.join(status, 'bravo.md'), '# bravo\n');
  capture("C=./chat.sh; bash '$C' new alpha", 'quoted', scratch);
  capture(bravo, 'quoted', scratch);
  capture(alpha, 'quoted', scratch);
  assert.equal(identityOf('quoted'), 'bravo');
  for (const sid of ['malformed', 'abandoned', 'missing', 'interrupted', 'damaged-claim']) {
    if (sid !== 'missing') writeFileSync(identityFile(sid), '{');
    if (sid === 'interrupted') writeFileSync(identityFile(sid) + '.claim', JSON.stringify({ slug: 'bravo' }));
    if (sid === 'damaged-claim') writeFileSync(identityFile(sid) + '.claim', '{');
    if (sid === 'abandoned' || sid === 'missing') {
      const lock = identityFile(sid) + '.lock';
      mkdirSync(lock);
      const old = new Date(Date.now() - 3600_000);
      utimesSync(lock, old, old);
    }
    capture(alpha, sid, scratch);
    assert.equal(identityOf(sid), sid === 'interrupted' ? 'bravo' : 'alpha');
  }

  const full = checkout.replaceAll('\\', '/');
  const prior = full + '-old';
  const last = full + '-last';
  const drive = process.platform === 'win32' ? full.replace(/^([a-z]):/i, (_, letter) => '/' + letter.toLowerCase()) : full;
  const declarations = [
    'Worktrees/branches: ' + prior + ' -> other; ' + full + ' -> main',
    'Worktrees/branches: ' + prior + ' -> feature;preview; ' + full + ' -> main',
    'Worktrees/branches: ' + prior + ';subdir -> other; ' + full + ' -> main',
    'Worktrees/branches:\r\n- ' + prior + ' -> other\r\n\r\n- ' + full + ' -> main',
    'Worktrees/branches: ' + prior + ' -> other;' + drive + ' -> main; ' + last + ' -> last',
  ];
  for (const [index, declaration] of declarations.entries()) {
    writeFileSync(path.join(status, 'bravo.md'), '# bravo\n' + declaration + '\nWork: fixture\n');
    capture('git log', 'worktree-' + index);
  }
  const activity = path.join(chat, 'activity');
  const records = readdirSync(activity).flatMap((day) => {
    const file = path.join(activity, day, 'bravo.jsonl');
    return readdirSync(path.dirname(file)).includes(path.basename(file)) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  }).map((line) => JSON.parse(line));
  assert.deepEqual(records.filter(({ sid }) => sid.startsWith('worktree-')).map(({ sid }) => sid),
    declarations.map((_, index) => 'worktree-' + index));

  const checks = curlCredentials.map((command, index) => {
    const sid = 'curl-credential-' + index;
    capture(command, sid);
    return sid;
  });
  const persisted = readdirSync(activity).flatMap((day) =>
    readFileSync(path.join(activity, day, 'bravo.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
  for (const sid of checks) {
    const record = persisted.find((event) => event.sid === sid);
    assert.ok(record?.cmd.includes('‹redacted›'));
    assert.ok(!record.cmd.includes(proxyCredential));
  }
});
