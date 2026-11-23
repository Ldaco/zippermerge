// node bin/test/capture-next.test.mjs : exits 0 on pass, 1 on failure. Uses only a scratch dir under os.tmpdir().
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'capture.mjs');
const { extractChatSlug, redact } = await import(pathToFileURL(script).href);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.error(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`);
};

const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-test-'));
const chat = path.join(scratch, 'chat');
const repo = path.join(scratch, 'repo; archive');
mkdirSync(path.join(chat, 'status'), { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(path.join(chat, 'status', 'fed.md'), '# fed\nWorktrees: C:/code/app-wt/style-x\n');
writeFileSync(path.join(chat, 'status', 'alpha.md'), '# alpha\n');
const git = spawnSync('git', ['init', '-q', repo]);
if (git.status !== 0) { console.error('git init failed'); process.exit(1); }

const env = {
  ...process.env,
  CHAT_DIR: chat,
  ZM_REPO: repo,
  ZM_REPO_COMMON: path.join(repo, '.git'),
  TMPDIR: scratch,
  TEMP: scratch,
  TMP: scratch,
};
delete env.ZM_SLUG;

function fire(payload, cwd = repo, raw, overrides) {
  return spawnSync('node', [script], {
    input: raw ?? JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, ...payload,
    }),
    env: { ...env, ...overrides },
    encoding: 'utf8',
  });
}
const identityOf = (sid) => {
  const f = path.join(chat, 'identity', `${sid}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};

try {
  // identity learning, outside the repo scope (cwd = scratch, not a repo)
  let r = fire({ session_id: 'sess-a', tool_input: { command: 'bash /c/chat/chat.sh new fed' } }, scratch);
  check('learn from chat.sh new fed', identityOf('sess-a')?.slug === 'fed' && identityOf('sess-a')?.via === 'chat.sh new', JSON.stringify(identityOf('sess-a')));
  check('exit 0 no output', r.status === 0 && r.stdout === '' && r.stderr === '');

  fire({ session_id: 'sess-b', tool_input: { command: 'C=/c/chat/chat.sh; cd x && bash $C post alpha note "hi && there"' } }, scratch);
  check('learn from $C post alpha', identityOf('sess-b')?.slug === 'alpha', JSON.stringify(identityOf('sess-b')));

  fire({ session_id: 'sess-c', tool_input: { command: 'cd /tmp && bash C:\\zippermerge\\chat.sh lock main-freeze fed "why"' } }, scratch);
  check('learn from lock main-freeze fed', identityOf('sess-c')?.slug === 'fed', JSON.stringify(identityOf('sess-c')));

  fire({ session_id: 'sess-d', tool_input: { command: 'bash /c/chat/chat.sh guard --slug alpha' } }, scratch);
  check('learn from guard --slug', identityOf('sess-d')?.slug === 'alpha');

  fire({ session_id: 'sess-e', tool_input: { command: 'bash /c/chat/chat.sh new human' } }, scratch);
  check('refuse the human', identityOf('sess-e') === null);
  fire({ session_id: 'sess-f', tool_input: { command: 'bash /c/chat/chat.sh new ghost' } }, scratch);
  check('refuse slug without status file', identityOf('sess-f') === null);
  fire({ session_id: 'sess-g', tool_input: { command: 'echo "chat.sh new fed"' } }, scratch);
  check('quoted text is not an invocation', identityOf('sess-g') === null);

  check('nothing recorded outside scope', !existsSync(path.join(chat, 'activity')));

  // resolution via identity file for a later in-scope event
  fire({ session_id: 'sess-a', tool_input: { command: 'git status' } });
  const act = path.join(chat, 'activity');
  const days = existsSync(act) ? readdirSync(act) : [];
  const files = days.flatMap((d) => readdirSync(path.join(act, d)));
  check('later event attributed to fed', files.includes('fed.jsonl'), files.join(','));
  fire({ session_id: 'zzzzzzzz-unknown', tool_input: { command: 'git status' } });
  const files2 = readdirSync(act).flatMap((d) => readdirSync(path.join(act, d)));
  check('unknown session falls back to unknown-prefix', files2.includes('unknown-zzzzzzzz.jsonl'), files2.join(','));

  // --block-only does not record but may learn
  const before = JSON.stringify(readdirSync(act).flatMap((d) => readdirSync(path.join(act, d)).map((f) => `${d}/${f}:${readFileSync(path.join(act, d, f), 'utf8').length}`)));
  spawnSync('node', [script, '--block-only'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, session_id: 'sess-h', tool_input: { command: 'bash /c/chat/chat.sh new alpha' },
    }),
    env,
    encoding: 'utf8',
  });
  const after = JSON.stringify(readdirSync(act).flatMap((d) => readdirSync(path.join(act, d)).map((f) => `${d}/${f}:${readFileSync(path.join(act, d, f), 'utf8').length}`)));
  check('--block-only learns but does not record', identityOf('sess-h')?.slug === 'alpha' && before === after);

  const nonCommands = {
    heredoc: "git commit -F - <<'MESSAGE'\nbash /z/chat.sh new alpha\nMESSAGE",
    comment: 'ls # then bash /z/chat.sh new alpha; ls',
    echo: 'echo run bash /z/chat.sh new alpha > out.txt',
    grep: 'grep -n chat.sh post alpha',
    'escaped-separator': 'echo text \\; bash /z/chat.sh new alpha',
  };
  for (const [kind, command] of Object.entries(nonCommands)) {
    const sid = 'non-command-' + kind;
    fire({ session_id: sid, tool_input: { command } }, scratch);
    check('ignores non-command text in ' + kind, identityOf(sid) === null);
  }
  const afterHeredocs = [
    "cat <<FIRST <<- 'SECOND'",
    'body',
    'FIRST',
    '\tbash /z/chat.sh new alpha',
    '\tSECOND',
    '/z/chat.sh new fed # done',
  ].join('\r\n');
  fire({
    session_id: 'after-heredocs',
    tool_input: { command: afterHeredocs },
  }, scratch);
  check('resumes at a command after multiple heredocs', identityOf('after-heredocs')?.slug === 'fed');
  fire({ session_id: 'sess-a', tool_input: { command: 'sh /z/chat.sh new alpha' } }, scratch);
  check('keeps an existing session identity', identityOf('sess-a')?.slug === 'fed');

  // Review regressions for shell words and identity recovery.
  writeFileSync(path.join(scratch, 'chat.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(chat, 'status', 'bravo.md'), '# bravo\n');
  const literalOperands = {
    'single-quoted': "'$C'",
    'escaped-double-quoted': '"\\$C"',
    'escaped-unquoted': '\\$C',
    'ansi-c-quoted': "$'$C'",
  };
  for (const [kind, operand] of Object.entries(literalOperands)) {
    const sid = 'literal-' + kind;
    fire({ session_id: sid, tool_input: { command: 'C=./chat.sh; bash ' + operand + ' new alpha' } }, scratch);
    check('leaves the ' + kind + ' variable literal', identityOf(sid) === null);
    fire({ session_id: sid, tool_input: { command: 'bash ./chat.sh new bravo' } }, scratch);
    check('learns bravo from a later real call after a ' + kind + ' variable', identityOf(sid)?.slug === 'bravo');
  }
  const realCalls = [
    'bash -e ./chat.sh new alpha',
    'command bash ./chat.sh new alpha',
    'env LANG=C bash ./chat.sh new alpha',
    'command -p env -u LANGUAGE LANG=C sh -eu -o pipefail -- ./chat.sh new alpha',
    'C=./chat.sh; SLUG=alpha; bash "$C" new "${SLUG}"',
  ];
  for (const command of realCalls) {
    check('recognizes invocation: ' + command, extractChatSlug(command)?.slug === 'alpha');
  }
  const argumentOnly = [
    'bash -c echo ./chat.sh new alpha',
    'sh -s ./chat.sh new alpha',
    'bash -n ./chat.sh new alpha',
    'bash --rcfile ./chat.sh another.sh new alpha',
    'command -v ./chat.sh new alpha',
    'env --help ./chat.sh new alpha',
    'C=./chat.sh echo ignore; bash "$C" new alpha',
  ];
  for (const command of argumentOnly) {
    check('ignores non-script operands: ' + command, extractChatSlug(command) === null);
  }
  const corruptIdentity = path.join(chat, 'identity', 'malformed.json');
  writeFileSync(corruptIdentity, '{');
  const identityLock = corruptIdentity + '.lock';
  mkdirSync(identityLock);
  fire({ session_id: 'malformed', tool_input: { command: 'bash ./chat.sh new bravo' } }, scratch);
  check('defers repair while another hook holds the identity lock', readFileSync(corruptIdentity, 'utf8') === '{');
  rmdirSync(identityLock);
  fire({ session_id: 'malformed', tool_input: { command: 'bash ./chat.sh new alpha' } }, scratch);
  const repaired = readFileSync(corruptIdentity, 'utf8');
  check('repairs an invalid identity record', repaired !== '{' && JSON.parse(repaired).slug === 'alpha');
  fire({ session_id: 'malformed', tool_input: { command: 'bash ./chat.sh new bravo' } }, scratch);
  check('preserves a repaired identity', readFileSync(corruptIdentity, 'utf8') === repaired && repaired !== '{');

  // Compare identity learning with the arguments actually delivered by Bash.
  const scratchScript = '#!/bin/sh\nprintf "invoked:%s\\n" "$*"\n';
  writeFileSync(path.join(scratch, 'chat.sh'), scratchScript);
  mkdirSync(path.join(scratch, 'two words'));
  writeFileSync(path.join(scratch, 'two words', 'chat.sh'), scratchScript);
  const continuedHeredoc = ['cat <<EOF', 'body\\', 'EOF', 'bash ./chat.sh new alpha', 'EOF'].join('\n');
  const shellReviewCases = [
    ['subshell assignments', 'SLUG=bravo; (SLUG=alpha); bash ./chat.sh new "$SLUG"', 'bravo'],
    ['substitution assignments', 'SLUG=bravo; : $(SLUG=alpha); bash ./chat.sh new "$SLUG"', 'bravo'],
    ['pipeline assignments', 'SLUG=bravo; SLUG=alpha | cat; bash ./chat.sh new "$SLUG"', 'bravo'],
    ['grouped pipeline assignments', 'SLUG=bravo; { SLUG=alpha; :; } | cat; bash ./chat.sh new "$SLUG"', 'bravo'],
    ['local subshell variables', 'SLUG=bravo; (SLUG=alpha; bash ./chat.sh new "$SLUG")', 'alpha'],
    ['unquoted script path', 'C="./two words/chat.sh"; bash $C new alpha', null],
    ['quoted script path', 'C="./two words/chat.sh"; bash "$C" new alpha', 'alpha'],
    ['split expansion before a script', 'C="-e ./chat.sh"; bash $C new alpha', 'alpha'],
    ['ANSI-C path and slug escapes', "bash $'./ch\\x61t.sh' new $'a\\154ph\\u0061'", 'alpha'],
    ['named noexec', 'bash -o noexec ./chat.sh new alpha', null],
    ['reset noexec', 'bash +n ./chat.sh new alpha', 'alpha'],
    ['toggle noexec in option order', 'bash -en +o noexec ./chat.sh new alpha', 'alpha'],
    ['unquoted continued heredoc', continuedHeredoc, null],
    ['real call after continued heredoc', continuedHeredoc + '\nbash ./chat.sh new bravo', 'bravo'],
    ['quoted heredoc delimiter', continuedHeredoc.replace('<<EOF', "<<'EOF'"), 'alpha'],
    ['delimiter split across physical lines', ['cat <<EOF', 'EO\\', 'F', 'bash ./chat.sh new bravo'].join('\n'), 'bravo'],
    ['if condition', 'if bash ./chat.sh new alpha; then :; fi', 'alpha'],
    ['until condition', 'until bash ./chat.sh new alpha; do break; done', 'alpha'],
    ['elif condition', 'if false; then :; elif bash ./chat.sh new bravo; then :; fi', 'bravo'],
    ['control keywords in arguments', 'echo if bash ./chat.sh new alpha then; echo until bash ./chat.sh new alpha', null],
    ['untaken then', 'if false; then bash ./chat.sh new alpha; fi; bash ./chat.sh new bravo', 'bravo'],
    ['untaken else', 'if true; then :; else bash ./chat.sh new alpha; fi; bash ./chat.sh new bravo', 'bravo'],
    ['untaken elif condition', 'if true; then :; elif bash ./chat.sh new alpha; then :; fi; bash ./chat.sh new bravo', 'bravo'],
    ['untaken while body', 'while false; do bash ./chat.sh new alpha; done; bash ./chat.sh new bravo', 'bravo'],
    ['untaken until body', 'until true; do bash ./chat.sh new alpha; done; bash ./chat.sh new bravo', 'bravo'],
    ['known entered branch', 'if true; then bash ./chat.sh new alpha; fi; bash ./chat.sh new bravo', 'alpha'],
    ['short-circuited list', 'false && bash ./chat.sh new alpha; true || bash ./chat.sh new alpha; bash ./chat.sh new bravo', 'bravo'],
    ['unknown guard leaves later literal observable', '[ -f ./chat.sh ] && bash ./chat.sh new alpha; bash ./chat.sh new bravo', 'alpha', 'bravo'],
    ['untaken guarded substitution', 'if false; then printf "%s\n" "$(bash ./chat.sh new alpha)"; fi; bash ./chat.sh new bravo', 'bravo'],
    ['taken branch updates parent variables', 'SLUG=alpha; if true; then SLUG=bravo; fi; bash ./chat.sh new "$SLUG"', 'bravo'],
    ['untaken branch preserves parent variables', 'SLUG=bravo; if false; then SLUG=alpha; fi; bash ./chat.sh new "$SLUG"', 'bravo'],
    ['unknown branch invalidates assigned values', 'SLUG=alpha; if [ -f ./chat.sh ]; then SLUG=bravo; fi; bash ./chat.sh new "$SLUG"', 'bravo', null],
    ['export updates existing value', 'SLUG=bravo; export SLUG=alpha; bash ./chat.sh new "$SLUG"', 'alpha'],
    ['export preserves quoted assignment', 'SLUG=bravo; export "SLUG=alpha"; bash ./chat.sh new "$SLUG"', 'alpha'],
    ['unset clears existing value', 'SLUG=alpha; unset SLUG; bash ./chat.sh new "$SLUG"', '', null],
    ['unset flags and parent scope', 'SLUG=bravo; (unset -v SLUG); bash ./chat.sh new "$SLUG"', 'bravo'],
    ['double-quoted substitution', 'printf "%s\\n" "$(bash ./chat.sh new alpha)"', 'alpha'],
    ['nested double-quoted substitution', 'printf "%s\\n" "$(printf "%s" "$(bash ./chat.sh new alpha)")"', 'alpha'],
    ['unquoted substitution', 'out=$(bash ./chat.sh new alpha)', null, 'alpha'],
    ['literal single-quoted substitution', "printf '%s\\n' '$(bash ./chat.sh new alpha)'", null],
    ['literal escaped substitution', 'printf "%s\\n" "\\$(bash ./chat.sh new alpha)"', null],
    ['unknown set option', 'bash -o noexce ./chat.sh new alpha', null],
    ['unknown shopt option', 'bash -O noexce ./chat.sh new alpha', null],
    ['known shopt option', 'bash -O extglob ./chat.sh new alpha', 'alpha'],
  ];
  for (const [index, [name, command, expected, learned = expected]] of shellReviewCases.entries()) {
    const actual = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
      cwd: scratch, env: { ...env, BASH_ENV: '' }, encoding: 'utf8', timeout: 5000,
    });
    const delivered = /^invoked:new(?: ([a-z]*))?\r?$/m.exec(actual.stdout || '');
    const slug = delivered ? delivered[1] ?? '' : null;
    check('Bash fixture: ' + name, !actual.error && slug === expected, actual.stderr?.trim());
    const sid = 'shell-review-' + index;
    fire({ session_id: sid, tool_input: { command } }, scratch);
    check('identity follows safe shell inference: ' + name, (identityOf(sid)?.slug ?? null) === learned);
  }

  for (const corrupt of [true, false]) {
    const sid = corrupt ? 'interrupted-malformed' : 'interrupted-first-write';
    const file = path.join(chat, 'identity', sid + '.json');
    if (corrupt) writeFileSync(file, '{');
    const abandonedLock = file + '.lock';
    mkdirSync(abandonedLock);
    const staleLockTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(abandonedLock, staleLockTime, staleLockTime);
    fire({ session_id: sid, tool_input: { command: 'bash ./chat.sh new alpha' } }, scratch);
    const record = existsSync(file) ? readFileSync(file, 'utf8') : '';
    check('recovers from an abandoned lock for ' + sid, record !== '' && record !== '{' && JSON.parse(record).slug === 'alpha');
  }
  const interruptedSid = 'interrupted-after-election';
  const claim = path.join(chat, 'identity', interruptedSid + '.json.claim');
  writeFileSync(claim, JSON.stringify({ slug: 'alpha', at: new Date().toISOString(), via: 'chat.sh new' }));
  fire({ session_id: interruptedSid, tool_input: { command: 'bash ./chat.sh new bravo' } }, scratch);
  check('finishes an interrupted election with its original slug', identityOf(interruptedSid)?.slug === 'alpha');
  for (const [name, primary, elected, expected] of [
    ['corrupt-primary', '{', '{', 'alpha'],
    ['absent-primary', null, '{', 'alpha'],
    ['valid-primary', JSON.stringify({ slug: 'bravo' }), '{', 'bravo'],
  ]) {
    const sid = 'corrupt-election-' + name;
    const file = path.join(chat, 'identity', sid + '.json');
    if (primary !== null) writeFileSync(file, primary);
    writeFileSync(file + '.claim', elected);
    fire({ session_id: sid, tool_input: { command: 'bash ./chat.sh new alpha' } }, scratch);
    const data = existsSync(file) ? readFileSync(file, 'utf8') : '{';
    check('recovers or preserves identity: ' + name, data !== '{' && JSON.parse(data).slug === expected);
  }

  const statuses = path.join(chat, 'status');
  writeFileSync(path.join(statuses, 'alpha.md'),
    '# alpha\nWorktrees/branches: ' + repo + '-feature -> feature\nWork: Reviewing ' + repo + '\n');
  writeFileSync(path.join(statuses, 'nested.md'), '# nested\nWorktrees/branches: ' + path.join(repo, 'child') + ' -> child\n');
  writeFileSync(path.join(statuses, 'other.md'), '# other\nWorktrees: ' + path.join(scratch, 'elsewhere', path.basename(repo)) + '\n');
  writeFileSync(path.join(statuses, 'short.md'), '# short\nWorktrees: ' + path.basename(repo) + '\n');
  const recordedFor = (slug) => readdirSync(act).some((day) => existsSync(path.join(act, day, slug + '.jsonl')));
  fire({ session_id: 'by-name', tool_input: { command: 'git status' } });
  check('accepts a unique bare worktree name in the legacy field', recordedFor('short'));
  writeFileSync(path.join(statuses, 'owner.md'), '# owner\nWorktrees/branches:\n- ' + repo + ' -> main\n');
  fire({ session_id: 'by-worktree', tool_input: { command: 'git status' } });
  check('prefers the exact declared worktree path over a bare name', recordedFor('owner'));
  writeFileSync(path.join(statuses, 'duplicate.md'), '# duplicate\nWorktrees: ' + repo + '\n');
  fire({ session_id: 'ambiguous', tool_input: { command: 'git status' } });
  check('leaves an ambiguous exact worktree path unresolved', recordedFor('unknown-ambiguou'));

  // Review regressions for alternative worktree declarations.
  rmSync(path.join(statuses, 'owner.md'), { force: true });
  rmSync(path.join(statuses, 'duplicate.md'), { force: true });
  const multiStatus = path.join(statuses, 'multi.md');
  writeFileSync(multiStatus, '# multi\nWorktrees/branches: ' + repo + '-other -> other; ' + repo + ' -> main\n');
  fire({ session_id: 'second-entry-only', tool_input: { command: 'git status' } });
  check('finds the second worktree entry on a single line', recordedFor('multi'));
  rmSync(multiStatus);
  if (process.platform === 'win32') {
    const nativeStatus = path.join(statuses, 'native.md');
    writeFileSync(nativeStatus, '# native\nWorktrees/branches: ' + repo + ' -> main\n');
    fire({ session_id: 'native-drive', tool_input: { command: 'git status' } });
    check('accepts a native Windows drive path', recordedFor('native'));
    rmSync(nativeStatus);
    const gitBashPath = repo.replace(/\\/g, '/').replace(/^([A-Z]):\//i, '/$1/');
    writeFileSync(path.join(statuses, 'git-bash.md'), '# git-bash\nWorktrees/branches: ' + gitBashPath + ' -> main\n');
    fire({ session_id: 'drive-alias', tool_input: { command: 'git status' } });
    check('accepts a Git Bash drive path', recordedFor('git-bash'));
  }

  const isolatedChat = path.join(scratch, 'one-status');
  mkdirSync(path.join(isolatedChat, 'status'), { recursive: true });
  const soleStatus = path.join(isolatedChat, 'status', 'bravo.md');
  const nativePath = repo.replace(/\\/g, '/');
  const slashRootPath = nativePath.replace(/^([A-Z]):\//i, '/$1/');
  const statusReviewCases = [
    ['simple-list', ' ' + nativePath + '-other -> other; ' + nativePath + ' -> main'],
    ['branch-semicolon', ' ' + nativePath + '-other -> feature;preview; ' + nativePath + ' -> main'],
    ['path-and-branch-semicolons', ' ' + nativePath + '; archive -> feature;preview; ' + nativePath + ' -> main'],
    ['blank-markdown-line', '\r\n- ' + nativePath + '-other -> other\r\n\r\n- ' + nativePath + ' -> main'],
    ['mixed-separators', ' ' + nativePath + '-other -> other;' + slashRootPath + ' -> main; ' + nativePath + '-last -> last'],
    ['branch-with-path-like-semicolon', ' ' + nativePath + '-other -> feature;/preview; ' + nativePath + ' -> main'],
  ];
  for (const [name, declaration] of statusReviewCases) {
    const sid = 'status-' + name;
    writeFileSync(soleStatus, '# bravo\r\nWorktrees/branches:' + declaration + '\r\nWork: fixture\r\n');
    fire({ session_id: sid, tool_input: { command: 'git status' } }, repo, undefined, { CHAT_DIR: isolatedChat });
    const activity = path.join(isolatedChat, 'activity');
    const attributed = existsSync(activity) && readdirSync(activity).some((day) => {
      const file = path.join(activity, day, 'bravo.jsonl');
      return existsSync(file) && readFileSync(file, 'utf8').split('\n').some((line) => line && JSON.parse(line).sid === sid);
    });
    check('finds the exact path with sole status: ' + name, attributed);
  }

  const now = Date.now();
  const recent = new Date(now - 60000).toISOString();
  const stale = new Date(now - 31 * 60000).toISOString();
  const otherDay = path.join(act, recent.slice(0, 10).replace(/-/g, ''));
  mkdirSync(otherDay, { recursive: true });
  const editLine = (ts, file) => JSON.stringify({ ts, event: 'edit', file, worktree: 'other-wt' }) + '\n';
  const bashLine = JSON.stringify({ ts: recent, event: 'bash' }) + '\n';
  writeFileSync(path.join(otherDay, 'other.jsonl'),
    editLine(recent, 'hot.ts') + bashLine.repeat(450) + 'invalid json\n' + editLine(stale, 'stale.ts')
    + editLine(recent, 'Src/X.ts'));
  const edit = (file) => fire({
    session_id: 'sess-a', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file },
  }).stdout;
  check('warns about recent edits below more than 400 newer entries', edit('hot.ts').includes('other also edited hot.ts'));
  check('ignores edits outside the collision window', edit('stale.ts') === '');
  check('uses platform path casing for collision detection',
    edit('src/x.ts').includes('other also edited src/x.ts') === (process.platform === 'win32'));

  // fail-open
  r = fire({}, repo, 'not json {{{');
  check('garbage stdin fails open', r.status === 0 && r.stdout === '' && r.stderr === '');
  r = fire({}, repo, '');
  check('empty stdin fails open', r.status === 0 && r.stdout === '');

  // redaction: survivors
  const keep = [
    'git: cd /c/code/repo-wt/style-headcheck && git show origin/feat/style-headcheck:packages/web/lib/services/enrichment.ts',
    'cat C:\\code\\repo\\src\\services\\long-service.ts',
    'vitest packages/web/app/tools/(platform)/migration/runs/[runId]/x.tsx',
    'git diff origin/main...origin/feat/style-headcheck -- packages/web/app/tools/(platform)/migration/runs/page.tsx',
    'ls /c/Users/someone/AppData/Local/Temp/app-reports/some-long-report-name-0123456789',
    'git checkout feat-some-long-branch-name-with-many-words-v2',
  ];
  for (const k of keep) check(`keeps: ${k.slice(0, 50)}`, redact(k) === k, redact(k));

  // redaction: masked
  const secrets = [
    'echo ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'echo gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'echo ghu_abcdefghijklmnopqrstuvwxyz0123456789',
    'echo ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    'echo ghr_abcdefghijklmnopqrstuvwxyz0123456789',
    'echo github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789',
    'echo sk-abcdefghijklmnopqrstuvwx1234',
    'echo sk-ant-api03-abcdefghijklmnopqrstuvwx1234',
    'echo xoxb-1234567890-abcdefghij',
    'echo xoxp-1234567890-abcdefghij',
    'echo AKIAIOSFODNN7EXAMPLE',
    'curl -H "Bearer abc.def-ghi123"',
    'curl -H "Authorization: Basic dXNlcjpwYXNz"',
    'run password=hunter2x',
    'run TOKEN=abc123',
    'run --secret=abc123',
    'run apikey=abc123',
    'run api_key: abc123',
    'echo Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb',
  ];
  for (const s of secrets) {
    const out = redact(s);
    const leaked = /ghp_abc|gho_abc|ghu_abc|ghs_abc|ghr_abc|github_pat_11|sk-abc|sk-ant|xox[bp]-1234|AKIAIOSF|abc\.def|dXNlcjpwYXNz|hunter2|abc123|Zx9Qw8/.test(out);
    check(`masks: ${s.slice(0, 50)}`, out.includes('‹redacted›') && !leaked, out);
  }

  const credentials = [
    ['export SECRET_KEY=sample-secret', 'sample-secret'],
    ['AWS_SECRET_ACCESS_KEY=sample/aws+access/key aws s3 ls', 'sample/aws+access/key'],
    ['export PRIVATE_KEY="sample private key"', 'sample private key'],
    ['curl -H "X-API-Key: sample-header-key" https://example.test', 'sample-header-key'],
    ['curl -H "X-API-Key: sample\\\"quoted part" https://example.test', 'quoted part'],
    ['mysql -u root -psample-mysql-pass db', 'sample-mysql-pass'],
    ['mysql -u root -p"sample quoted pass" db', 'sample quoted pass'],
    ['curl -u guest:sample-curl-pass https://example.test', 'guest:sample-curl-pass'],
    ["curl --user='guest:sample curl pass' https://example.test", 'guest:sample curl pass'],
    ['psql postgres://guest:sample-db-pass@example.test/db', 'guest:sample-db-pass'],
  ];
  for (const [command, value] of credentials) {
    const out = redact(command);
    check(`masks credential in ${command.split(' ')[0]}`, out.includes('‹redacted›') && !out.includes(value));
  }
  const exactRedactions = [
    ['export "SECRET_KEY=sample first last" PUBLIC_LABEL=keep', 'export "SECRET_KEY=‹redacted›" PUBLIC_LABEL=keep'],
    ["export 'AWS_SECRET_ACCESS_KEY=sample key tail'", "export 'AWS_SECRET_ACCESS_KEY=‹redacted›'"],
    ['export "SECRET_KEY=  sample\nvalue  " && echo keep', 'export "SECRET_KEY=‹redacted›" && echo keep'],
    ['export "PRIVATE_KEY=sample first"\' and tail\'', 'export "PRIVATE_KEY=‹redacted›"'],
    ['export "SECRET"_KEY=sample\\ value', 'export "SECRET_KEY=‹redacted›"'],
    ['(curl -u guest:sample-pass https://example.test)', '(curl -u ‹redacted› https://example.test)'],
    ['( (mysql -p"sample quoted pass" db) )', '( (mysql -p‹redacted› db) )'],
    ['echo ok && (env CI=1 curl --user="guest:sample pass" https://example.test)', 'echo ok && (env CI=1 curl --user=‹redacted› https://example.test)'],
    ['{ curl -uguest:sample-pass https://example.test; }', '{ curl -u‹redacted› https://example.test; }'],
    ['(>client.log mysql -psample-pass)', '(>client.log mysql -p‹redacted›)'],
    ['(curl --stderr >(tee log) -u guest:sample-pass https://example.test)', '(curl --stderr >(tee log) -u ‹redacted› https://example.test)'],
    ['curl $(lookup-url) -u guest:sample-pass', 'curl $(lookup-url) -u ‹redacted›'],
  ];
  for (const [i, [command, expected]] of exactRedactions.entries()) {
    check(`redacts the complete shell credential (case ${i + 1})`, redact(command) === expected);
  }
  for (const command of ['git log -p', 'ssh -p22 example.test', 'mysql -u root -p db']) {
    check(`keeps: ${command}`, redact(command) === command);
  }

  // Exercise the lock through the actual hook. The commands are input strings only.
  env.ZM_REPO = repo;
  mkdirSync(path.join(chat, 'locks'), { recursive: true });
  writeFileSync(path.join(chat, 'locks', 'full-test-suite.md'), 'owner: alpha\nwhy: regression test\n');
  const fullRuns = [
    'pnpm vitest run',
    'yarn vitest run',
    'bun x vitest run',
    'pnpm playwright test',
    'pnpm turbo run build',
    'node_modules/.bin/vitest run',
    '"node_modules/.bin/vitest" run',
    'node_modules\\.bin\\vitest.cmd run',
    'npx --yes vitest run',
    'npx --package vitest vitest run',
    'sudo npm test',
    'sudo -u runner env CI=1 npm test',
    'time npm test',
    'cross-env CI=1 vitest run',
    'cd web & npm test',
    'vitest run --project web',
    'npx vitest run --reporter verbose',
    'playwright test --project chromium',
    'playwright test --project chromium firefox',
    'playwright test --workers 4',
    'vitest run -c config/vitest.ts',
    'npm test -- --reporter verbose',
    'jest --env node',
    'jest --testEnvironmentOptions \'{"customExportConditions":["node"]}\'',
    'jest --projects web worker --max-workers 4',
    'vitest run --coverage.enabled --coverage.provider v8',
    'vitest run --coverage.include src/** --coverage.thresholds.lines 90',
    'npm test >test.log',
    'npm test 2>&1',
    'npm test # whole suite',
    '>test.log npm test',
    'npm test < input.txt 2>> "folder with spaces/test.log" &>>combined.log',
    'npm test 3<&- >|test.log # with output redirections',
    'npm test >test.log && echo done # comment & npm test targeted',
    '(npm test 2>test.log)',
    'npm test <<EOF\nspec.ts\nEOF',
    'echo <<<text\nnpm test',
    'npm test > >(tee test.log)',
    'npm test \\\n  > test.log # whole suite',
  ];
  for (const command of fullRuns) {
    r = fire({ tool_input: { command } });
    check(`blocks: ${command}`, r.status === 2 && r.stderr.includes('full-test-suite is held by alpha'), r.stderr);
  }
  const allowedRuns = [
    'pnpm vitest run --project web src/example.test.ts',
    'npx --yes vitest run -t "example | other"',
    'vitest run --reporter=verbose -- src/example.test.ts',
    'playwright test --workers 4 "folder with spaces/spec.ts"',
    'playwright test --grep example',
    'pnpm turbo run build --filter web',
    'pnpm --filter web test',
    'npm run test -- src/example.test.ts',
    'echo "example & npm test"',
    'jest --env node src/example.test.ts >test.log',
    'vitest run --coverage.enabled --coverage.provider=v8 src/example.test.ts',
    'vitest run --coverage.enabled src/example.test.ts',
    'vitest run --coverage.provider v8 example',
    'npm test -- "spec#1.test.ts" 2>&1 # targeted',
    'npm test -- "folder > target/spec.ts"',
    'npm test -- spec#1.test.ts',
    'npm test -- \\#spec.test.ts',
    'echo ok # npm test & npm test',
    'cat <<EOF\nnpm test\nEOF',
    'cat <<-\'EOF\'\n\tnpm test\n\tEOF',
    'npm test > >(tee test.log) -- src/example.test.ts',
  ];
  for (const command of allowedRuns) {
    r = fire({ tool_input: { command } });
    check(`allows: ${command}`, r.status === 0, r.stderr);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('all passed');
