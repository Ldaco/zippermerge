import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/timeline.html', import.meta.url), 'utf8');
const [, script] = html.match(/<script>([\s\S]*?)<\/script>/);
const now = Date.parse('2026-11-23T14:00:00Z');
const hour = 3_600_000;

function model(exports, globals = {}, setup = '') {
  return runInNewContext(script.slice(0, script.indexOf('\nlegendRow();')) + '\n' + setup + '\n(' + exports + ')', {
    document: {}, window: {}, URLSearchParams, ...globals,
  });
}

test('Timeline exposes labeled filters and a clear action', () => {
  for (const id of ['filter-session', 'filter-type', 'filter-range']) {
    assert.match(html, new RegExp('<label[^>]+for="' + id + '"'));
    assert.match(html, new RegExp('<select[^>]+id="' + id + '"'));
  }
  assert.match(html, /<button[^>]+id="clear-timeline-filters"[^>]*>Clear filters<\/button>/);
  assert.match(html, /No events match these filters/);
});

function surface() {
  const regions = new Map();
  const document = {};
  class Element {
    nodeType = 1;
    children = [];
    attributes = new Map();
    isConnected = true;
    clientWidth = 1440;
    hiddenValue = false;
    text = '';

    constructor(tag) { this.tag = tag; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = value; }
    get hidden() { return this.hiddenValue; }
    set hidden(value) {
      this.hiddenValue = value;
      if (value && this.contains(document.activeElement)) document.activeElement = byId('body');
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener() {}
    contains(node) { return this === node || this.children.some(child => child.contains?.(node)); }
    closest(selector) {
      assert.equal(selector, '[hidden]');
      return this.hidden ? this : this.parent?.closest(selector) ?? null;
    }
    appendChild(node) { node.parent = this; this.children.push(node); }
    replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    focus() { document.activeElement = this; }
  }
  function byId(id) {
    if (!regions.has(id)) regions.set(id, new Element(id));
    return regions.get(id);
  }
  Object.assign(document, {
    getElementById: byId,
    createElement: tag => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: textContent => ({ nodeType: 3, textContent }),
    activeElement: byId('body'),
  });
  byId('event-scroll').appendChild(byId('event-rows'));
  const app = model(`{
    filters(value) { timelineFilters = value; },
    show(board) { data = board; refreshEvents(Date.now()); },
    renderTimeline,
    details(board, page = 0) {
      data = board;
      detailPages.set('countdowns', page);
      renderDetail();
    },
  }`, { document, Date: class extends Date { static now() { return now; } } }, `
    patchChildren = (parent, next) => parent.replaceChildren(...next.children);
    plotLabel = () => {};
    applyHL = () => {};
    renderInspector = () => {};
  `);
  return { ...app, byId, document };
}

function descendants(node) {
  return [...(node.children ?? [])].flatMap(child => [child, ...descendants(child)]);
}
const iso = minutes => new Date(now + minutes * 60_000).toISOString();
const atlas = { slug: 'atlas', state: 'active' };

test('overlapping idle and subagent intervals produce clipped bands and counted chart markers', () => {
  const view = surface();
  const board = {
    sessions: [atlas],
    activity: {
      sessions: { atlas: { subagentsRunning: 1 } },
      events: [
        { slug: 'atlas', event: 'subagent-start', ts: iso(-100) },
        { slug: 'atlas', event: 'stop', ts: iso(-90) },
        { slug: 'atlas', event: 'prompt', ts: iso(-10) },
      ],
    },
  };
  for (const [type, pattern, fraction] of [
    ['Idle', 'hatch-idle', 5 / 6],
    ['Subagents running', 'hatch-activity', 1],
  ]) {
    view.filters({ session: 'atlas', range: 'hour', type });
    view.show(board);
    view.renderTimeline(now);
    const [row] = view.byId('event-rows').children;
    assert.equal(view.byId('event-rows').children.length, 1, type);
    const svg = descendants(view.byId('tlwrap')).filter(node => node.nodeType === 1);
    const markers = svg.filter(node => node.getAttribute('class') === 'marker');
    assert.deepEqual(markers.flatMap(node => JSON.parse(node.getAttribute('data-events'))), [row.getAttribute('data-row')], type);
    assert.match(view.byId('chart-count').textContent, /Showing 1 of 1 chart events/, type);
    const band = svg.find(node => node.getAttribute('fill') === 'url(#' + pattern + ')');
    assert.ok(band, type);
    const axis = svg.find(node => node.tag === 'line' && node.getAttribute('class') === 'axis' &&
      Number(node.getAttribute('x1')) > 0 && Number(node.getAttribute('x2')) > Number(node.getAttribute('x1')));
    assert.equal(band.getAttribute('x'), axis.getAttribute('x1'), type);
    const span = Number(axis.getAttribute('x2')) - Number(axis.getAttribute('x1'));
    assert.ok(Math.abs(Number(band.getAttribute('width')) - span * fraction) < 1, type);
  }
});

test('countdown details build only the requested 50 records and expose the full result count', () => {
  const view = surface();
  const board = { timeline: Array.from({ length: 5000 }, (_, index) => ({
    slug: 'session-' + index % 1000, source: 'risky', atUtc: iso(index % 45), text: 'Countdown ' + index,
  })) };
  const readRows = () => descendants(view.byId('panels')).filter(node =>
    node.nodeType === 1 && node.getAttribute('class') === 'row' && node.textContent.includes('Countdown '));
  view.details(board);
  assert.equal(readRows().length, 50);
  assert.match(view.byId('panels').textContent, /Showing 1–50 of 5000 countdowns/);
  assert.match(readRows()[0].textContent, /Countdown 0\b/);
  assert.match(readRows().at(-1).textContent, /Countdown 49\b/);
  view.details(board, 99);
  assert.equal(readRows().length, 50);
  assert.match(view.byId('panels').textContent, /Showing 4951–5000 of 5000 countdowns/);
  assert.match(readRows().at(-1).textContent, /Countdown 4999\b/);
});

test('polling to zero matches restores focus from the hidden table and announces the result', () => {
  const view = surface();
  view.filters({ session: 'atlas', type: 'Note', range: 'hour' });
  const board = { sessions: [atlas], log: [{ slug: 'atlas', kind: 'note', timestamp: iso(-5), name: 'one.md' }] };
  view.show(board);
  const scroller = view.byId('event-scroll');
  scroller.focus();
  view.show(board);
  assert.equal(view.document.activeElement, scroller, 'focus stays on the populated table');
  view.show({ ...board, log: [] });
  assert.equal(scroller.hidden, true);
  assert.equal(view.document.activeElement, view.byId('events-title'), 'focus falls back to Events');
  assert.equal(view.byId('announcement').textContent, '0 matching events');
  assert.equal(view.byId('no-events').textContent, 'No events match these filters.');
});

test('one Timeline predicate includes both participants and recognizes window overlap', () => {
  const filterTimelineEvents = model('filterTimelineEvents');
  const ask = { key: 'ask', lane: 'cedar', session: 'cedar → indigo', to: 'indigo', type: 'Ask', time: now };
  const oldAsk = { ...ask, key: 'old', time: now - 2 * hour };
  const lock = { key: 'held', lane: 'indigo', session: 'indigo', type: 'Lock', time: now - 2 * hour, until: now };
  const repo = { key: 'pr', lane: 'repo', session: 'indigo', type: 'Merged PR', time: now };
  const unscheduled = { key: 'unscheduled', lane: 'indigo', session: 'indigo', type: 'Risky action', time: null };
  const data = [ask, oldAsk, lock, repo, unscheduled];
  const range = { start: now - hour, end: now, includeUntimed: false };
  const keys = (type, bounds = range) => Array.from(filterTimelineEvents(data, { session: 'indigo', type }, bounds), entry => entry.key);
  assert.deepEqual(keys('Ask'), ['ask']);
  assert.deepEqual(keys(''), ['ask', 'held', 'pr']);
  assert.deepEqual(keys('Risky action', { ...range, includeUntimed: true }), ['unscheduled']);
});

test('range URL parameters round-trip independently of other shell state', () => {
  const { readTimelineFilters, writeTimelineFilters } = model('{ readTimelineFilters, writeTimelineFilters }');
  const params = new URLSearchParams('other=kept&tl-range=invalid&tl-session=cedar');
  assert.equal(readTimelineFilters(params).range, 'window');
  writeTimelineFilters(params, { range: 'available', session: 'indigo', type: 'Merged PR' });
  assert.deepEqual({ ...readTimelineFilters(params) }, { range: 'available', session: 'indigo', type: 'Merged PR' });
  writeTimelineFilters(params, { range: 'window', session: '', type: '' });
  assert.equal(params.toString(), 'other=kept');
});

test('the chart caps lane and event work while the event model retains the complete result', () => {
  const { timelineChartData, filterTimelineEvents } = model('{ timelineChartData, filterTimelineEvents }');
  const complete = Array.from({ length: 20_000 }, (_, index) => ({
    key: String(index), type: 'Note', category: 'post', session: 'session-' + index % 500,
    lane: 'session-' + index % 500, time: now,
  }));
  const bounds = { start: now - hour, end: now, includeUntimed: true };
  const matches = filterTimelineEvents(complete, { session: '', type: '' }, bounds);
  const chart = timelineChartData(matches, bounds, '19999');
  assert.equal(matches.length, 20_000);
  assert.equal(chart.totalEvents, 20_000);
  assert.equal(chart.totalLanes, 500);
  assert.ok(chart.lanes.length <= 30);
  assert.ok(chart.events.length <= 500);
  assert.ok(chart.events.some(entry => entry.key === '19999'), 'the selected table event can be located on the chart');
});
