import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const view = readFileSync(new URL('../../dashboard/views/graph.html', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../dashboard/dashboard.css', import.meta.url), 'utf8');
const css = view.match(/<style>([\s\S]*?)<\/style>/)[1];
const markup = view.slice(view.indexOf('<body>'), view.indexOf('<script>'));

test('Graph uses the shared document contract and stylesheet', () => {
  assert.match(view, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.match(markup, /^<body>\s*<a class="skip-link" href="#main">/);
  assert.match(markup, /<main id="main"[^>]*>[\s\S]*<h1 id="view-title" tabindex="-1">Agent network<\/h1>/);
  assert.equal([...markup.matchAll(/<h1\b/g)].length, 1);
  assert.match(markup, /<aside[^>]*aria-labelledby="inspectorTitle"/);
  assert.match(markup, /<h2 id="inspectorTitle" tabindex="-1"/);
});

test('Graph uses token colors, shared focus and static high-contrast edges', () => {
  assert.doesNotMatch(view, /(?:[:=,]\s*|['"])#[\da-f]{3,8}\b|\brgba?\(/i);
  assert.doesNotMatch(css, /outline\s*:\s*(?:0|none)|all\s*:\s*unset|animation[^;}]*infinite|html[^{}]*\{[^}]*font-size/i);
  const tokens = new Set([...shared.matchAll(/(--[\w-]+)\s*:/g)].map(([, token]) => token));
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(tokens.has(token) || ['--c', '--map-scale'].includes(token), 'Unknown shared token ' + token);
  }
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /\.e\s*\{[^}]*stroke:\s*var\(--control-border\)/);
  assert.doesNotMatch(css, /stroke-opacity:\s*\./);
  assert.match(view, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});

test('Graph exposes both modes, named map controls, and a labeled linear browse view', () => {
  for (const label of ['Map', 'List', 'Zoom out', 'Zoom in', 'Pan left', 'Pan right', 'Pan up', 'Pan down', 'Retry now']) {
    assert.match(markup, new RegExp('<button[^>]*>' + label + '<\\/button>'));
  }
  assert.match(markup, /<button[^>]*aria-pressed="(?:true|false)"[^>]*>Map<\/button>/);
  assert.match(markup, /<button[^>]*aria-pressed="(?:true|false)"[^>]*>List<\/button>/);
  assert.match(markup, /<label for="networkSearch"[^>]*>Find a node<\/label>/);
  assert.match(markup, /<label for="networkType"[^>]*>Node type<\/label>/);
  assert.ok(markup.indexOf('Browse graph') < markup.indexOf('<svg'));
  assert.match(markup, /<svg[^>]*role="img"[^>]*aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"/);
  assert.match(markup, /aria-expanded="false" aria-controls="chips"/);
  assert.match(markup, /id="graphAnnouncements"[^>]*role="status"/);
});

function graphModel() {
  const script = view.slice(view.indexOf('  var SVGNS'), view.indexOf('  const NODE_TYPES'));
  const helpers = view.slice(view.indexOf('  const PAGE_SIZE'), view.indexOf('  let nodePage'));
  assert.ok(helpers.includes('function mapModel'), 'map and list have separate size limits');
  return vm.runInNewContext(script + helpers + '\n({ buildModel, mapModel, pageItems, safeUrl })', { URL });
}

test('the full model remains browsable when the map and pages are capped', () => {
  const { buildModel, mapModel, pageItems } = graphModel();
  const sessions = Array.from({ length: 1000 }, (_, i) => ({ slug: 'agent-' + i }));
  const model = buildModel({
    sessions,
    worktrees: { items: [{ name: 'last-tree', owner: 'agent-999', branch: 'main' }] },
  });
  assert.equal(model.nodes.size, 1002);
  const map = mapModel(model, 's:agent-999');
  assert.ok(map.nodes.size < 100);
  assert.ok(map.nodes.has('s:agent-999'));
  for (const edge of map.edges.values()) {
    assert.ok(map.nodes.has(edge.a) && map.nodes.has(edge.b));
  }
  const all = Array.from(model.nodes.values());
  assert.equal(pageItems(all, 0).length, 50);
  assert.equal(pageItems(all, 20).length, 2);
  assert.ok(Array.from(model.edges.values()).some(edge => edge.a === 's:agent-999' && edge.b === 'w:last-tree'));
});

test('pointer cancellation, queue structure and activity equivalents have distinct paths', () => {
  assert.match(view, /pointerup[^\n]*endDrag\(\w+, true\)/);
  assert.match(view, /pointercancel[^\n]*endDrag\(\w+, false\)/);
  const queue = view.slice(view.indexOf('  function mergeQueueSection'), view.indexOf('  function renderOverview'));
  assert.match(queue, /h\('ol'/);
  assert.match(queue, /h\('details'/);
  assert.match(queue, /h\('summary'/);
  assert.match(view, /Activity counts by interval/);
  assert.match(view, /function renderNetworkList/);
});

test('directed relationships keep their endpoints and explanation', () => {
  const { buildModel } = graphModel();
  const model = buildModel({
    sessions: [{ slug: 'atlas' }, { slug: 'beacon' }],
    worktrees: { items: [
      { name: 'work-atlas', owner: 'atlas', branch: 'topic/atlas' },
      { name: 'work-beacon', owner: 'beacon', branch: 'topic/beacon' },
    ] },
    conflicts: { pairs: [{
      kind: 'cross-session', clean: false, files: ['dashboard/views/graph.html'],
      a: { owner: 'atlas', worktree: 'work-atlas' },
      b: { owner: 'beacon', worktree: 'work-beacon' },
    }] },
  });
  const conflict = Array.from(model.edges.values()).find(edge => edge.kind === 'conflict');
  assert.equal(conflict?.a, 'w:work-atlas');
  assert.equal(conflict.b, 'w:work-beacon');
  assert.match(conflict.note, /graph\.html/);
});

test('queue and inspector PR links require an HTTPS GitHub origin', () => {
  const { safeUrl } = graphModel();
  const pull = 'https://github.com/example/repo/pull/12';
  assert.equal(safeUrl(pull), pull);
  for (const url of ['https://github.com.example/repo', 'javascript:alert(1)', 'https://example@github.com/example/repo']) {
    assert.equal(safeUrl(url), '');
  }
});
