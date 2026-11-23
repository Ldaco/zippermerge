import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const shellPath = (p) => p.replaceAll('\\', '/');
const script = shellPath(fileURLToPath(new URL('../../chat.sh', import.meta.url)));

function fixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-umber-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'repo');
  const env = {
    ...process.env,
    CHAT_DIR: shellPath(chat),
    ZM_REPO: shellPath(repo),
    ZM_REPO_COMMON: path.join(repo, '.git'),
    ZM_MIG_DIR: 'migs',
    ZM_HUMAN: 'human',
  };
  for (const key of [
    'BASH_ENV', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'ZM_SLUG',
  ]) delete env[key];
  mkdirSync(repo);
  mkdirSync(path.join(chat, 'log'), { recursive: true });

  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }

  function initRepo() {
    git('init', '-q', '-b', 'main');
    mkdirSync(path.join(scratch, 'hooks'));
    git('config', 'core.hooksPath', path.join(scratch, 'hooks'));
    mkdirSync(path.join(repo, 'migs'));
    writeFileSync(path.join(repo, 'migs', '001_existing.sql'), 'select 1;\n');
    git('add', 'migs/001_existing.sql');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
      'commit', '-qm', 'Initial migration');
    git('remote', 'add', 'origin', '.');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  function run(...args) {
    // NUL-delimited stdin preserves multiline and glob arguments in Git Bash.
    const command = 'args=(); while IFS= read -r -d "" arg; do args+=("$arg"); done; source "$0" "${args[@]}"';
    const result = spawnSync('bash', ['-c', command, script], {
      cwd: repo, env, encoding: 'utf8', input: args.join('\0') + '\0', timeout: 15000,
    });
    assert.ifError(result.error);
    return result;
  }

  function ok(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  return { chat, repo, scratch, env, git, initRepo, run, ok };
}

test('reserve warns when a middle wildcard covers a literal path in either order', async (t) => {
  for (const [first, second] of [['src/*.ts', 'src/app.ts'], ['src/app.ts', 'src/*.ts']]) {
    await t.test(first, (t) => {
      const { run, ok } = fixture(t);
      ok('reserve', 'alpha', first, 'first reservation');
      const overlap = run('reserve', 'beta', second, 'second reservation');
      assert.equal(overlap.status, 0, overlap.stderr);
      assert.match(overlap.stderr, /WARNING: overlaps .*owner=alpha/);
      const different = run('reserve', 'gamma', 'src/app.js', 'unrelated path');
      assert.equal(different.status, 0, different.stderr);
      assert.equal(different.stderr, '');
    });
  }
});

test('claims and locks distinguish a create failure from an occupied record', async (t) => {
  const { chat, initRepo, run, ok } = fixture(t);
  initRepo();
  ok('help');
  const claim = path.join(chat, 'claims', 'migration-002.md');
  const lock = path.join(chat, 'locks', 'main-freeze.md');
  // A directory at the record path forces a create failure on POSIX and NTFS.
  mkdirSync(claim);
  mkdirSync(lock);
  const cases = [
    [['claim-number', 'alpha', '2', 'add_items', 'topic'], /migration-002\.md/],
    [['lock', 'main-freeze', 'alpha', 'test'], /main-freeze\.md/],
  ];
  for (const [args, target] of cases) {
    await t.test(args[0], () => {
      const result = run(...args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, target);
      assert.match(result.stderr, /Is a directory|Permission denied/i);
    });
  }
  assert.deepEqual(readdirSync(path.join(chat, 'claims')), ['migration-002.md']);
  rmSync(claim, { recursive: true });
  rmSync(lock, { recursive: true });
  ok('claim-number', 'alpha', '2', 'add_items', 'topic');
  const taken = run('claim-number', 'beta', '2', 'add_items', 'topic');
  assert.equal(taken.status, 2, taken.stderr);
  assert.match(taken.stdout, /^TAKEN 002:\r?\n.*\r?\nowner: alpha/m);
  assert.equal(taken.stderr, '');
  ok('lock', 'main-freeze', 'alpha', 'test');
  const held = run('lock', 'main-freeze', 'beta', 'test');
  assert.equal(held.status, 2, held.stderr);
  assert.match(held.stdout, /^HELD by another session:\r?\n.*\r?\nowner: alpha/m);
  assert.equal(held.stderr, '');
});

test('migration reports a failed write without retrying or leaving an incomplete claim', (t) => {
  const { chat, scratch, env, initRepo, run } = fixture(t);
  initRepo();
  env.BASH_ENV = shellPath(path.join(scratch, 'write-error.sh'));
  writeFileSync(env.BASH_ENV, [
    'printf() {',
    '  if [[ ${2:-} == "number: "* ]]; then',
    "    builtin printf '%s\\n' 'No space left on device' >&2",
    '    return 1',
    '  fi',
    '  builtin printf "$@"',
    '}',
    '',
  ].join('\n'));
  const result = run('migration', 'alpha', 'add_items', 'topic');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /migration-002\.md.*No space left on device/);
  assert.deepEqual(readdirSync(path.join(chat, 'claims')), []);
});

test('archive uses a three-day UTC cutoff without GNU date', (t) => {
  const { chat, scratch, env, ok } = fixture(t);
  env.BASH_ENV = shellPath(path.join(scratch, 'bsd-date.sh'));
  writeFileSync(env.BASH_ENV, [
    'date() {',
    '  case "$*" in',
    "    '-u -d 3 days ago +%Y%m%dT%H%M%SZ') echo 'date: illegal option -- d' >&2; return 1 ;;",
    "    '-u -v-3d +%Y%m%dT%H%M%SZ') printf '%s\\n' 20261120T180000Z ;;",
    '    *) command date "$@" ;;',
    '  esac',
    '}',
    '',
  ].join('\n'));
  const old = '20261120T175959Z_alpha_hello.md';
  const recent = '20261120T180000Z_alpha_note.md';
  for (const file of [old, recent]) writeFileSync(path.join(chat, 'log', file), 'entry\n');
  assert.match(ok('archive'), /ARCHIVED 1 entries older than 20261120T180000Z/);
  assert.deepEqual(readdirSync(path.join(chat, 'log', 'archive')), [old]);
  assert.deepEqual(readdirSync(path.join(chat, 'log')).sort(), [recent, 'archive']);
});

test('new displays a quoted post inside the real entry', (t) => {
  const { chat, ok } = fixture(t);
  const original = '20000101T000000Z_human_note.md';
  writeFileSync(path.join(chat, 'log', original),
    'from: human\r\nkind: note\r\nvia: dashboard\r\n\r\nAn earlier request.\r\n');
  ok('new', 'beta');
  const quoted = ok('new', 'alpha').split('\n').slice(1, -2).join('\n').trimEnd();
  const posted = ok('post', 'alpha', 'note', 'Quoting the earlier request:\n' + quoted);
  const record = path.join(chat, posted.trim().replace(/^POSTED /, ''));
  const output = ok('new', 'beta');
  assert.equal(output.match(/^=== log\//gm)?.length, 1, output);
  assert.match(output, /^from: alpha\r?$/m);
  assert.doesNotMatch(output, /^(?:from: human|via: dashboard)/m);
  assert.match(output, /^ +=== log\/20000101T000000Z_human_note\.md$/m);
  assert.match(output, /^ +from: human\r?$/m);
  assert.match(output, /An earlier request\./);
  assert.match(readFileSync(record, 'utf8'), /^=== log\/20000101T000000Z_human_note\.md$/m);
  assert.match(ok('new', 'beta'), /NOTHING NEW/);
});

test('the guard warns about another owner when it cannot identify the session', (t) => {
  const { chat, repo, git, initRepo, run, ok } = fixture(t);
  initRepo();
  ok('claim-number', 'alpha', '2', 'add_items', 'topic');
  ok('reserve', 'alpha', 'src/*.ts', 'test', '--exclusive');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(path.join(repo, 'migs', '002_add_items.sql'), 'select 2;\n');
  git('add', 'src/app.ts', 'migs/002_add_items.sql');
  for (const [args, status, level] of [[[], 0, 'WARN'], [['--slug', 'beta'], 2, 'BLOCK']]) {
    const result = run('guard', ...args);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^zippermerge guard: ${level} migration 002 (?:is )?claimed by alpha`, 'm'));
    assert.match(result.stdout, new RegExp(`^zippermerge guard: ${level} src/app\\.ts is exclusively reserved by alpha`, 'm'));
  }
  assert.deepEqual(readdirSync(path.join(chat, 'claims')), ['migration-002.md']);
});

test('README and CLAUDE document the guard identity and trial-merge limits', async (t) => {
  const server = readFileSync(new URL('../../dashboard/server.mjs', import.meta.url), 'utf8');
  const cap = /const CONFLICT_MAX_PAIRS = (\d+)/.exec(server)?.[1];
  assert.ok(cap, 'dashboard conflict scan limit');
  for (const file of ['README.md', 'CLAUDE.md']) {
    await t.test(file, () => {
      const doc = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
      const guard = doc.split(/\r?\n/).find((line) => /^- \*\*Commit guard/.test(line));
      const conflicts = doc.split(/\r?\n/).find((line) => /^- \*\*(?:Conflicts before merge|Real conflict detection)/.test(line));
      assert.match(guard, /warns? .*cannot identify (?:the|a) session/i);
      assert.match(conflicts, /different sessions/i);
      assert.match(conflicts, new RegExp(`\\b${cap} trial merges? (?:in total|per scan)\\b`, 'i'));
      assert.match(conflicts, /origin\/main/);
    });
  }
});
