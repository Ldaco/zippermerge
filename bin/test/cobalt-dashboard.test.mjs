import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ciBlocker, summarizeCi } from '../pr-ci.mjs';

const source = file => readFileSync(new URL('../../dashboard/' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const shell = source('index.html');
const workspace = source('views/workspace.html');
const graph = source('views/graph.html');
const server = source('server.mjs');

// Exercise the actual inline handlers with deterministic clocks and transport.
function declaration(text, name) {
  const match = text.match(new RegExp('^( *)(?:async )?function ' + name + '\\([^\\n]*\\n[\\s\\S]*?^\\1\\}', 'm'));
  assert.ok(match, name);
  return match[0];
}
function script(text, names, expression, context) {
  return runInNewContext(names.map(name => declaration(text, name)).join('\n') + '\n' + expression, context);
}
function shellContext() {
  return {
    tokenOk: true, lastBoard: null, connection: 'loading', snapshotAt: null, rejectedRecipient: '',
    document: { hidden: false }, renderBoard() {}, paused: false, failures: 0,
    inFlight: null, refreshQueued: false, pollTimer: null, setTimeout() {}, clearTimeout() {}, AbortController,
  };
}
const shellPoll = context => script(shell, ['isBoard', 'schedulePoll', 'poll', 'showBoard', 'showBoardFailure',
  'canPost', 'boardMessage', 'utc'], '({poll, canPost, boardMessage})', context);

test('#104 HTTP failure and an hour-old saved response keep the shell read-only', async () => {
  const ctx = shellContext();
  const api = shellPoll(ctx);
  const at = '2026-11-23T14:15:00Z';
  const cachedAt = '2026-11-23T13:15:00Z';
  const board = { now: at, sessions: [{ slug: 'one' }], locks: [], attention: [], meta: { writeEnabled: true } };
  for (const [ok, value, state, writable] of [
    [false, { error: 'Synthetic error' }, 'error', false],
    [true, { ...board, meta: { ...board.meta, stale: true, cachedAt } }, 'saved', false],
    [true, board, 'live', true], [true, {}, 'offline', false],
  ]) {
    ctx.fetch = async () => ({ ok, json: async () => value });
    await api.poll();
    assert.equal(ctx.connection, state);
    assert.equal(api.canPost(), writable);
    if (state === 'saved') assert.match(api.boardMessage(state, ctx.snapshotAt), /saved copy from 13:15 UTC/);
  }
  assert.equal(ctx.lastBoard, board);
});

test('#106 opening Workspace during a slow shell request makes only one board GET', async () => {
  let count = 0;
  let finish;
  const fetch = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const ctx = { ...shellContext(), fetch };
  const api = shellPoll(ctx);
  const pending = api.poll();
  const view = { fetch, S: {}, paused: false, pref: () => null, POLL: 5000, window: {},
    document: { hidden: false }, setTimeout() {}, clearTimeout() {}, AbortController,
    shellBoard: { refreshBoard: () => api.poll(true) }, renderConnection() {} };
  const poll = script(workspace, ['poll'], 'poll', view);
  void poll();
  await api.poll(true);
  assert.equal(count, 1);
  finish({ ok: false });
  await pending;
});

test('#109 Workspace groups check words, linked title and secondary metadata per PR', () => {
  const h = (tag, cls, text, children = []) => ({ tag, cls, text, children, get firstChild() { return children[0]; },
    appendChild(child) { children.push(child); } });
  const row = script(workspace, ['mqSafeUrl', 'prTitle', 'prLine'], 'prLine', {
    h, prCi: p => p.checks.conclusion, prFailing: p => p.checks.conclusion === 'failure',
    str: String, keyed: node => node, addText: (node, text) => { node.text = text; }, URL,
    tms: Date.parse, tm: value => h('time', '', value), statusChip: text => h('span', 'chip', text),
  });
  for (const [ci, label] of Object.entries({ failure: 'Checks failed', pending: 'Checks running', success: 'Checks passed', none: 'No checks' })) {
    const pr = { number: 7, title: 'Update board', url: 'https://github.com/example/fixture/pull/7', checks: { conclusion: ci },
      headRef: 'topic/long-branch', draft: true, updatedAt: '2026-11-23T14:15:00Z' };
    const [title, status, meta] = row(pr).children;
    assert.equal(title.children[0].href, pr.url);
    assert.equal(title.children[0].text, '#7 Update board');
    assert.equal(status.children[0].text, label);
    assert.deepEqual(meta.children.map(e => e.text), ['Draft', pr.headRef, pr.updatedAt]);
  }
  assert.match(workspace, /\.prr\s*\{[^}]*display:\s*grid/);
});

test('#126 check-run failure blocks readiness and has a distinct Graph label', async () => {
  const prState = {};
  await script(server, ['refreshPrs'], 'refreshPrs()', {
    PR_REPO: 'fixture/repo', prState, listOpenPrs: async () => [{ number: 1, sha: 'fixture' }],
    pooled: (items, n, fn) => Promise.all(items.map(fn)), fetchCheckRuns: async () => { throw Error('HTTP 503'); },
    fetchCommitStatus: async () => 'none', summarizeCi, schedulePrs() {}, PR_RATE_LIMIT_BACKOFF_MS: 1000,
  });
  const checks = prState.items[0].checks;
  assert.equal(checks.conclusion, 'unknown');
  assert.equal(ciBlocker(checks).state, 'unknown');
  const states = graph.slice(graph.indexOf('  const CI_STATES'), graph.indexOf('  function makeCiMark'));
  const label = runInNewContext(states + '\nciStatus');
  assert.match(label(checks.conclusion).label, /unknown/i);
  assert.notEqual(label('none').mark, label('unknown').mark);
});

test('#126 failed merged-list refresh retains history and reports the cause', async () => {
  const mqMerged = { items: [{ number: 1 }], fetchedAt: 'previous' };
  const errors = [];
  await script(server, ['refreshMqMerged'], 'refreshMqMerged()', {
    PR_REPO: 'fixture/repo', mqMerged, githubPollingPaused: () => false, MQ_JQ: '',
    requestDashboardPrApi: async () => ({ ok: false, err: 'upstream HTTP 503' }),
    console: { warn: (...args) => errors.push(args.join(' ')), error: (...args) => errors.push(args.join(' ')) },
  });
  assert.deepEqual(mqMerged.items, [{ number: 1 }]);
  assert.equal(mqMerged.fetchedAt, 'previous');
  assert.match(errors.join('\n'), /503/);
});

for (const [field, error, code] of [
  ['to', 'unknown to', 'UNKNOWN_RECIPIENT'], ['re', 'bad re', 'INVALID_REPLY_TARGET'],
]) {
  test('#110 ' + field + ' rejection identifies the stale field and preserves the draft', async () => {
    const body = { kind: 'reply', text: 'Keep my draft', to: 'all', re: '20261122T000000Z_atlas_ask.md' };
    if (field === 'to') body.to = 'departed';
    const result = await script(server, ['handlePost'], 'handlePost(req, {})', {
      req: { headers: { 'content-type': 'application/json', 'x-zm-token': 'fixture' } },
      POST_KINDS: new Set(['reply']), RE_NAME: /\.md$/, path: { join: (...a) => a.join('/') }, ROOT: 'scratch',
      timingSafeEqual: (a, b) => a === b, sha: String, WRITE_TOKEN: 'fixture', POST_MAX_BYTES: 65536,
      listMd: async () => [], readBodyLimited: async () => JSON.stringify(body),
      jsonReply: (_, status, json) => ({ status, json }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.json.error, error);
    assert.equal(result.json.code, code);
    const text = { value: body.text }, to = { value: body.to }, re = { value: body.re };
    let invalid;
    const ctx = {
      sending: false, composerOpen: () => true, cSend: { getAttribute() {} }, cKind: { value: 'reply' },
      cText: text, cTo: to, cReply: re, cPending: {}, draftVersion: 0, composerVersion: 0,
      syncComposer() {}, showComposerError: (_, control) => { invalid = control; }, refreshAfterPost() {},
      fillRecipients() { to.value = ''; }, fillReplyTargets() { re.value = ''; },
      AbortSignal, token: 'fixture', fetch: async () => ({ ok: false, json: async () => ({ code }) }),
    };
    await script(shell, ['sendPost'], 'sendPost()', ctx);
    assert.equal(invalid, field === 'to' ? to : re);
    assert.equal(invalid.value, '');
    assert.equal(text.value, body.text);
  });
}
test('#106 only the active frame receives the retained board, including after a missed refresh', () => {
  const received = [];
  const frame = name => ({ contentDocument: {}, contentWindow: { dispatchEvent: event => {
    received.push([name, event.detail.board, event.detail.connection]);
  } } });
  const board = { now: '2026-11-23T14:15:00Z' };
  const ctx = { frames: new Map([['graph', frame('graph')], ['atc', frame('atc')]]), current: 'graph',
    lastBoard: board, connection: 'live', CustomEvent, document: { hidden: false } };
  const publish = script(shell, ['publishBoard'], 'publishBoard', ctx);
  publish();
  ctx.document.hidden = true;
  publish();
  ctx.current = 'atc';
  ctx.document.hidden = false;
  ctx.connection = 'offline';
  publish();
  assert.deepEqual(received, [['graph', board, 'live'], ['atc', board, 'offline']]);
});
