import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');

function fixture(t, shim) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-portability-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const startup = path.join(scratch, 'bash-env.sh');
  writeFileSync(startup, shim);
  const env = {
    ...process.env,
    BASH_ENV: startup.replaceAll('\\', '/'),
    CHAT_DIR: chat.replaceAll('\\', '/'),
    ZM_REPO: scratch.replaceAll('\\', '/'),
    ZM_HUMAN: 'human',
    TZ: 'EST5',
  };
  function run(...args) {
    const result = spawnSync('bash', [script, ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  }
  return { chat, run };
}

test('a translated noclobber diagnostic still retries an occupied log name', (t) => {
  const { chat, run } = fixture(t, `
date() {
  case "$2" in
    +%Y%m%dT%H%M%SZ) echo 20261123T230000Z ;;
    +%Y-%m-%dT%H:%M:%SZ) echo 2026-11-23T23:00:00Z ;;
    *) command date "$@" ;;
  esac
}
# Keep the real noclobber failure and replace only its captured diagnostic.
set -T
translate_diagnostic() {
  if [[ ${'$'}{FUNCNAME[1]:-} == excl_write && ${'$'}{error:-} == *': cannot overwrite existing file' ]]; then
    error="fichier deja existant"
    echo translated >> "$CHAT_DIR/translated"
  fi
}
trap translate_diagnostic DEBUG
`);
  const first = run('post', 'writer', 'note', 'original');
  assert.equal(first.status, 0, first.stderr);
  const second = run('post', 'writer', 'note', 'next post');
  assert.equal(readFileSync(path.join(chat, 'translated'), 'utf8').trim(), 'translated');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^POSTED log\/20261123T230000Z_writer_note-1\.md/m);
  assert.equal(second.stderr, '');
  assert.match(readFileSync(path.join(chat, 'log', '20261123T230000Z_writer_note.md'), 'utf8'), /original/);
});

test('archive selects BSD date without invoking -d, and falls back to GNU date', async (t) => {
  for (const flavor of ['bsd', 'gnu']) {
    await t.test(flavor, (t) => {
      const { chat, run } = fixture(t, `
date() {
  echo "$2" >> "$CHAT_DIR/date-calls"
  case "${flavor}:$*" in
    'bsd:-u -v-3d +%Y%m%dT%H%M%SZ'|'gnu:-u -d 3 days ago +%Y%m%dT%H%M%SZ')
      echo 20261120T230000Z ;;
    *) echo 'unsupported date invocation' >&2; return 1 ;;
  esac
}
`);
      const log = path.join(chat, 'log');
      mkdirSync(log, { recursive: true });
      const old = '20261120T225959Z_writer_note.md';
      const cutoff = '20261120T230000Z_writer_note.md';
      writeFileSync(path.join(log, old), 'old\n');
      writeFileSync(path.join(log, cutoff), 'at cutoff\n');
      const result = run('archive');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(path.join(chat, 'date-calls'), 'utf8').trim().split(/\r?\n/),
        flavor === 'bsd' ? ['-v-3d'] : ['-v-3d', '-d']);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /ARCHIVED 1 entries older than 20261120T230000Z/);
      assert.equal(readFileSync(path.join(log, 'archive', old), 'utf8'), 'old\n');
      assert.equal(readFileSync(path.join(log, cutoff), 'utf8'), 'at cutoff\n');
    });
  }
});

test('board shows a UTC file time when BSD date -r accepts only seconds', (t) => {
  const { chat, run } = fixture(t, `
date() {
  if [[ $2 == -r && ! $3 =~ ^[0-9]+$ ]]; then
    echo 'date: invalid number of seconds' >&2
    return 1
  fi
  command date "$@"
}
stat() {
  [[ $TZ == UTC0 && "$1 $2 $3 $4 $5" == '-L -f %Sm -t %Y-%m-%dT%H:%M:%SZ' && -f $6 ]] || return 1
  echo 2026-11-20T23:00:00Z
}
`);
  mkdirSync(path.join(chat, 'status'), { recursive: true });
  writeFileSync(path.join(chat, 'status', 'writer.md'), 'Current work\n');
  const result = run('board');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^=== status\/writer\.md  \(modified 2026-11-20T23:00:00Z\)\r?\nCurrent work/m);
  assert.equal(result.stderr, '');
});
