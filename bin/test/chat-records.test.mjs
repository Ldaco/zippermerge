import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../chat.sh', import.meta.url)).replaceAll('\\', '/');

function scratchBoard(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-chat-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'repo');
  const env = {
    ...process.env,
    CHAT_DIR: chat.replaceAll('\\', '/'),
    ZM_REPO: repo.replaceAll('\\', '/'),
    ZM_MIG_DIR: 'migs/',
    ZM_HUMAN: 'human',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  mkdirSync(repo);
  mkdirSync(path.join(chat, 'log'), { recursive: true });
  git('init', '-q', '-b', 'main');
  function run(...args) {
    // Pass arguments through stdin so Git Bash preserves CR and LF on Windows.
    const command = 'args=(); while IFS= read -r -d "" arg; do args+=("$arg"); done; source "$0" "${args[@]}"';
    const result = spawnSync('bash', ['-c', command, script], {
      cwd: repo, env, encoding: 'utf8', input: args.join('\0') + '\0',
    });
    assert.ifError(result.error);
    return result;
  }
  function ok(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function addMigration() {
    const migration = 'migs/001_existing.sql';
    mkdirSync(path.join(repo, 'migs'));
    writeFileSync(path.join(repo, migration), 'select 1;\n');
    git('add', migration);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial migration');
    git('remote', 'add', 'origin', '.');
  }
  return { chat, run, ok, addMigration };
}

test('both claim commands reject migration names outside snake_case', (t) => {
  const { chat, run } = scratchBoard(t);
  for (const command of [['migration', 'writer'], ['claim-number', 'writer', '42']]) {
    for (const name of ['two words', 'two\nlines', 'two/parts', '42_items', 'Uppercase', '']) {
      const result = run(...command, name, 'ref');
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /snake_case/);
    }
  }
  assert.deepEqual(readdirSync(path.join(chat, 'claims')), []);
});

test('claims have single-line refs and the migration hint has one path separator', (t) => {
  const { chat, ok, addMigration } = scratchBoard(t);
  addMigration();
  const ref = 'topic\r\nbranch\nreview';
  assert.match(ok('migration', 'writer', 'add_items2', ref), /create migs\/002_add_items2\.sql/);
  assert.match(ok('claim-number', 'writer', '3', 'add_orders', ref), /CLAIMED 003/);
  for (const file of ['migration-002.md', 'migration-003.md']) {
    const record = readFileSync(path.join(chat, 'claims', file), 'utf8');
    assert.match(record, /^ref: topic branch review$/m);
    assert.equal(record.trimEnd().split('\n').length, 6);
  }
});

test('reservations reject multi-line patterns and keep reasons on one line', (t) => {
  const { chat, run, ok } = scratchBoard(t);
  for (const pattern of ['src/**\nmore', 'src/**\rmore']) {
    const result = run('reserve', 'writer', pattern, 'editing');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /single line/);
  }
  assert.deepEqual(readdirSync(path.join(chat, 'reservations')), ['released']);
  const result = ok('reserve', 'writer', 'src dir/**', 'editing\r\nfiles', '--ttl', '720');
  const id = result.trim().split(' ')[1];
  const record = readFileSync(path.join(chat, 'reservations', id + '.md'), 'utf8');
  assert.match(record, /^pattern: src dir\/\*\*$/m);
  assert.match(record, /^why: editing files$/m);
  assert.equal(record.trimEnd().split('\n').length, 8);
  assert.match(ok('reservations'), /left=480 min why=editing files/);
});

test('a lock reason stays on one line and the fresh lock remains held', (t) => {
  const { chat, run, ok } = scratchBoard(t);
  ok('lock', 'full-test-suite', 'writer', 'running\r\ntests\nlocally');
  const record = readFileSync(path.join(chat, 'locks', 'full-test-suite.md'), 'utf8');
  assert.match(record, /^why: running tests locally$/m);
  assert.equal(record.trimEnd().split('\n').length, 5);
  const result = run('break', 'full-test-suite', 'reader');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /only \d+ min old/);
});

test('new shows later same-second posts and collision suffixes just once', (t) => {
  const { chat, ok } = scratchBoard(t);
  const stamp = '20261122T210000Z';
  const add = (suffix, body) => writeFileSync(path.join(chat, 'log', stamp + suffix), body + '\n');
  add('_zeta_note.md', 'first post');
  assert.match(ok('new', 'reader'), /first post/);
  add('_alpha_ask.md', 'lower slug');
  let output = ok('new', 'reader');
  assert.match(output, /lower slug/);
  assert.doesNotMatch(output, /first post/);
  add('_zeta_note-1.md', 'collision suffix');
  output = ok('new', 'reader');
  assert.match(output, /collision suffix/);
  assert.doesNotMatch(output, /first post|lower slug/);
  assert.match(ok('new', 'reader'), /NOTHING NEW/);
});

test('new accepts a legacy filename-only marker', (t) => {
  const { chat, ok } = scratchBoard(t);
  mkdirSync(path.join(chat, '.lastread'));
  const prior = '20261122T210000Z_zeta_note.md';
  writeFileSync(path.join(chat, '.lastread', 'reader'), prior + '\n');
  writeFileSync(path.join(chat, 'log', prior), 'already read\n');
  writeFileSync(path.join(chat, 'log', '20261122T210000Z_alpha_ask.md'), 'same second\n');
  writeFileSync(path.join(chat, 'log', '20261122T205959Z_zeta_note.md'), 'older second\n');
  const output = ok('new', 'reader');
  assert.match(output, /same second/);
  assert.doesNotMatch(output, /already read|older second/);
  assert.match(ok('new', 'reader'), /NOTHING NEW/);
});

test('new prints a long post in full before marking it read', (t) => {
  const { ok } = scratchBoard(t);
  const body = Array.from({ length: 40 }, (_, i) => 'line ' + (i + 1)).join('\n');
  ok('post', 'writer', 'ask', body + '\n@reader last line');
  assert.match(ok('new', 'reader'), /line 40\r?\n@reader last line/);
  assert.match(ok('new', 'reader'), /NOTHING NEW/);
});
