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

const forced = css.slice(css.indexOf('@media (forced-colors: active)'));

test('forced-colors map and sparkline backgrounds follow the system canvas', () => {
  assert.match(forced, /#svg,\s*\.spark svg\s*\{[^}]*background(?:-color)?:\s*Canvas/);
});

test('forced-colors mode toggles paint readable selected text and backplates', () => {
  assert.match(forced, /\.graph-mode\[aria-pressed="true"\]\s*\{[^}]*forced-color-adjust:\s*none[^}]*background(?:-color)?:\s*Highlight\b[^}]*color:\s*HighlightText/);
});

function attentionRenderers() {
  const script = view.slice(view.indexOf('  function attentionEntries'), view.indexOf('  function timelineCards'));
  assert.ok(script.startsWith('  function attentionEntries'), 'attention identities should be shared by both renderers');
  function element(tag, className, text) {
    return {
      tag, className, text, dataset: {}, children: [],
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
    };
  }
  return vm.runInNewContext(script + '\n({ attentionEntries, attentionCards })', {
    arr: value => Array.isArray(value) ? value : [], obj: value => value || {},
    str: value => String(value ?? ''), h: element, tagSess: slug => element('button', '', slug),
    statusChip: (role, text) => element('span', role, text),
  });
}

test('inspector attention cards keep their entity keys when equal-severity rows reorder', () => {
  const { attentionCards } = attentionRenderers();
  const atlas = {sev: 'amber', kind: 'coordinate', slug: 'atlas', ref: 'one', text: 'Original atlas alert'};
  const beacon = {sev: 'amber', kind: 'coordinate', slug: 'beacon', ref: 'two', text: 'Original beacon alert'};
  const before = attentionCards({attention: [atlas, beacon]}).children.map(row => row.dataset.key);
  const after = attentionCards({attention: [beacon, atlas]}).children.map(row => row.dataset.key);
  assert.ok(before.every(Boolean));
  assert.notEqual(before[0], before[1]);
  assert.equal(after[0], before[1]);
  assert.equal(after[1], before[0]);
});

test('an alert description edit keeps identity while a removed alert disappears', () => {
  const { attentionEntries } = attentionRenderers();
  const item = {kind: 'coordinate', slug: 'beacon', ref: 'overlap', text: 'Original description'};
  const [original] = attentionEntries({attention: [item]});
  const [updated] = attentionEntries({attention: [{...item, text: 'Revised description'}]});
  assert.equal(original.key, updated.key);
  assert.equal(updated.item.text, 'Revised description');
  assert.equal(attentionEntries({attention: []}).length, 0);
  assert.match(view, /for \(const \{ key, item \} of attentionEntries\(board\)\)/);
});

test('fitted PRs retain independent CI symbols with a legend and text label', () => {
  const renderer = view.slice(view.indexOf('  function createNode'), view.indexOf('  function styleEdge'));
  assert.match(renderer, /makeCiMark\(\)/);
  assert.match(view, /class.*node-ci|\.node-ci/);
  assert.doesNotMatch(css, /dense[^{}]*\.node-ci/);
  assert.match(view, /Pull request checks/);
  for (const label of ['CI passed', 'CI failed', 'CI running', 'No CI results']) assert.ok(view.includes(label));
});

test('Graph matches the ATC hash and collision order with the shared identity slots', () => {
  const atc = readFileSync(new URL('../../dashboard/views/atc.html', import.meta.url), 'utf8');
  const limit = atc.match(/var SESSION_SECTOR_LIMIT = \d+;/)[0];
  const atcHelpers = atc.slice(atc.indexOf('var SESSION_PALETTE'), atc.indexOf("if (typeof globalThis"));
  const reference = vm.runInNewContext(limit + '\n' + atcHelpers + '\n({ shapeSectors, SESSION_PALETTE })');
  const script = view.slice(view.indexOf('  function sessionColorIndex'), view.indexOf('  var skew'));
  assert.ok(script.startsWith('  function sessionColorIndex'));
  const { identityIndices, slugColor } = vm.runInNewContext(script + '\n({ identityIndices, slugColor })',
    { str: value => String(value ?? '') });
  const candidates = Array.from({length: 24}, (_, i) => ({slug: 'peer-' + i}));
  const atlasIndex = reference.SESSION_PALETTE.indexOf(reference.shapeSectors({sessions: [{slug: 'atlas'}]})[0].color);
  const collision = candidates.find(candidate =>
    reference.SESSION_PALETTE.indexOf(reference.shapeSectors({sessions: [candidate]})[0].color) === atlasIndex);
  assert.ok(collision);
  const sessions = [...candidates.slice(0, 3), {slug: 'atlas'}, collision].filter(
    (session, index, all) => all.findIndex(candidate => candidate.slug === session.slug) === index,
  );
  const colors = identityIndices(sessions);
  for (const sector of reference.shapeSectors({sessions})) {
    const index = reference.SESSION_PALETTE.indexOf(sector.color);
    assert.equal(colors.get(sector.slug), index);
    assert.equal(slugColor(sector.slug, colors), 'var(--identity-' + (index + 1) + ')');
  }
  assert.notEqual(colors.get('atlas'), colors.get(collision.slug));
});

test('queue PR links use full-size native link targets', () => {
  const queueLink = view.slice(view.indexOf('  function mqLink'), view.indexOf('  function mergeQueueSection'));
  assert.match(queueLink, /h\('a', 'btn queue-link'/);
  assert.match(shared, /\.btn\s*\{[^}]*min-block-size:\s*var\(--control-size\)/);
});

test('inspector and overview semantics use the shared chip primitive', () => {
  assert.doesNotMatch(css, /\.tag(?=[\s.:{])/);
  assert.doesNotMatch(view, /h\('span', 'tag/);
  const attention = view.slice(view.indexOf('  function attentionCards'), view.indexOf('  function timelineCards'));
  assert.match(attention, /statusChip\(/);
});
