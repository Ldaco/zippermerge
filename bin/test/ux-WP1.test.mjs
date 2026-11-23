import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext, Script } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/index.html', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../dashboard/dashboard.css', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function declarations(first, last) {
  const start = script.indexOf(`  function ${first}(`);
  const end = script.indexOf(last, start + 1);
  assert.ok(start >= 0 && end > start, `Missing shell functions starting at ${first}`);
  return script.slice(start, end);
}

function declaration(name) {
  return declarations(name, '\n  }\n') + '\n  }';
}

test('The shell has a first skip link, landmarks and reciprocal tab-panel relationships at load', () => {
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /<body>\s*<a class="skip-link" href="#main">/);
  assert.match(html, /<header\b[\s\S]*?<nav\b[^>]*aria-label="Views"[^>]*>\s*<div\b[^>]*role="tablist"/);
  assert.match(html, /<main\b[^>]*id="main"[^>]*>\s*<h1\b/);
  for (const [view, selected] of [['graph', true], ['timeline', false], ['workspace', false], ['atc', false]]) {
    const tab = html.match(new RegExp(`<button[^>]*id="tab-${view}"[^>]*>`))?.[0] ?? '';
    const panel = html.match(new RegExp(`<section[^>]*id="panel-${view}"[^>]*>`))?.[0] ?? '';
    assert.match(tab, /role="tab"/);
    assert.ok(tab.includes(`aria-controls="panel-${view}"`));
    assert.ok(tab.includes(`aria-selected="${selected}"`));
    assert.ok(tab.includes(`tabindex="${selected ? '0' : '-1'}"`));
    assert.match(panel, /role="tabpanel"/);
    assert.ok(panel.includes(`aria-labelledby="tab-${view}"`));
    assert.equal(/\bhidden\b/.test(panel), !selected);
  }
  assert.doesNotMatch(script, /contentWindow\s*\.\s*focus\s*\(/);
  assert.match(script, /document\.title\s*=/);
});

test('Shell presentation consumes shared tokens and uses a selected marker in forced colors', () => {
  assert.match(html, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(|outline\s*:\s*(?:none|0)|animation[^;}]*infinite/i);
  const tokens = new Set([...shared.matchAll(/(--[\w-]+)\s*:/g)].map(([, token]) => token));
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) assert.ok(tokens.has(token), token);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*?HighlightText/);
  assert.match(css, /minmax\(20rem,\s*1fr\)/);
  assert.match(html, /aria-hidden="true"[^>]*>\s*1<\/kbd>/);
});

test('Composer exposes labelled native form controls and mounted announcement regions', () => {
  const composer = html.match(/<dialog\b[^>]*id="composer"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(composer, /aria-labelledby="cmpTitle"/);
  assert.match(composer, /<form\b/);
  for (const [field, label] of [['cmpTo', 'Recipient'], ['cmpKind', 'Message type'], ['cmpText', 'Message'], ['cmpRe', 'Reply to']]) {
    assert.match(composer, new RegExp(`<label[^>]*for="${field}"[^>]*>${label}</label>`));
  }
  assert.match(composer, /<textarea[^>]*aria-describedby="[^"]+"[^>]*>/);
  assert.match(composer, /<button[^>]*type="submit"/);
  assert.match(composer, /<button[^>]*>Close<\/button>/);
  assert.match(composer, /<button[^>]*>Cancel<\/button>/);
  assert.match(composer, /role="alert"[^>]*><\/div>/);
  assert.match(html, /role="status" aria-atomic="true"[^>]*><\/div>/);
  assert.match(script, /\.showModal\(\)/);
  assert.match(script, /addEventListener\('pointerdown'/);
  assert.match(script, /addEventListener\('pointercancel'/);
});

test('A late dialog close event restores lost focus and respects a newer focused control', () => {
  const body = {};
  const document = { body, activeElement: body };
  const createControl = () => ({
    matches(selector) { return selector === ':focus' && document.activeElement === this; },
    focus() { document.activeElement = this; },
  });
  const opener = createControl();
  const next = createControl();
  const events = new Map();
  const dialog = { open: false, addEventListener: (type, fn) => events.set(type, fn), contains: () => false };
  const wireDialog = runInNewContext(`${declaration('wireDialog')}\nwireDialog`, {
    document, isAvailableOpener: () => true, canPost: () => true, msgBtn: opener,
  });
  wireDialog(dialog, () => opener);
  events.get('close')();
  assert.equal(document.activeElement, opener);
  next.focus();
  events.get('close')();
  assert.equal(document.activeElement, next);
});

const snapshot = (meta = { writeEnabled: true }) => ({
  now: '2026-11-23T18:42:00Z', sessions: [{ slug: 'atlas' }], locks: [], attention: [], meta,
});

function boardHelpers() {
  const helpers = declarations('isBoard', '  function showBoard(');
  return runInNewContext(`${declaration('utc')}\n${helpers}\n({isBoard, boardSummary, boardMessage})`);
}

test('Board validation distinguishes verified empty data, malformed data and unsupported capabilities', () => {
  const { isBoard } = boardHelpers();
  assert.equal(isBoard({ ...snapshot(), sessions: [] }), true);
  for (const board of [null, [], { error: 'Unavailable' }, { ...snapshot(), sessions: null },
    { ...snapshot(), attention: [null] }, { ...snapshot(), meta: { stale: 'false' } }]) {
    assert.equal(isBoard(board), false);
  }
  const canPost = declaration('canPost') + '\ncanPost';
  for (const [tokenOk, connection, lastBoard, allowed] of [
    [true, 'live', snapshot(), true], [true, 'live', snapshot({}), false],
    [true, 'live', snapshot({ writeEnabled: 'true' }), false], [true, 'live', snapshot({ writeEnabled: false }), false],
    [true, 'saved', snapshot(), false], [true, 'offline', snapshot(), false], [false, 'live', snapshot(), false],
  ]) {
    assert.equal(runInNewContext(canPost, { tokenOk, connection, lastBoard })(), allowed);
  }
});

test('The summary keeps session count, merge freeze owner and both severities distinct', () => {
  const { boardSummary, boardMessage } = boardHelpers();
  const summary = boardSummary({ ...snapshot(), locks: [{ file: 'locks/main-freeze.md', owner: 'atlas' }],
    attention: [{ sev: 'red' }, { sev: 'red' }, { sev: 'amber' }, { sev: 'future-status' }] });
  assert.deepEqual({ ...summary }, { sessions: 1, freeze: 'atlas', urgent: 2, warning: 1, unknown: 1 });
  const stamp = Date.parse(snapshot().now);
  assert.match(boardMessage('live', stamp), /Live.*18:42 UTC/);
  assert.match(boardMessage('saved', stamp), /saved copy.*18:42 UTC/);
  assert.match(boardMessage('offline', stamp), /Offline · showing data from 18:42 UTC/);
  assert.match(boardMessage('error', null), /Couldn.t load the board/);
});

test('A cached board uses its snapshot time and cannot replace a newer retained board', () => {
  const rendered = [];
  const context = {
    lastBoard: null, snapshotAt: null, connection: 'loading', rejectedRecipient: '',
    renderBoard: (previous) => rendered.push(previous),
  };
  const { showBoard, showBoardFailure } = runInNewContext(
    `${declaration('showBoard')}\n${declaration('showBoardFailure')}\n({ showBoard, showBoardFailure })`, context,
  );
  const cachedAt = '2026-11-23T18:32:00Z';
  const cached = { ...snapshot({ stale: true, cachedAt }), sessions: [] };
  showBoard(cached);
  assert.equal(context.snapshotAt, Date.parse(cachedAt));
  assert.equal(context.connection, 'saved');
  const live = snapshot();
  showBoard(live);
  showBoard(cached);
  assert.equal(context.lastBoard, live);
  assert.equal(context.snapshotAt, Date.parse(live.now));
  assert.equal(context.connection, 'offline');
  showBoardFailure();
  assert.equal(context.lastBoard, live);
  assert.deepEqual(rendered, ['loading', 'saved', 'live', 'offline']);
});

test('Single-key controls honour cancellation, modifier keys, editing and the shared preference', () => {
  const code = declarations('onKey', '  function announce(') + '\nhandleKey';
  const actions = [];
  const context = {
    embeddedModal: false, shortcuts: { open: false }, keysEnabled: true,
    composerOpen: () => false, canPost: () => true, openComposer: () => actions.push('message'),
    activateShortcut: (key) => actions.push(key),
  };
  const handleKey = runInNewContext(code, context);
  const press = (key, fields = {}) => {
    let consumed = false;
    handleKey({ key, ...fields, preventDefault() { consumed = true; } });
    return consumed;
  };
  for (const fields of [{ defaultPrevented: true }, { repeat: true }, { isComposing: true }, { altKey: true },
    { target: { tagName: 'TEXTAREA' } }, { target: { isContentEditable: true } }]) {
    assert.equal(press('m', fields), false);
  }
  context.keysEnabled = false;
  assert.equal(press('m'), false);
  assert.equal(press('4'), false);
  context.keysEnabled = true;
  assert.equal(press('m'), true);
  assert.equal(press('4'), true);
  assert.deepEqual(actions, ['message', '4']);
});

function pollingHarness({ response, paused = false, hidden = false }) {
  const timers = new Map();
  const events = [];
  let id = 0;
  let requests = 0;
  let nextResponse = response;
  const context = {
    AbortController, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout(handle) { timers.delete(handle); },
    document: { hidden }, paused, pollTimer: null, inFlight: null, failures: 0, refreshQueued: false,
    isBoard: boardHelpers().isBoard,
    showBoard: (board) => events.push(board), showBoardFailure: () => events.push('offline'),
    fetch(...args) { requests++; return nextResponse(...args); },
  };
  const code = declarations('schedulePoll', '\n  refreshBtn.addEventListener');
  const poll = runInNewContext(`${code}\npoll`, context);
  return { poll, timers, events, requests: () => requests, respondWith: (fn) => { nextResponse = fn; } };
}

test('Concurrent refreshes share one request, and a slow server times out before a retry is scheduled', async () => {
  const harness = pollingHarness({ response: (url, { signal }) => new Promise((resolve, reject) => {
    assert.equal(url, '/api/board');
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const started = harness.poll();
  await harness.poll(true);
  assert.equal(harness.requests(), 1);
  assert.equal(harness.timers.size, 1);
  const timeout = [...harness.timers.values()][0];
  assert.ok(timeout.ms > 0 && timeout.ms < 12_000);
  timeout.fn();
  await started;
  assert.deepEqual(harness.events, ['offline']);
  assert.equal(harness.timers.size, 1);
  assert.ok([...harness.timers.values()][0].ms <= 60_000);
});

test('HTTP 500 JSON and invalid successful JSON never render live data', async () => {
  const harness = pollingHarness({ response: async () => ({ ok: false, json: async () => snapshot() }) });
  await harness.poll();
  harness.respondWith(async () => ({ ok: true, json: async () => ({ error: 'Unexpected response' }) }));
  await harness.poll(true);
  assert.deepEqual(harness.events, ['offline', 'offline']);
  harness.respondWith(async () => ({ ok: true, json: async () => snapshot() }));
  await harness.poll(true);
  assert.deepEqual(harness.events.at(-1), snapshot());
});

test('Pause and document visibility stop automatic polls while a visible paused board can refresh', async () => {
  const response = async () => ({ ok: true, json: async () => snapshot() });
  const hidden = pollingHarness({ hidden: true, response });
  await hidden.poll();
  assert.equal(hidden.requests(), 0);
  const paused = pollingHarness({ paused: true, response });
  await paused.poll();
  assert.equal(paused.requests(), 0);
  await paused.poll(true);
  assert.equal(paused.requests(), 1);
  assert.equal(paused.timers.size, 0);
});
