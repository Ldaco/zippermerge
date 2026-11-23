import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const atc = read('dashboard/views/atc.html');
const css = read('dashboard/dashboard.css');
const context = {};
runInNewContext(atc.match(/<script>([\s\S]*?)<\/script>/)[1], context);
const ATC = context.ATC;

test('ATC uses the shared stylesheet, landmarks, heading and bypass link', () => {
  assert.match(atc, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.match(atc, /<body>\s*<a class="skip-link" href="#main">Skip to main content<\/a>\s*<main id="main" tabindex="-1">/);
  assert.equal((atc.match(/<h1\b/g) || []).length, 1);
  assert.match(atc, /<h1 id="view-title" tabindex="-1">Air Traffic Control<\/h1>/);
  assert.match(atc, /role="status" aria-atomic="true"/);
  assert.match(atc, /role="alert" aria-atomic="true"/);
  assert.doesNotMatch(atc, /:root|(?:^|[\s'":])#[\da-f]{3,8}(?![\w-])|\brgba?\(|outline\s*:\s*(?:none|0)|overflow-x\s*:\s*hidden|@keyframes|animation\s*:/im);
  assert.match(atc, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(atc, /@media \(forced-colors: active\)/);
});

test('queue, history and traffic expose native navigation and data semantics', () => {
  assert.match(atc, /role="region" aria-label="Landing sequence table" tabindex="0"/);
  assert.match(atc, /<table class="tbl">\s*<caption[^>]*>Landing sequence<\/caption>/);
  assert.equal((atc.match(/<th scope="col">/g) || []).length, 5);
  assert.match(atc, /setAttribute\('scope', 'row'\)/);
  assert.match(atc, /el\(url \? 'a' : 'span'/);
  assert.match(atc, /\.href = url/);
  assert.doesNotMatch(atc, /window\.open/);
  assert.match(atc, /<ol id="landed"/);
  assert.match(atc, /id="traffic-title"[\s\S]*<ol id="approach"[\s\S]*id="holding"[\s\S]*<svg[^>]+role="img" aria-labelledby="radar-title" aria-describedby="radar-desc"/);
  assert.match(atc, /el\('details'/);
  assert.match(atc, /el\('summary'/);
});

test('1,000 queue entries remain discoverable in order in 50-row pages', () => {
  const queue = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, position: i + 1 })).reverse();
  const model = ATC.shapeQueue({ queue });
  const pages = Array.from({ length: 20 }, (_, i) => ATC.queuePage(model.queue, i));
  assert.ok(pages.every(page => page.rows.length === 50 && page.pages === 20));
  assert.deepEqual(pages.flatMap(page => Array.from(page.rows, q => q.number)), Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.equal(ATC.queuePage(model.queue, 20).page, 19);
  assert.equal(ATC.queuePage([], 20).rows.length, 0);
});

test('traffic includes unplotted holding entries, owners, session data and dependent PRs', () => {
  const queue = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, status: i < 10 ? 'ready' : 'held', owner: i === 10 ? 'off-radar' : null }));
  queue[0].riders = [20, 21];
  const board = {
    sessions: ['atlas', 'cedar', 'beacon', 'ember', 'elm', 'gale', 'off-radar'].map(slug => ({ slug })),
    activity: { sessions: { atlas: { nowDoing: 'A full activity description', subagentsRunning: 2 } } },
    locks: [{ owner: 'atlas', lock: 'main-freeze' }],
    mergeQueue: { queue, riding: [{ number: 20, title: 'Follow-up', with: 1 }] },
  };
  const model = ATC.shapeQueue(board.mergeQueue);
  const groups = ATC.shapeSectors(board, new Map(), model.holding);
  assert.equal(model.approach.length, 10);
  assert.deepEqual(Array.from(groups.find(group => group.slug === 'off-radar').holding, q => q.number), [11]);
  assert.deepEqual(Array.from(groups.find(group => !group.slug).holding, q => q.number), [12]);
  assert.equal(groups[0].nowDoing, 'A full activity description');
  assert.equal(groups[0].subagents, 2);
  assert.deepEqual(Array.from(groups[0].locks), ['main-freeze']);
  assert.deepEqual(Array.from(ATC.riderEntries(model.queue[0], model.ridersOf), r => [r.number, r.title]), [[20, 'Follow-up'], [21, '']]);
});

test('radar caps each holding group and keeps plotted marks outside the approach lane', () => {
  for (let count = 1; count <= 8; count++) {
    const sessions = Array.from('abcdefg'.slice(0, count), slug => ({ slug }));
    const owners = sessions.map(session => session.slug);
    if (count === 8) owners.push(null);
    const queue = owners.flatMap(owner => Array.from({ length: 6 }, () => ({ owner, status: 'held' })));
    queue.push(...Array.from({ length: 10 }, () => ({ status: 'ready' })));
    const model = ATC.shapeQueue({ queue: queue.map((entry, i) => ({ ...entry, number: i + 1 })) });
    const groups = ATC.shapeSectors({ sessions }, new Map(), model.holding);
    const { plot, plotted } = ATC.radarData(groups, model.approach, ATC.slugColor, 'Runway clear');
    assert.equal(plot.plotSectors.length, count);
    assert.equal(plotted.size, count * 5);
    assert.equal(plot.markers.length, count * 5 + 9);
    assert.equal(plot.approachOverflow, 1);
    for (const mark of plot.markers) {
      if (mark.status === 'held') assert.ok(Math.abs(mark.x - 320) > 22);
    }
    assert.ok(plot.plotSectors.every(sector => sector.more === 1));
  }
});

test('queue errors and missing history stay distinct from verified empty data', () => {
  const now = Date.parse('2026-11-23T14:32:00Z');
  assert.equal(ATC.shapeQueue({ error: 'unavailable', queue: [], merged: [] }), null);
  assert.equal(ATC.shapeQueue(null), null);
  assert.equal(ATC.shapeQueue({ queue: [] }).queue.length, 0);
  assert.equal(ATC.historyState(null, now), 'loading');
  assert.equal(ATC.historyState('2026-11-23T14:31:00Z', now), 'live');
  assert.equal(ATC.historyState('2026-11-23T14:20:00Z', now), 'stale');
  assert.equal(ATC.hhmm('2026-11-23T09:32:00-05:00'), '14:32 UTC');
  assert.equal(ATC.safeUrl('javascript:alert(1)'), null);
  assert.match(atc, /Merge queue unavailable\./);
  assert.match(atc, /Runway status unknown/);
  assert.deepEqual(Array.from(Object.values(ATC.statuses), value => value.label), ['Landing', 'Ready', 'CI running', 'Needs work', 'Stacked', 'On hold']);
});

function viewStatus(lastQueue = null, history = null) {
  const nodes = new Map();
  function byId(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: {}, writes: [], setAttribute() {} });
    return nodes.get(id);
  }
  const scope = {
    byId, lastQueue, history,
    standalone: true, paused: false, currentBoard: {}, boardState: 'live', queueState: 'live',
    boardAt: '2026-11-23T14:32:00Z', queueAt: '2026-11-23T14:32:00Z',
    transitions: new Map(), hhmm: ATC.hhmm,
    setText(node, text) {
      if (node.textContent === text) return;
      node.textContent = text;
      node.writes.push(text);
    },
  };
  const status = atc.match(/  function announce\([\s\S]*?(?=\n  function draw\()/)[0];
  runInNewContext(status, scope);
  return { byId, draw(queueState) { scope.queueState = queueState; scope.drawStatus(); } };
}

test('queue outages and recoveries announce once per transition, including a repeat outage', () => {
  const view = viewStatus();
  for (const state of ['error', 'error', 'live', 'live', 'error', 'error', 'live']) view.draw(state);
  const alert = view.byId('announce-alert');
  const status = view.byId('announce-status');
  assert.deepEqual(alert.writes, ['Merge queue unavailable.', '', 'Merge queue unavailable.', '']);
  assert.deepEqual(status.writes, ['Board live.', 'Merge queue available.', '', 'Merge queue available.']);
});

test('single-page queues expose queue, approach, holding, rider and verified merge totals', () => {
  const queue = Array.from({ length: 14 }, (_, index) => ({
    number: index + 1, status: ['landing', 'ready', 'ready'][index] || 'held',
    riders: index === 0 ? [21, 22] : [],
  }));
  const shape = ATC.shapeQueue({
    queue, riding: [{ number: 21, with: 1 }],
    merged: [{ number: 30 }, { number: 31 }], mergedFetchedAt: '2026-11-23T14:31:00Z',
  });
  assert.equal(ATC.queuePage(shape.queue, 0).pages, 1);
  const view = viewStatus(shape, shape);
  view.draw('live');
  const messages = {
    'queue-totals': '14 in queue · 1 landing · 2 ready · 2 riding',
    'traffic-totals': '3 on approach · 11 holding',
    'history-totals': '2 merged today',
  };
  for (const [id, expected] of Object.entries(messages)) {
    assert.equal(view.byId(id).hidden, false, id);
    assert.equal(view.byId(id).textContent, expected, id);
  }
  assert.match(atc, /id="queue-totals"[\s\S]*?id="queue-pager"/);
  const unavailable = viewStatus();
  unavailable.draw('error');
  for (const id of Object.keys(messages)) assert.equal(unavailable.byId(id).hidden, true, id);
});

function graphIdentity(source) {
  const helpers = source.match(/\/\* GRAPH-IDENTITY-BEGIN \*\/([\s\S]*?)\/\* GRAPH-IDENTITY-END \*\//)?.[1];
  assert.ok(helpers, 'Graph identity functions must be available');
  return runInNewContext(`${helpers}\n({ identityIndices, slugColor })`, { str: value => String(value ?? '') });
}

function resolveColor(value) {
  const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  assert.ok(token, `${value} must reference the shared palette`);
  const resolved = css.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
  assert.ok(resolved, `${token} must exist in dashboard.css`);
  return resolved.startsWith('var(') ? resolveColor(resolved) : resolved;
}

test('ATC and Graph compute the same D-13 slot and fill through collisions and polls', () => {
  const graph = graphIdentity(read('dashboard/views/graph.html'));
  const fixtures = [
    ['atlas', 'cedar', 'beacon', 'ember', 'an', 'c0', 'gale', 'elm'],
    ['beacon', 'cedar', 'ember', 'an', 'c0', 'gale', 'elm', 'atlas'],
  ];
  const expected = [
    ['#1F5FBF', '#2F6F3A', '#A8316F', '#B4531A', '#5E7410', '#8F4A26', '#1F5FBF', '#8F4A26'],
    ['#A8316F', '#2F6F3A', '#B4531A', '#5E7410', '#8F4A26', '#1F5FBF', '#8F4A26', '#1F5FBF'],
  ];
  let previousATC = new Map();
  let previousGraph = new Map();
  for (const [index, slugs] of fixtures.entries()) {
    const sessions = slugs.map(slug => ({ slug }));
    previousATC = ATC.identityIndices(sessions, previousATC);
    previousGraph = graph.identityIndices(sessions, previousGraph);
    const atcSlots = slugs.map(slug => ATC.slugColor(slug, previousATC));
    const graphSlots = slugs.map(slug => graph.slugColor(slug, previousGraph));
    assert.deepEqual(atcSlots, graphSlots);
    const atcColors = atcSlots.map(resolveColor);
    assert.deepEqual(atcColors, graphSlots.map(resolveColor));
    assert.deepEqual(atcColors, expected[index]);
    assert.equal(new Set(atcColors.slice(0, 6)).size, 6);
  }
  assert.equal(resolveColor(ATC.slugColor(null)), '#44515D');
  assert.equal(ATC.slugColor(null), graph.slugColor(null));
});
