import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');

test('new ignores stray log files and repairs a marker that already contains one', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'zm-reef-marker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chat = path.join(root, 'board');
  const repo = path.join(root, 'repo');
  const log = path.join(chat, 'log');
  mkdirSync(log, { recursive: true });
  mkdirSync(repo);
  const env = { ...process.env, CHAT_DIR: chat.replaceAll('\\', '/'), ZM_REPO: repo.replaceAll('\\', '/') };
  const options = { cwd: repo, env, encoding: 'utf8', timeout: 10000 };
  const init = spawnSync('git', ['init', '-q'], options);
  assert.equal(init.status, 0, init.error?.message || init.stderr);
  const write = (name, body) => writeFileSync(path.join(log, name), body + '\n');
  const read = () => {
    const result = spawnSync('bash', [script, 'new', 'reef-reader'], options);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.doesNotMatch(result.stdout, /README|stray documentation|malformed log/);
    return result.stdout;
  };

  const first = '20261122T210000Z_writer_note.md';
  const second = '20261122T210001Z_writer_note-1.md';
  write('README.md', 'stray documentation');
  write('20261122T999999Z_writer_note.md', 'malformed log');
  write(first, 'first valid entry');
  assert.match(read(), /first valid entry/);
  const marker = path.join(chat, '.lastread', 'reef-reader');
  assert.equal(readFileSync(marker, 'utf8').trim(), first);

  // Simulate the marker left by versions that accepted any .md filename.
  writeFileSync(marker, 'README.md\n');
  write(second, 'later valid entry');
  assert.match(read(), /later valid entry/);
  assert.equal(readFileSync(marker, 'utf8').trim(), second);
  assert.match(read(), /NOTHING NEW/);
});
