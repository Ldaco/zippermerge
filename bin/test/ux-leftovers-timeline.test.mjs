import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/timeline.html', import.meta.url), 'utf8');
const [, script] = html.match(/<script>([\s\S]*?)<\/script>/);
const now = Date.parse('2026-11-23T14:00:00Z');
const hour = 3_600_000;

function model(exports) {
  return runInNewContext(script.slice(0, script.indexOf('\nlegendRow();')) + '\n(' + exports + ')', {
    document: {}, window: {}, URLSearchParams,
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
