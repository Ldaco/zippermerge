import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/timeline.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];

class Element {
  nodeType = 1;
  children = [];
  textContent = '';

  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); }
}

function loadTimeline() {
  const elements = new Map();
  const document = {
    createElement: () => new Element(),
    createElementNS: () => new Element(),
    createTextNode: (textContent) => ({ nodeType: 3, textContent }),
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const context = createContext({
    document,
    fetch: () => new Promise(() => {}),
    setInterval() {},
    window: { addEventListener() {} },
  });
  runInContext(script, context);
  return context;
}

test('Timeline uses the UTC clock and day for landed PRs', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const context = loadTimeline();
    const mergedAt = '2026-11-22T19:05:00Z';
    const midnightMerge = '2026-11-22T00:05:00Z';
    assert.equal(new Date(mergedAt).getHours(), 14);
    assert.equal(new Date(midnightMerge).getDate(), 21);
    context.data = { mergeQueue: { merged: [{ number: 1, mergedAt }, { number: 2, mergedAt: midnightMerge }] } };
    context.renderDetail();
    const [panel] = context.document.getElementById('mq').children;
    const [heading, row, midnightRow] = panel.children[2].children;
    assert.equal(row.children[0].children[0].textContent, '19:05Z');
    assert.equal(midnightRow.children[0].children[0].textContent, '00:05Z');
    assert.equal(heading.children[0].textContent, 'Landed today (UTC) · 2');
    const landedSummary = context.document.getElementById('vitals').children
      .map((vital) => vital.children.map((part) => part.children[0].textContent))
      .find(([, label]) => label.startsWith('landed today'));
    assert.deepEqual(landedSummary, ['2', 'landed today (UTC)']);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test('Timeline board API', async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'zippermerge-timeline-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = path.join(scratch, 'chat');
  const repo = path.join(scratch, 'repo');
  mkdirSync(path.join(chat, 'status'), { recursive: true });
  mkdirSync(path.join(chat, 'log'));
  execFileSync('git', ['init', '-q', repo], { cwd: scratch });

  const now = Date.parse('2026-11-22T16:10:00Z');
  const status = [
    ['alpha', '2026-11-22T15:20:00Z', 'merge #1 ~15:30Z'],
    ['beta', '2026-11-21T23:50:00Z', 'merge #2 ~00:10Z'],
    ['gamma', '2026-11-22T16:00:00Z', 'merge #3 ~16:40Z'],
    ['delta', '2026-11-22T16:00:00Z', 'run the full suite'],
  ];
  for (const [slug, updated, action] of status) {
    writeFileSync(path.join(chat, 'status', `${slug}.md`), `# ${slug} updated: ${updated} state: active\nNext risky action: ${action}\n`);
  }
  const logDir = path.join(chat, 'log');
  for (let i = 0; i < 100; i++) {
    const at = new Date(now - (178 - i) * 60000).toISOString();
    const stamp = at.replace(/[-:]|\.\d{3}/g, '');
    const [slug, kind, body] = i === 0 ? ['alpha', 'ask', '@beta Can you review?']
      : i === 1 ? ['beta', 'status', 'Reviewed'] : ['alpha', 'note', `Post ${i}`];
    writeFileSync(path.join(logDir, `${stamp}_${slug}_${kind}.md`), `from: ${slug}\nkind: ${kind}\nat: ${at}\n\n${body}\n`);
  }
  writeFileSync(path.join(logDir, '20261121T160000Z_alpha_note.md'), 'from: alpha\nkind: note\n\nOlder post\n');
  writeFileSync(path.join(logDir, '000-legacy.md'), 'from: alpha\nkind: note\nat: 2026-11-22T13:10:30Z\n\nLegacy post\n');

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  listener.close();
  await once(listener, 'close');

  const server = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
  const clock = `data:text/javascript,${encodeURIComponent(`Date.now = () => ${now}`)}`;
  const child = spawn(process.execPath, ['--import', clock, server, '--port', String(port)], {
    cwd: scratch,
    env: {
      ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '',
      BOARD_CACHE_FILE: path.join(scratch, 'board-cache.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = once(child, 'close');
  try {
    const [output] = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code]) => assert.fail(`dashboard exited before listening (${code})`)),
    ]);
    assert.match(String(output), /zippermerge dashboard:/);
    const response = await fetch(`http://127.0.0.1:${port}/api/board`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const board = await response.json();
    const context = loadTimeline();
    context.offset = now - Date.now();
    context.data = board;
    context.renderDetail();
    const vitals = Object.fromEntries(context.document.getElementById('vitals').children.map((vital) => {
      const [value, label] = vital.children.map((part) => part.children[0].textContent);
      return [label, value];
    }));

    await t.test('keeps risky actions overdue past 30 minutes and across midnight', () => {
      const bySlug = Object.fromEntries(board.timeline.map((entry) => [entry.slug, entry]));
      assert.equal(bySlug.alpha.atUtc, '2026-11-22T15:30:00.000Z');
      assert.equal(bySlug.alpha.inMin, -40);
      assert.equal(bySlug.alpha.overdue, true);
      assert.equal(bySlug.beta.atUtc, '2026-11-22T00:10:00.000Z');
      assert.equal(bySlug.beta.overdue, true);
      assert.equal(bySlug.gamma.inMin, 30);
      assert.equal(bySlug.gamma.overdue, false);
      assert.equal(bySlug.delta.atUtc, null);
      assert.equal(vitals['overdue risky actions'], '2');
    });
    await t.test('returns every visible post and counts older posts without loading them', () => {
      assert.equal(board.log.length, 101);
      assert.equal(board.log[0].body, 'Post 99');
      assert.equal(board.log.at(-1).body, 'Legacy post');
      assert.equal(board.logTotal, 102);
      assert.equal(vitals['posts on board'], '102');
      const [ask] = context.buildAsks(board);
      assert.equal(ask.body, '@beta Can you review?');
      assert.equal(ask.answered, true);
    });
  } finally {
    child.kill();
    await closed;
  }
});
