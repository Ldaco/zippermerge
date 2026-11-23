import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { redact } from '../capture.mjs';

const script = fileURLToPath(new URL('../capture.mjs', import.meta.url));
const dayStamp = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');

function fixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zm-capture-onyx-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'my-app');
  const status = path.join(chat, 'status');
  const activity = path.join(chat, 'activity');
  mkdirSync(status, { recursive: true });

  const env = { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_REPO_COMMON: path.join(repo, '.git'),
    ZM_HUMAN: 'human', TMPDIR: scratch, TEMP: scratch, TMP: scratch };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key === 'ZM_SLUG') delete env[key];
  }
  const init = spawnSync('git', ['init', '-q', repo], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || String(init.error));

  function fire(event, tool, toolInput, sid, slug, mode = '--rewake') {
    const result = spawnSync(process.execPath, [script, mode], {
      env: slug === undefined ? env : { ...env, ZM_SLUG: slug },
      input: JSON.stringify({ cwd: repo, session_id: sid, hook_event_name: event, tool_name: tool, tool_input: toolInput }),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  }

  return {
    repo, status, activity,
    bash: (command, sid, slug, mode) => fire('PreToolUse', 'Bash', { command }, sid, slug, mode),
    edit: (file, sid, slug) => fire('PostToolUse', 'Edit', { file_path: file }, sid, slug),
    identity(sid) {
      const file = path.join(chat, 'identity', `${sid}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).slug : null;
    },
    activityFiles() {
      return readdirSync(activity).flatMap((day) => readdirSync(path.join(activity, day))).sort();
    },
  };
}

test('#30 resolves the exact worktree among prefix matches and the shared parent', (t) => {
  const { repo, status, bash, activityFiles } = fixture(t);
  writeFileSync(path.join(status, 'alpha.md'), `Worktrees: ${repo}-b1\n`);
  writeFileSync(path.join(status, 'bravo.md'), `Worktrees: ${repo}\n`);
  writeFileSync(path.join(status, 'charlie.md'), `Worktrees/branches: ${repo}/child -> feature\nWork: ${repo}\n`);

  assert.equal(bash('git status', 'prefix-match').status, 0);
  assert.deepEqual(activityFiles(), ['bravo.jsonl']);
});

test('#31 learns from shell invocations and preserves an established identity', (t) => {
  const { status, bash, identity, activityFiles } = fixture(t);
  for (const slug of ['alpha', 'bravo', 'src']) writeFileSync(path.join(status, `${slug}.md`), `# ${slug}\n`);

  const nonInvocations = [
    "git commit -F - <<'EOF'\nbash /z/chat.sh new alpha\nEOF",
    'ls # then bash /z/chat.sh post bravo note hi',
    'echo run bash /z/chat.sh new alpha > x.txt',
    'grep -n chat.sh post src',
  ];
  for (const [i, command] of nonInvocations.entries()) {
    const sid = `example${i}`;
    assert.equal(bash(command, sid).status, 0, command);
    assert.equal(identity(sid), null, command);
  }
  assert.deepEqual(activityFiles(), nonInvocations.map((_, i) => `unknown-example${i}.jsonl`));

  assert.equal(bash('C=/z/chat.sh; bash "$C" new alpha', 'known').status, 0);
  assert.equal(identity('known'), 'alpha');
  assert.equal(bash('bash /z/chat.sh new bravo', 'known').status, 0);
  assert.equal(identity('known'), 'alpha');
  assert.equal(bash('bash /z/chat.sh lock --wait full-test-suite alpha why', 'waiter').status, 0);
  assert.equal(identity('waiter'), 'alpha');
});

function activityLog(activity, slug, date, records) {
  const dir = path.join(activity, dayStamp(date));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${slug}.jsonl`), records.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

test('#32 finds recent edits after more than 400 unrelated or out-of-order events', (t) => {
  const { activity, edit } = fixture(t);
  const recent = new Date(Date.now() - 60_000);
  const old = new Date(Date.now() - 31 * 60_000);
  activityLog(activity, 'alpha', recent, [
    { event: 'edit', file: 'hot.ts', ts: recent, worktree: 'recent-edit' },
    ...Array.from({ length: 450 }, () => ({ event: 'bash', ts: recent })),
    { event: 'edit', file: 'hot.ts', ts: old, worktree: 'old-edit' },
    { event: 'edit', file: 'cold.ts', ts: old },
  ]);

  const hot = edit('hot.ts', 'editing', 'bravo');
  assert.equal(hot.status, 2, hot.stderr);
  assert.match(hot.stderr, /alpha also edited hot\.ts.*recent-edit/);
  assert.equal(edit('cold.ts', 'editing', 'bravo').status, 0);
});

test('#32 compares edit paths using platform case sensitivity', (t) => {
  const { activity, edit } = fixture(t);
  const recent = new Date(Date.now() - 60_000);
  activityLog(activity, 'alpha', recent, [{ event: 'edit', file: 'Src/X.ts', ts: recent }]);

  const result = edit('src/x.ts', 'editing', 'bravo');
  assert.equal(result.status, process.platform === 'win32' ? 2 : 0, result.stderr);
});

test('#125 ignores an invalid environment slug and keeps the normal precedence', (t) => {
  const { repo, status, bash, edit, activityFiles } = fixture(t);
  const invalid = edit('file.ts', 'valid-1234', 'Invalid Slug');
  assert.equal(invalid.status, 0);
  assert.match(invalid.stderr, /ignoring invalid ZM_SLUG/);
  assert.ok(!invalid.stderr.includes('Invalid Slug'));
  const recorded = bash('git status', 'valid-1234', 'Invalid Slug', '--record-only');
  assert.equal(recorded.status, 0);
  assert.equal(recorded.stderr, '');
  assert.deepEqual(activityFiles(), ['unknown-valid-12.jsonl']);

  writeFileSync(path.join(status, 'inferred.md'), `Worktrees: ${repo}\n`);
  writeFileSync(path.join(status, 'learned.md'), '# learned\n');
  assert.equal(bash('bash /z/chat.sh new learned', 'identity').status, 0);
  assert.equal(edit('learned.ts', 'identity', 'Invalid Slug').status, 0);
  assert.equal(edit('inferred.ts', 'other', 'Invalid Slug').status, 0);
  const explicit = edit('explicit.ts', 'identity', 'explicit_slug-1');
  assert.equal(explicit.status, 0);
  assert.equal(explicit.stderr, '');
  assert.deepEqual(activityFiles(), ['explicit_slug-1.jsonl', 'inferred.jsonl', 'learned.jsonl', 'unknown-valid-12.jsonl']);
});

test('#125 uses the no-session fallback for malformed session IDs', (t) => {
  const { edit, activityFiles } = fixture(t);
  for (const [i, sid] of [undefined, 'bad.id!', 'a'.repeat(101), ['valid-id']].entries()) {
    assert.equal(edit(`file-${i}.ts`, sid).status, 0);
  }
  assert.deepEqual(activityFiles(), ['unknown-nosid.jsonl']);
});

test('#138 redacts long non-URL tokens promptly', () => {
  const command = 'vitest run ; echo ' + 'a'.repeat(64 * 1024);
  const start = performance.now();
  assert.ok(redact(command) === command, 'plain letters should survive redaction');
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `64 KiB of plain letters took ${Math.round(elapsed)} ms`);
});

test('#138 preserves supported URL credential redaction', () => {
  const command = 'echo "prefix=9.git+SSH://user:sample@host/path" https://alex@site.test/ ftp://site.test/file';
  assert.equal(redact(command), 'echo "prefix=9.git+SSH://‹redacted›@host/path" https://‹redacted›@site.test/ ftp://site.test/file');
});
