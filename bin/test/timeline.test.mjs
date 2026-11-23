import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

function loadTimeline(fetch = () => new Promise(() => {}), abortSignal = AbortSignal) {
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
    fetch,
    AbortSignal: abortSignal,
    setInterval() {},
    window: { addEventListener() {}, scrollTo() {} },
  });
  runInContext(script, context);
  return context;
}

function readVitals(context) {
  return Object.fromEntries(context.document.getElementById('vitals').children.map((vital) => {
    const [value, label] = vital.children.map((part) => part.children[0].textContent);
    return [label, value];
  }));
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
    ['early', '2026-11-22T08:00:00Z', 'release v2 ~21:00Z'],
    ['dated', '2026-11-22T08:00:00Z', 'release v3 2026-11-22T22:00Z'],
    ['tomorrow', '2026-11-22T08:00:00Z', 'release v4 2026-11-23 08:00Z'],
    ['seconds', '2026-11-22T08:00:00Z', 'release 2026-11-22T22:00:00Z'],
    ['fraction', '2026-11-22T08:00:00Z', 'release 2026-11-22T22:00:00.125Z'],
    ['invalid-date', '2026-11-22T08:00:00Z', 'release 2026-02-30T22:00:00Z'],
  ];
  for (const [slug, updated, action] of status) {
    const file = path.join(chat, 'status', `${slug}.md`);
    writeFileSync(file, `# ${slug} updated: ${updated} state: active\nNext risky action: ${action}\n`);
    const mtime = new Date('2026-11-21T23:50:00Z');
    utimesSync(file, mtime, mtime);
  }
  const logDir = path.join(chat, 'log');
  const longBody = 'Long board post '.repeat(237);
  for (let i = 0; i < 350; i++) {
    const at = new Date(now - 178 * 60000 + i * 20000).toISOString();
    const stamp = at.replace(/[-:]|\.\d{3}/g, '');
    const [kind, body] = i === 0 ? ['ask', '@beta Can you review?']
      : i === 1 ? ['ask', '@delta Please check'] : ['note', longBody];
    writeFileSync(path.join(logDir, `${stamp}_alpha_${kind}.md`), `from: alpha\nkind: ${kind}\nat: ${at}\n\n${body}\n`);
  }
  const humanReply = '20261122T131221Z_test-human_reply.md';
  writeFileSync(path.join(logDir, humanReply), 'from: test-human\nkind: reply\nre: 20261122T131220Z_alpha_ask.md\n\nChecked\n');
  writeFileSync(path.join(logDir, '20261121T160000Z_alpha_note.md'), 'from: alpha\nkind: note\n\nOlder post\n');
  writeFileSync(path.join(logDir, '000-legacy.md'), 'from: alpha\nkind: note\nat: 2026-11-22T16:09:59Z\n\nLegacy post\n');
  writeFileSync(path.join(logDir, '000-old-legacy.md'), 'from: alpha\nkind: note\nat: 2026-11-20T16:00:00Z\n\nOld legacy post\n');

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  listener.close();
  await once(listener, 'close');

  const server = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
  const shift = path.join(scratch, 'shift.txt');
  const reads = path.join(scratch, 'legacy-reads.txt');
  writeFileSync(shift, '0');
  writeFileSync(reads, '');
  const setup = `
    import fs from 'node:fs/promises';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Date.now = () => ${now} + Number(readFileSync(${JSON.stringify(shift)}, 'utf8'));
    const readFile = fs.readFile;
    fs.readFile = (file, ...options) => {
      if (String(file).endsWith('000-old-legacy.md')) appendFileSync(${JSON.stringify(reads)}, 'r');
      return readFile(file, ...options);
    };
    syncBuiltinESMExports();
  `;
  const clock = `data:text/javascript,${encodeURIComponent(setup)}`;
  const child = spawn(process.execPath, ['--import', clock, server, '--port', String(port)], {
    cwd: scratch,
    env: {
      ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '', ZM_HUMAN: 'test-human',
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
    const request = (url) => fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(5000) });
    const response = await request('/api/board');
    assert.equal(response.status, 200);
    const board = await response.json();
    const historyResponse = await request('/api/timeline');
    const history = historyResponse.ok ? await historyResponse.json() : board;
    const context = loadTimeline();
    context.offset = now - Date.now();
    context.data = { ...board, log: history.log, timelineAsks: historyResponse.ok ? history.asks : undefined };
    context.renderDetail();
    const vitals = readVitals(context);

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
    });
    await t.test('keeps later same-day plans and explicit UTC dates on their intended day', () => {
      const bySlug = Object.fromEntries(board.timeline.map((entry) => [entry.slug, entry]));
      assert.equal(bySlug.early.atUtc, '2026-11-22T21:00:00.000Z');
      assert.equal(bySlug.early.inMin, 290);
      assert.equal(bySlug.dated.atUtc, '2026-11-22T22:00:00.000Z');
      assert.equal(bySlug.tomorrow.atUtc, '2026-11-23T08:00:00.000Z');
      assert.equal(vitals['overdue risky actions'], '2');
    });
    await t.test('accepts explicit UTC seconds and fractional seconds and rejects impossible dates', () => {
      const bySlug = Object.fromEntries(board.timeline.map((entry) => [entry.slug, entry]));
      assert.equal(bySlug.seconds.atUtc, '2026-11-22T22:00:00.000Z');
      assert.equal(bySlug.fraction.atUtc, '2026-11-22T22:00:00.125Z');
      assert.equal(bySlug['invalid-date'].atUtc, null);
    });
    await t.test('keeps shared polling bounded and serves full Timeline coverage as previews', async () => {
      assert.equal(board.log.length, 60);
      assert.equal(historyResponse.status, 200);
      assert.equal(history.log.length, 352);
      assert.equal(board.logTotal, 354);
      assert.equal(vitals['posts on board'], '354');
      const note = history.log.find((entry) => entry.kind === 'note' && entry.name !== '000-legacy.md');
      assert.ok(note.body.length <= 160);
      const post = await request('/api/timeline/post?name=' + encodeURIComponent(note.name));
      assert.equal(post.status, 200);
      assert.equal((await post.json()).body, longBody.trim());
      const outside = await request('/api/timeline/post?name=' + encodeURIComponent('../status/alpha.md'));
      assert.equal(outside.status, 404);
    });
    await t.test('sorts recent legacy posts alongside canonical posts by timestamp', () => {
      assert.equal(history.log[0].name, '000-legacy.md');
    });
    await t.test('counts visible unanswered asks past the shared 300-entry scan', () => {
      const ask = context.buildAsks(context.data).find((entry) => entry.to === 'beta');
      assert.equal(ask.answered, false);
      assert.equal(vitals['open asks'], '1');
    });
    await t.test('matches a configured human reply to the restored ask', () => {
      const ask = context.buildAsks(context.data).find((entry) => entry.to === 'delta');
      assert.equal(ask.answered, true);
      assert.equal(context.buildReplies(context.data).find((entry) => entry.name === humanReply).re, ask.logName);
    });
    await t.test('updates board alerts on first load and after a history 503', async () => {
      let boardSnapshot = board;
      let historyAvailable = false;
      const view = loadTimeline(async (url) => {
        if (url === '/api/board') return Response.json(boardSnapshot);
        return historyAvailable ? Response.json(history) : new Response(null, { status: 503 });
      });
      view.renderTimeline = () => {};
      const settle = () => new Promise(setImmediate);
      await settle();
      assert.equal(readVitals(view)['overdue risky actions'], '2');
      assert.equal(view.data.log.length, 60);

      historyAvailable = true;
      view.poll();
      await settle();
      assert.equal(view.data.log.length, history.log.length);
      historyAvailable = false;
      boardSnapshot = { ...board, timeline: [] };
      view.poll();
      await settle();
      assert.equal(readVitals(view)['overdue risky actions'], '0');
      assert.equal(view.data.log.length, history.log.length);
      assert.match(view.document.getElementById('poll').textContent, /history unavailable/i);
    });
    await t.test('keeps board polling while history is pending and retries after a timeout', async () => {
      let boardSnapshot = board;
      let historyUnavailable = false;
      let historyRequests = 0, boardRequests = 0;
      let stuckSignal;
      const deadlines = new Map();
      const view = loadTimeline(async (url, options) => {
        if (url === '/api/board') {
          boardRequests++;
          return Response.json(boardSnapshot);
        }
        historyRequests++;
        if (!historyUnavailable) return Response.json(history);
        stuckSignal = options.signal;
        return new Promise((_, reject) => stuckSignal?.addEventListener('abort', () => reject(stuckSignal.reason), { once: true }));
      }, {
        timeout(ms) {
          assert.ok(Number.isFinite(ms) && ms > 0);
          const deadline = new AbortController();
          deadlines.set(deadline.signal, deadline);
          return deadline.signal;
        },
      });
      view.renderTimeline = () => {};
      const settle = () => new Promise(setImmediate);
      await settle();
      historyUnavailable = true;
      view.poll();
      await settle();
      boardSnapshot = { ...board, timeline: [] };
      view.poll();
      await settle();
      assert.equal(boardRequests, 3);
      assert.equal(historyRequests, 2);
      assert.equal(readVitals(view)['overdue risky actions'], '0');
      assert.match(view.document.getElementById('poll').textContent, /refreshing history/i);
      assert.ok(stuckSignal);
      deadlines.get(stuckSignal).abort(new DOMException('History timed out', 'TimeoutError'));
      await settle();
      assert.match(view.document.getElementById('poll').textContent, /history unavailable.*timed out/i);

      historyUnavailable = false;
      view.poll();
      await settle();
      assert.equal(historyRequests, 3);
      assert.equal(view.data.log.length, history.log.length);
      assert.doesNotMatch(view.document.getElementById('poll').textContent, /history unavailable/i);
    });
    await t.test('reuses old legacy metadata on a fresh history build', async () => {
      const before = readFileSync(reads, 'utf8');
      assert.equal(before, 'r');
      writeFileSync(shift, '4000');
      const next = await request(historyResponse.ok ? '/api/timeline' : '/api/board');
      assert.equal(next.status, 200);
      await next.text();
      assert.equal(readFileSync(reads, 'utf8'), before);
      writeFileSync(path.join(logDir, '000-old-legacy.md'), 'from: alpha\nkind: note\nat: 2026-11-22T16:09:58Z\n\nChanged header\n');
      writeFileSync(shift, '8000');
      const changed = await request('/api/timeline');
      assert.equal(changed.status, 200);
      assert.equal((await changed.json()).log[1].body, 'Changed header');
      assert.equal(readFileSync(reads, 'utf8'), 'rr');
    });
    rmSync(path.join(logDir, humanReply));
    const askName = '20261122T160950Z_alpha_ask.md';
    writeFileSync(path.join(logDir, askName), 'from: alpha\nkind: ask\n\n@test-human Please check this\n');
    writeFileSync(shift, '12000');
    const freshBoard = await (await request('/api/board')).json();
    const freshHistory = await (await request('/api/timeline')).json();
    await t.test('draws and counts an ask to a configured human who has never posted', () => {
      assert.equal(freshBoard.asks.find((entry) => entry.ref === askName).answered, false);
      assert.equal(freshHistory.asks.find((entry) => entry.ref === askName).answered, false);
      assert.ok(!freshHistory.log.some((entry) => entry.slug === 'test-human'));
      const snapshot = { ...freshBoard, log: freshHistory.log, timelineAsks: freshHistory.asks };
      const asks = context.visibleAsks(snapshot, now + 12000);
      assert.ok(asks.some((entry) => entry.logName === askName));
      assert.ok(context.laneList(snapshot, asks).some((lane) => lane.slug === 'test-human'));
      assert.equal(context.countOpenAsks(snapshot, now + 12000), 3);
    });
    const replyName = '20261122T160951Z_test-human_reply.md';
    writeFileSync(path.join(logDir, replyName), `from: test-human\nkind: reply\nre: ${askName}\n\nChecked\n`);
    writeFileSync(shift, '16000');
    const answeredBoard = await (await request('/api/board')).json();
    const answeredHistory = await (await request('/api/timeline')).json();
    await t.test('merges a fresh board ask and post into cached history during a 503', async () => {
      let boardSnapshot = board;
      let historyAvailable = true;
      const view = loadTimeline(async (url) => {
        if (url === '/api/board') return Response.json(boardSnapshot);
        return historyAvailable ? Response.json(history) : new Response(null, { status: 503 });
      });
      view.renderTimeline = () => {};
      const settle = () => new Promise(setImmediate);
      await settle();
      boardSnapshot = freshBoard;
      historyAvailable = false;
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '2');
      assert.equal(view.data.log.filter((post) => post.name === askName).length, 1);
      assert.ok(view.data.log.some((post) => post.name === '20261122T131200Z_alpha_ask.md'));
      assert.equal(view.visibleAsks(view.data, now + 12000).find((ask) => ask.logName === askName).answered, false);
    });
    await t.test('merges a fresh board reply while history is pending and keeps the newer snapshot on recovery', async () => {
      let boardSnapshot = freshBoard;
      let historySnapshot = freshHistory;
      let historyPending = false;
      let finishHistory;
      const view = loadTimeline(async (url) => {
        if (url === '/api/board') return Response.json(boardSnapshot);
        if (!historyPending) return Response.json(historySnapshot);
        return new Promise((resolve) => { finishHistory = resolve; });
      });
      view.renderTimeline = () => {};
      const settle = () => new Promise(setImmediate);
      await settle();
      assert.equal(readVitals(view)['open asks'], '3');
      boardSnapshot = answeredBoard;
      historyPending = true;
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '2');
      assert.equal(view.buildAsks(view.data).filter((ask) => ask.logName === askName).length, 1);
      assert.equal(view.buildAsks(view.data).find((ask) => ask.logName === askName).answered, true);
      assert.ok(view.data.log.some((post) => post.name === replyName));

      finishHistory(Response.json(answeredHistory));
      await settle();
      historySnapshot = answeredHistory;
      boardSnapshot = freshBoard;
      historyPending = false;
      view.poll();
      await settle();
      assert.equal(view.buildAsks(view.data).find((ask) => ask.logName === askName).answered, true);
    });
    await t.test('uses the first clock or full dated action time in source order', async () => {
      const actions = [
        ['clock-context', 'release ~16:40Z (supersedes old slot 2026-11-21T22:00Z)', '2026-11-22T16:40:00.000Z'],
        ['invalid-context', 'release ~17:15Z (supersedes invalid slot 2026-02-30T22:00Z)', '2026-11-22T17:15:00.000Z'],
        ['dated-context', 'release 2026-11-23T08:00:17.125Z (supersedes ~16:40Z)', '2026-11-23T08:00:17.125Z'],
      ];
      for (const [slug, action] of actions) {
        writeFileSync(path.join(chat, 'status', `${slug}.md`), `# ${slug} updated: 2026-11-22T16:00:00Z state: active\nNext risky action: ${action}\n`);
      }
      writeFileSync(shift, '20000');
      const snapshot = await (await request('/api/board')).json();
      for (const [slug, , expected] of actions) {
        const entry = snapshot.timeline.find((row) => row.slug === slug);
        assert.equal(entry.atUtc, expected, slug);
        assert.equal(entry.overdue, false, slug);
      }
    });
    await t.test('keeps authorized replies to cached asks through board-scan rollover during an outage', async () => {
      const olderAsk = '20261122T131200Z_alpha_ask.md';
      const secondAsk = '20261122T131220Z_alpha_ask.md';
      const humanAnswer = '20261122T161002Z_test-human_reply.md';
      const recipientAnswer = '20261122T161003Z_delta_reply.md';
      let boardSnapshot = freshBoard;
      let historySnapshot = freshHistory;
      let historyAvailable = true;
      const view = loadTimeline(async (url) => {
        if (url === '/api/board') return Response.json(boardSnapshot);
        return historyAvailable ? Response.json(historySnapshot) : new Response(null, { status: 503 });
      });
      view.renderTimeline = () => {};
      const settle = () => new Promise(setImmediate);
      await settle();
      assert.equal(readVitals(view)['open asks'], '3');
      assert.equal(answeredBoard.asks.find((ask) => ask.ref === askName).answeredVia, 'reply');
      boardSnapshot = answeredBoard;
      historyAvailable = false;
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '2');

      writeFileSync(path.join(logDir, 'z-legacy-reply.md'), `from: test-human\nkind: reply\nre: ${olderAsk}\nat: 2026-11-22T13:11:59Z\n\nEarlier post\n`);
      writeFileSync(path.join(logDir, '20261122T161001Z_gamma_reply.md'), `from: gamma\nkind: reply\nre: ${olderAsk}\n\nUnrelated reply\n`);
      writeFileSync(shift, '24000');
      boardSnapshot = await (await request('/api/board')).json();
      assert.ok(boardSnapshot.log.some((post) => post.name === 'z-legacy-reply.md'));
      assert.ok(boardSnapshot.log.some((post) => post.slug === 'gamma' && post.re === olderAsk));
      assert.ok(boardSnapshot.recentReplies.some((reply) => reply.name === 'z-legacy-reply.md' && reply.byHuman));
      assert.ok(boardSnapshot.recentReplies.some((reply) => reply.from === 'gamma' && !reply.byHuman));
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '2');

      writeFileSync(path.join(logDir, humanAnswer), `from: test-human\nkind: reply\nre: ${olderAsk}\n\nChecked\n`);
      writeFileSync(path.join(logDir, recipientAnswer), `from: delta\nkind: reply\nre: ${secondAsk}\n\nChecked\n`);
      writeFileSync(shift, '28000');
      boardSnapshot = await (await request('/api/board')).json();
      assert.equal(boardSnapshot.log.length, 60);
      assert.ok(boardSnapshot.log.some((post) => post.name === humanAnswer));
      assert.ok(!boardSnapshot.asks.some((ask) => ask.ref === olderAsk || ask.ref === secondAsk));
      assert.deepEqual(boardSnapshot.recentReplies.find((reply) => reply.name === humanAnswer), {
        ref: olderAsk, name: humanAnswer, from: 'test-human', ms: now + 2000, byHuman: true,
      });
      view.poll();
      await settle();

      assert.equal(readVitals(view)['open asks'], '0');
      const asks = view.buildAsks(view.data);
      assert.equal(asks.find((ask) => ask.logName === olderAsk).viaReply, true);
      assert.equal(asks.find((ask) => ask.logName === secondAsk).viaReply, true);
      assert.equal(view.buildReplies(view.data).find((reply) => reply.name === humanAnswer).re, olderAsk);

      for (let i = 1; i <= 301; i++) {
        writeFileSync(path.join(logDir, `20261122T161030Z_gamma_note-${i}.md`), 'from: gamma\nkind: note\n\nUnrelated\n');
      }
      writeFileSync(shift, '36000');
      boardSnapshot = await (await request('/api/board')).json();
      assert.equal(boardSnapshot.log.length, 60);
      for (const name of [humanAnswer, recipientAnswer, replyName]) {
        assert.ok(!boardSnapshot.log.some((post) => post.name === name));
        assert.ok(!boardSnapshot.recentReplies.some((reply) => reply.name === name));
      }
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '0');
      assert.equal(view.visibleAsks(view.data, now + 36000).find((ask) => ask.logName === olderAsk).viaReply, true);
      assert.equal(view.buildReplies(view.data).find((reply) => reply.name === humanAnswer).re, olderAsk);
      assert.equal(view.buildReplies(view.data).find((reply) => reply.name === replyName).re, askName);

      rmSync(path.join(logDir, humanAnswer));
      writeFileSync(shift, '40000');
      historySnapshot = await (await request('/api/timeline')).json();
      assert.equal(historySnapshot.asks.find((ask) => ask.ref === olderAsk).answered, false);
      historyAvailable = true;
      view.poll();
      await settle();
      assert.equal(readVitals(view)['open asks'], '1');
      assert.ok(!view.buildReplies(view.data).some((reply) => reply.name === humanAnswer));
    });
  } finally {
    child.kill();
    await closed;
  }
});
