import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';

const view = name => readFileSync(new URL('../../dashboard/views/' + name + '.html', import.meta.url), 'utf8');
const timeline = view('timeline');
const [, css] = timeline.match(/<style>([\s\S]*?)<\/style>/);
const [, script] = timeline.match(/<script>([\s\S]*?)<\/script>/);
const markup = timeline.slice(timeline.indexOf('<body>'), timeline.indexOf('<script>'));

function model(document = { getElementById: () => ({ textContent: '' }) }, window = {}, redraw = () => assert.fail('the clock must not redraw the plot')) {
  const boundary = script.indexOf('\nlegendRow();');
  assert.ok(boundary > 0, 'the view initializes after its functions are defined');
  return runInNewContext(script.slice(0, boundary) + `
    data = {};
    renderTimeline = unexpectedRedraw;
    ({ timelineEntries, clusterTargets, identityIndices, slugColor, queueStatus, tick, announceTimeline, syncPaused, connection,
       show(board) { data = board; renderDetail(); },
       receive(board) {
         renderDetail = () => {};
         refreshEvents = () => {};
         boardPoll.value = board;
         renderPoll();
       } })
  `, {
    document,
    Date: class extends Date { static now() { return now; } },
    window,
    unexpectedRedraw: redraw,
  });
}

test('Timeline exposes the shared landmarks, named chart scroller, and native event table', () => {
  assert.doesNotThrow(() => new Script(script));
  assert.match(timeline, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.match(markup, /^<body>\s*<a class="skip-link" href="#main">/);
  assert.match(markup, /<main id="main"[^>]*>[\s\S]*<h1 id="view-title" tabindex="-1">/);
  assert.equal([...markup.matchAll(/<h1\b/g)].length, 1);
  assert.match(markup, /<table[^>]*>[\s\S]*?<caption[^>]*>[^<]+<\/caption>[\s\S]*?<th scope="col">Time \(UTC\)/);
  assert.ok(markup.indexOf('id="events"') < markup.indexOf('id="chart"'));
  assert.match(markup, /<div[^>]*id="tlwrap"[^>]*role="region"[^>]*aria-label="Timeline plot"[^>]*tabindex="0"/);
  assert.match(markup, /<div[^>]*id="event-scroll"[^>]*role="region"[^>]*aria-label="Events table"[^>]*tabindex="0"/);
  assert.match(script, /role: 'img', 'aria-labelledby': 'plot-title plot-description'/);
  assert.match(markup, /id="inspector"[^>]*aria-labelledby="inspector-title"/);
  assert.match(markup, /id="close-event"[^>]*>Close<\/button>/);
  assert.match(markup, /role="status" aria-atomic="true"/);
});

test('Timeline uses shared colors, measured SVG labels, and a forced-colors selection cue', () => {
  assert.doesNotMatch(css + script, /(?:[:=,]\s*|['"])#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
  assert.doesNotMatch(css, /outline\s*:\s*(?:0|none)|all\s*:\s*unset|\.f\.none[^{}]*\{[^}]*opacity/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /CanvasText/);
  assert.match(css, /HighlightText/);
  assert.match(script, /\.getBBox\(/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(script, /'aria-expanded'/);
  assert.match(script, /'aria-controls'/);
});

const now = Date.parse('2026-11-23T14:00:00Z');
const iso = minutes => new Date(now + minutes * 60000).toISOString();
const askRef = 'ask.md';
const fixture = {
  sessions: [{ slug: 'atlas', hb: { minutes: [15], nextAt: iso(15) } }, { slug: 'cedar' }],
  log: [
    { slug: 'atlas', timestamp: iso(-10), kind: 'ask', name: askRef, body: 'Please check the queue' },
    { slug: 'cedar', timestamp: iso(-9), kind: 'reply', name: 'reply.md', re: askRef, body: 'Queue clear' },
  ],
  timelineAsks: [{ source: 'log', ref: askRef, from: 'atlas', to: 'cedar', at: iso(-10), answered: true, answeredVia: 'reply' }],
  locks: [{ lock: 'main-freeze', owner: 'atlas', since: iso(-20), why: 'Release' }],
  claims: [{ number: 42, name: 'add_column', owner: 'atlas', claimed: iso(-30), ref: 'Schema PR' }],
  reservations: [{ id: 'res-1', owner: 'cedar', pattern: 'web/**', mode: 'future-mode', since: iso(-10), expiresAt: iso(10), why: 'Edit web' }],
  timeline: [
    { slug: 'atlas', source: 'status', atUtc: iso(5), text: 'Deploy' },
    { slug: 'atlas', source: 'status', atUtc: null, text: 'Run suite' },
    { slug: 'atlas', source: 'lock', atUtc: iso(20), text: 'Release main-freeze' },
  ],
  activity: { sessions: { atlas: { nowDoing: 'Working', subagentsRunning: 1 } }, events: [
    { slug: 'atlas', event: 'bash', category: 'test', ts: iso(-6), cmd: 'node --test' },
    { slug: 'atlas', event: 'bash', category: 'build', ts: iso(-6), cmd: 'npm run build' },
    { slug: 'atlas', event: 'stop', ts: iso(-5) },
    { slug: 'atlas', event: 'edit', ts: iso(-1), file: 'dashboard/views/timeline.html' },
  ] },
  mergeQueue: { merged: [{ number: 53, mergedAt: iso(-2), owner: 'cedar', title: 'Merged title', base: 'main', mergedBy: 'release-manager' }] },
};

test('the chart and table carry stable records for posts, relationships, hooks and deadlines', () => {
  const { timelineEntries } = model();
  const events = timelineEntries(fixture, now);
  assert.equal(new Set(events.map(event => event.key)).size, events.length);
  const find = text => events.find(event => (event.title + '\n' + event.body).toLowerCase().includes(text.toLowerCase()));
  for (const text of ['Please check the queue', 'Queue clear', 'Release', 'Schema PR', 'web/**',
    'Deploy', 'Run suite', 'node --test', 'npm run build', 'dashboard/views/timeline.html',
    'Merged title', 'release-manager', 'Heartbeat', 'Idle']) {
    assert.ok(find(text), text);
  }
  assert.equal(find('node --test').type, 'Test');
  assert.equal(find('npm run build').type, 'Build');
  assert.equal(find('Run suite').time, null);
  assert.equal(find('web/**').status, 'Unknown reservation mode · Active');
  assert.ok(events.some(event => event.type === 'Ask' && event.status === 'Answered via reply' && event.session.includes('cedar')));
  assert.ok(events.some(event => event.type === 'Reply' && event.session.includes('atlas')));
  for (const event of events) {
    assert.ok(timelineEntries(fixture, now + 1000).some(next => next.key === event.key), event.key);
  }
});

test('nearby chart targets cluster without replacing the original keyboard records', () => {
  const { clusterTargets } = model();
  const clusters = clusterTargets([
    { key: 'b', x: 104, y: 48 }, { key: 'a', x: 100, y: 48 }, { key: 'c', x: 145, y: 48 },
    { key: 'd', x: 145, y: 100 },
  ]);
  assert.equal(clusters.length, 3);
  assert.deepEqual(Array.from(clusters[0].keys).sort(), ['a', 'b']);
  assert.deepEqual(Array.from(clusters.flatMap(cluster => cluster.keys)).sort(), ['a', 'b', 'c', 'd']);
  for (const [index, first] of clusters.entries()) {
    for (const second of clusters.slice(index + 1)) {
      assert.ok(Math.abs(first.x - second.x) >= 24 || Math.abs(first.y - second.y) >= 24);
    }
  }
});

test('the identity allocation matches Graph and unknown queue states stay unknown', () => {
  const { identityIndices, slugColor, queueStatus } = model();
  const [, graphHelpers] = view('graph').match(/\/\* GRAPH-IDENTITY-BEGIN \*\/([\s\S]*?)\/\* GRAPH-IDENTITY-END \*\//);
  const graph = runInNewContext(graphHelpers + '\n({ identityIndices, slugColor })', { str: String });
  const sessions = ['atlas', 'cedar', 'beacon', 'ember', 'alpha', 'delta', 'foxtrot'].map(slug => ({ slug }));
  const first = identityIndices(sessions);
  const firstGraph = graph.identityIndices(sessions);
  const next = sessions.slice(1).reverse();
  const second = identityIndices(next, first);
  const secondGraph = graph.identityIndices(next, firstGraph);
  for (const { slug } of sessions) assert.equal(slugColor(slug, first), graph.slugColor(slug, firstGraph));
  for (const { slug } of next) assert.equal(slugColor(slug, second), graph.slugColor(slug, secondGraph));
  assert.equal(slugColor('', second), 'var(--identity-fallback)');
  assert.equal(queueStatus('ready').label, 'Ready');
  assert.equal(queueStatus('prototype').label, 'Unknown status');
  assert.equal(queueStatus('__proto__').label, 'Unknown status');
  assert.equal(queueStatus().label, 'Unknown status');
});

test('the one-second tick updates time without rendering a Timeline or replacing its SVG', () => {
  const clock = { textContent: '' };
  const { tick } = model({ getElementById(id) { assert.equal(id, 'clock'); return clock; } });
  tick();
  assert.match(clock.textContent, /14:00:00 UTC$/);
});

test('Timeline keeps the old rollups, queue, session fields and board detail panels', () => {
  class Element {
    nodeType = 1;
    childNodes = [];
    get children() {
      const nodes = this.childNodes.filter(child => child.nodeType === 1);
      return { [Symbol.iterator]: () => nodes[Symbol.iterator]() };
    }
    get textContent() { return this.childNodes.map(child => child.textContent).join(' '); }
    setAttribute() {}
    appendChild(child) { this.childNodes.push(child); }
    replaceChildren(...nodes) { this.childNodes = nodes; }
  }
  const regions = new Map();
  const document = {
    getElementById(id) {
      if (!regions.has(id)) regions.set(id, new Element());
      return regions.get(id);
    },
    createElement: () => new Element(),
    createElementNS: () => new Element(),
    createTextNode: textContent => ({ nodeType: 3, textContent }),
    querySelectorAll: () => [],
  };
  model(document).show({
    ...fixture,
    logTotal: 42,
    attention: [
      { sev: 'red', kind: 'alert', slug: 'atlas', text: 'Inspect failed build' },
      { sev: 'amber', kind: 'alert', slug: 'atlas', text: 'Check the deadline' },
      { sev: 'unrecognized', kind: 'alert', slug: 'atlas', text: 'New alert type' },
    ],
    sessions: [{ ...fixture.sessions[0], fields: { Work: { value: 'Run migration checks' } } }],
    migrations: { mainMax: 41, files: [{ n: 42, name: '042_add_column.sql' }] },
    hotFileOverlaps: [{ file: 'dashboard/views/timeline.html', sessions: [{ slug: 'atlas', lines: ['Marker changes'] }] }],
    worktrees: { items: [{ name: 'work-atlas', dirty: 0, lastSubject: 'Fixture commit' }] },
  });
  for (const [region, expected] of [
    ['banners', /Release.*Inspect failed build/],
    ['vitals', /42 posts on board/],
    ['mq', /Landed today \(UTC\).*Merged title/],
    ['sessions', /Run migration checks/],
    ['panels', /Locks and countdowns.*042_add_column\.sql.*Marker changes.*Fixture commit.*Please check the queue/],
  ]) {
    assert.match(document.getElementById(region).textContent, expected);
  }
  for (const region of ['banners', 'panels']) {
    const text = document.getElementById(region).textContent;
    assert.match(text, /Urgent/);
    assert.match(text, /Warning/);
    assert.match(text, /Severity unknown/);
  }
});

test('embedded Timeline announces view-specific changes through the shell with a local fallback', () => {
  const messages = [];
  const region = { textContent: '' };
  const document = { getElementById(id) { assert.equal(id, 'announcement'); return region; } };
  const embedded = model(document, { parent: { zm: { announce: text => messages.push(text) } } });
  embedded.announceTimeline('Timeline history unavailable.');
  assert.deepEqual(messages, ['Timeline history unavailable.']);
  assert.equal(region.textContent, '');

  const disconnected = model(document, { parent: { get zm() { throw Error('Inaccessible shell'); } } });
  disconnected.announceTimeline('Timeline history available.');
  assert.equal(region.textContent, 'Timeline history available.');
});

test('the pause toggle keeps its accessible name while changing its pressed state', () => {
  const attrs = new Map();
  const button = { textContent: 'Pause live updates', setAttribute: (name, value) => attrs.set(name, value) };
  const { syncPaused } = model({ getElementById(id) { assert.equal(id, 'pause-updates'); return button; } });
  syncPaused(true);
  assert.equal(attrs.get('aria-pressed'), 'true');
  assert.equal(button.textContent, 'Pause live updates');
  syncPaused(false);
  assert.equal(attrs.get('aria-pressed'), 'false');
  assert.equal(button.textContent, 'Pause live updates');
});

function statusDocument() {
  const nodes = new Map();
  return {
    getElementById(id) {
      if (!nodes.has(id)) {
        const attributes = new Map();
        nodes.set(id, { attributes, textContent: '', setAttribute(name, value) { attributes.set(name, value); } });
      }
      return nodes.get(id);
    },
  };
}

test('the connection timestamp shows the UTC minute and retains its precise ISO value', () => {
  const document = statusDocument();
  const precise = '2026-11-23T14:00:12.345Z';
  model(document).connection({ now: precise });
  const snapshot = document.getElementById('snapshot');
  assert.equal(snapshot.textContent, '14:00 UTC');
  assert.equal(snapshot.attributes.get('datetime'), precise);
});

test('explicit event pagination announces the new range without moving the pager focus', () => {
  const page = script.slice(script.indexOf('function changeEventPage('), script.indexOf('function applyHL('));
  const announcements = [], scroller = { scrollTop: 350 };
  runInNewContext(page + '\nchangeEventPage(1)', {
    eventPage: 0,
    renderEvents() {},
    byId: id => id === 'event-scroll' ? scroller : { textContent: '51–59 of 59' },
    announceTimeline: text => announcements.push(text),
  });
  assert.deepEqual(announcements, ['Showing events 51–59 of 59']);
  assert.equal(scroller.scrollTop, 0);
});

test('rolling status ages and countdown durations do not rebuild a still plot across polls', () => {
  const redraws = [];
  const { receive } = model(statusDocument(), {}, time => redraws.push(time));
  const board = {
    now: iso(0),
    sessions: [{ slug: 'atlas', updated: iso(-10), hb: { lastPostAt: iso(-6), statusAgeMin: 10, lastPostAgeMin: 6, nextInMin: 4 } }],
    timeline: [{ slug: 'atlas', source: 'risky', text: 'Review release', atUtc: iso(4), inMin: 4, overdue: false }],
    activity: { sessions: { atlas: { nowDoing: 'Reviewing', edits1h: 2, bins: [1, 2] } } },
  };
  receive(board);
  const later = {
    ...board, now: '2026-11-23T14:00:15Z',
    sessions: [{ ...board.sessions[0], hb: { ...board.sessions[0].hb, statusAgeMin: 11, lastPostAgeMin: 7, nextInMin: 3 } }],
    timeline: [{ ...board.timeline[0], inMin: 3 }],
    activity: { sessions: { atlas: { ...board.activity.sessions.atlas, bins: [2, 1] } } },
  };
  receive(later);
  assert.equal(redraws.length, 1);
  receive({ ...later, sessions: [{ ...later.sessions[0], title: 'Updated headline' }] });
  assert.equal(redraws.length, 2);
});
