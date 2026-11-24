import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/timeline.html', import.meta.url), 'utf8');
const [, script] = html.match(/<script>([\s\S]*?)<\/script>/);
const view = script.slice(0, script.indexOf('\nlegendRow();'));
const now = Date.parse('2026-11-23T14:00:00Z');
const iso = time => new Date(time).toISOString();
const askTime = now - 90 * 60_000;
const askRef = '20261123T123000Z_alpha_ask.md';
const otherAskRef = '20261123T123100Z_alpha_ask.md';
const betaId = askRef + '>beta', gammaId = otherAskRef + '>gamma';

function timeline(fetch) {
  const nodes = new Map();
  const document = {
    getElementById(name) {
      if (!nodes.has(name)) nodes.set(name, { textContent: '', setAttribute() {} });
      return nodes.get(name);
    },
  };
  return runInNewContext(view + `
    renderDetail = () => {};
    refreshEvents = () => {};
    renderTimeline = () => {};
    ({
      poll, mergeTimelineHistory,
      open() { return countOpenAsks(data, Date.now()); },
      asks() { return data.timelineAsks; },
      historyError() { return historyPoll.error; },
    })
  `, { document, window: {}, fetch, AbortSignal, Date: class extends Date { static now() { return now; } } });
}

test('a status-only answer closes just its cached ask target during a history 503', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'zm-timeline-131-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const chat = join(scratch, 'chat'), repo = join(scratch, 'repo');
  const statusDir = join(chat, 'status'), logDir = join(chat, 'log');
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(logDir);
  execFileSync('git', ['init', '-q', repo], { cwd: scratch });
  const setStatus = (slug, time) => {
    const file = join(statusDir, slug + '.md');
    writeFileSync(file, '# ' + slug + ' updated: ' + iso(time) + ' state: active\nWork: Checking the board\n');
    utimesSync(file, new Date(time), new Date(time));
  };
  for (const slug of ['alpha', 'beta', 'gamma']) setStatus(slug, askTime);
  writeFileSync(join(logDir, askRef), 'from: alpha\nkind: ask\n\n@beta Please check this\n');
  writeFileSync(join(logDir, otherAskRef), 'from: alpha\nkind: ask\n\n@gamma Please check that\n');
  for (let i = 0; i < 301; i++) {
    const stamp = iso(now - 60 * 60_000 + i * 1000).replace(/[-:]|\.\d{3}/g, '');
    writeFileSync(join(logDir, stamp + '_alpha_note.md'), 'from: alpha\nkind: note\n\nUnrelated update\n');
  }

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  const listenerClosed = once(listener, 'close');
  listener.close();
  await listenerClosed;
  const shift = join(scratch, 'shift');
  writeFileSync(shift, '0');
  const preload = `import { readFileSync } from 'node:fs';
    Date.now = () => ${now} + Number(readFileSync(${JSON.stringify(shift)}, 'utf8'));`;
  const server = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), server, '--port', String(port)], {
    cwd: scratch,
    env: { ...process.env, CHAT_DIR: chat, ZM_REPO: repo, ZM_PR_REPO: '', ZM_HUMAN: 'test-human', BOARD_CACHE_FILE: join(scratch, 'board.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = once(child, 'close');
  try {
    const [output] = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code]) => assert.fail('Dashboard exited before listening (' + code + ')')),
    ]);
    assert.match(String(output), /zippermerge dashboard:/);
    const snapshot = async url => {
      const response = await fetch('http://127.0.0.1:' + port + url, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const history = await snapshot('/api/timeline');
    let board = await snapshot('/api/board');
    assert.equal(history.log.length, 303);
    assert.ok(!board.asks.some(ask => ask.ref === askRef || ask.ref === otherAskRef));
    for (const id of [betaId, gammaId]) assert.equal(history.asks.find(ask => ask.id === id).answered, false);

    let historyDown = false;
    const app = timeline(async url => url === '/api/board' ? Response.json(board) :
      historyDown ? new Response(null, { status: 503 }) : Response.json(history));
    const settle = () => new Promise(setImmediate);
    app.poll();
    await settle();
    assert.equal(app.open(), 2);

    const statusTime = now + 1000;
    setStatus('beta', statusTime);
    writeFileSync(shift, '5000');
    board = await snapshot('/api/board');
    assert.equal(board.sessions.find(session => session.slug === 'beta').mtime, iso(statusTime));
    assert.ok(!board.asks.some(ask => ask.ref === askRef));
    assert.ok(!board.log.some(post => post.slug === 'beta'));
    assert.ok(!board.recentReplies.length);
    historyDown = true;
    app.poll();
    await settle();

    assert.equal(app.historyError(), 'HTTP 503');
    assert.equal(app.open(), 1);
    const answered = app.asks().find(ask => ask.id === betaId);
    assert.equal(answered.answeredVia, 'heuristic');
    assert.equal(answered.answeredAt, iso(statusTime));
    assert.equal(answered.answeredBy, 'beta');
    assert.equal(answered.replyRef, null);
    assert.equal(app.asks().find(ask => ask.id === gammaId).answered, false);
  } finally {
    child.kill();
    await closed;
  }
});

test('cached heuristic answers stay per target and yield to explicit replies or newer history', () => {
  const app = timeline();
  const asks = ['beta', 'gamma'].map(to => ({
    id: askRef + '>' + to, ref: askRef, source: 'log', from: 'alpha', to, at: iso(askTime), answered: false,
  }));
  const history = { now: iso(now), asks };
  const statusTime = now + 1000;
  const board = { now: iso(now + 2000), sessions: [{ slug: 'beta', mtime: iso(statusTime) }] };
  const lookup = (snapshot, historySnapshot = history) =>
    app.mergeTimelineHistory(snapshot, historySnapshot).timelineAsks.find(ask => ask.id === betaId);

  assert.equal(lookup(board).answeredAt, iso(statusTime));
  assert.equal(app.mergeTimelineHistory(board, history).timelineAsks.find(ask => ask.to === 'gamma').answered, false);
  const advanced = { now: iso(now + 4000), sessions: [{ slug: 'beta', mtime: iso(now + 3000) }] };
  assert.equal(lookup(advanced).answeredAt, iso(statusTime));
  const published = {
    ...advanced, asks: [{ ...asks[0], answered: true, answeredVia: 'heuristic', answeredAt: iso(now - 1000) }],
  };
  assert.equal(lookup(published).answeredAt, iso(now - 1000));
  const reply = { ref: askRef, from: 'beta', ms: now + 5000, name: 'beta_reply.md', byHuman: false };
  const explicit = lookup({ ...advanced, now: iso(now + 6000), recentReplies: [reply] });
  assert.equal(explicit.answeredVia, 'reply');
  assert.equal(explicit.replyRef, reply.name);
  const next = { now: iso(now + 8000), sessions: [{ slug: 'beta', mtime: iso(now + 7000) }] };
  assert.equal(lookup(next).replyRef, reply.name);
  const newerHistory = { now: iso(now + 9000), asks };
  assert.equal(lookup(next, newerHistory).answered, false);
});
