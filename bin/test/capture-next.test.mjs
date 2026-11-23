// node bin/test/capture-next.test.mjs : exits 0 on pass, 1 on failure. Uses only a scratch dir under os.tmpdir().
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'capture.mjs');
const { redact } = await import(pathToFileURL(script).href);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.error(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`);
};

const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-test-'));
const chat = path.join(scratch, 'chat');
const repo = path.join(scratch, 'repo');
mkdirSync(path.join(chat, 'status'), { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(path.join(chat, 'status', 'fed.md'), '# fed\nWorktrees: C:/code/app-wt/style-x\n');
writeFileSync(path.join(chat, 'status', 'alpha.md'), '# alpha\n');
const git = spawnSync('git', ['init', '-q', repo]);
if (git.status !== 0) { console.error('git init failed'); process.exit(1); }

const env = {
  ...process.env,
  CHAT_DIR: chat,
  ZM_REPO_COMMON: path.join(repo, '.git'),
};
delete env.ZM_SLUG;

function fire(payload, cwd = repo, raw) {
  return spawnSync('node', [script], {
    input: raw ?? JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, ...payload,
    }),
    env,
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
