import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');
const utc = '2026-11-23T23:00:00Z';

function boardWithStat(t, output, exitCode) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-mtime-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const bin = path.join(scratch, 'fake-bin');
  mkdirSync(bin);
  mkdirSync(path.join(chat, 'status'), { recursive: true });
  writeFileSync(path.join(chat, 'status', 'writer.md'), 'Current work\n');
  writeFileSync(path.join(bin, 'date'), '#!/usr/bin/env bash\n[[ $2 == -r ]] && exit 1\nexec "$REAL_DATE" "$@"\n',
    { mode: 0o755 });
  writeFileSync(path.join(bin, 'stat'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$FAKE_STAT_OUTPUT"',
    'exit "$FAKE_STAT_EXIT"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = {
    ...process.env,
    CHAT_DIR: chat.replaceAll('\\', '/'),
    ZM_REPO: scratch.replaceAll('\\', '/'),
    FAKE_STAT_OUTPUT: output,
    FAKE_STAT_EXIT: String(exitCode),
  };
  delete env.BASH_ENV;
  const command = 'export REAL_DATE="$(command -v date)" PATH="$PWD/fake-bin:$PATH"; exec bash "$1" board';
  const result = spawnSync('bash', ['-c', command, 'mtime-test', script], {
    cwd: scratch, env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  return result.stdout.replaceAll('\r\n', '\n').split('\n').slice(0, 2);
}

test('board discards GNU stat filesystem output after a failed date probe', (t) => {
  assert.deepEqual(boardWithStat(t, '  File: "status/writer.md"\n    ID: 1234 Namelen: 255', 1),
    ['=== status/writer.md  (modified unknown)', 'Current work']);
});

test('board rejects invalid stat text even when stat reports success', (t) => {
  assert.deepEqual(boardWithStat(t, '1a2b3c 255 4096', 0),
    ['=== status/writer.md  (modified unknown)', 'Current work']);
});

test('board preserves a successful BSD stat timestamp', (t) => {
  assert.deepEqual(boardWithStat(t, utc, 0),
    [`=== status/writer.md  (modified ${utc})`, 'Current work']);
});
