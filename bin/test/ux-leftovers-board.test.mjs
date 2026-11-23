import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const file = name => readFileSync(new URL('../../dashboard/' + name, import.meta.url), 'utf8');
const shell = file('index.html');
const graph = file('views/graph.html');
const workspace = file('views/workspace.html');

test('shell print has an in-flow summary for the last accepted board', () => {
  assert.match(shell, /<button[^>]+id="printBtn"[^>]*>Print board<\/button>/);
  assert.match(shell, /<section[^>]+id="printBoard"/);
  assert.match(shell, /@media print\s*\{[\s\S]*?\.stage[^\n]*display:\s*none/);
  const [, script] = shell.match(/<script>([\s\S]*?)<\/script>/);
  const start = script.indexOf('  function printBoardSections(');
  const end = script.indexOf('  function renderPrintBoard(', start);
  assert.ok(start >= 0 && end > start);
  const sections = runInNewContext(script.slice(start, end) + '\nprintBoardSections(board)', {
    board: {
      sessions: Array.from({ length: 90 }, (_, i) => ({ slug: 'session-' + i, state: 'active' })),
      log: Array.from({ length: 90 }, (_, i) => ({ slug: 'session-' + i, body: 'event-' + i })),
      timeline: [{ slug: 'session-89', text: 'Last deadline' }],
    },
  });
  assert.ok(JSON.stringify(sections).includes('session-89'));
  assert.ok(JSON.stringify(sections).includes('event-89'));
  assert.ok(JSON.stringify(sections).includes('Last deadline'));
});

test('large Graph inspector queue and PR collections use the existing 50-row budget', () => {
  for (const section of ['open-prs', 'queue', 'landed']) {
    assert.match(graph, new RegExp("inspectorPage\\([^\\n]+, '" + section + "',"));
  }
  assert.match(graph, /Showing .* of /);
  const start = graph.indexOf('  function pageItems(');
  const end = graph.indexOf('\n  function ', graph.indexOf('  function inspectorPage(') + 1);
  assert.ok(start >= 0 && end > start);
  const notices = [];
  const element = (tag, classes, text) => ({
    tag, text, dataset: {}, children: [], attrs: {},
    append(child) { this.children.push(child); },
    setAttribute(name, value) { this.attrs[name] = value; },
  });
  const { inspectorPage, inspectorPages } = runInNewContext(
    graph.slice(start, end) + '\n({ inspectorPage, inspectorPages })', {
      PAGE_SIZE: 50, h: element, renderInspector() {}, announce: text => notices.push(text),
    });
  const records = Array.from({ length: 1600 }, (_, i) => 'pr-' + i);
  const first = element('div');
  assert.equal(inspectorPage(first, 'queue', 'queued pull requests', records).length, 50);
  first.children[0].children[1].onclick();
  assert.equal(inspectorPages.get('queue'), 1);
  assert.equal(notices.at(-1), 'Showing 51–100 of 1600 queued pull requests');
  inspectorPages.set('queue', 31);
  const last = element('div');
  assert.equal(inspectorPage(last, 'queue', 'queued pull requests', records).at(-1), 'pr-1599');
  assert.equal(last.children[0].children[1].attrs['aria-disabled'], 'true');
});

test('Workspace pages retain access to the final record and clamp when results shrink', () => {
  const start = workspace.indexOf('function pageRecords(');
  const end = workspace.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const pageRecords = runInNewContext(workspace.slice(start, end) + '\npageRecords', { BOARD_PAGE_SIZE: 50 });
  const records = Array.from({ length: 2400 }, (_, i) => 'record-' + i);
  const first = pageRecords(records, 0);
  const last = pageRecords(records, 99);
  assert.equal(first.items.length, 50);
  assert.equal(last.items.at(-1), 'record-2399');
  assert.equal(last.start, 2350);
  assert.equal(last.total, 2400);
  assert.equal(pageRecords(records.slice(0, 12), last.page).page, 0);
  assert.equal(pageRecords([], 99).items.length, 0);
});

test('forced-colors chart marks and active navigation retain system-color cues', () => {
  assert.match(shell, /@media \(forced-colors: active\)[\s\S]+\.tab\[aria-selected="true"\][\s\S]+HighlightText/);
  assert.match(graph, /\.e, #main \.node \.body, \.node \.fold \{ stroke: CanvasText/);
  assert.match(graph, /\.e\.hl, #main \.node\.sel \.body \{ stroke: Highlight/);
  assert.match(file('views/timeline.html'), /\.plot \.selected-mark\{fill:Highlight;stroke:Canvas\}/);
  assert.match(workspace, /\.ni\[aria-current="page"\] \{ border-inline-start-color: Highlight/);
  assert.match(file('views/atc.html'), /@media \(forced-colors: active\)[\s\S]+CanvasText/);
});

test('the composer consumes solid boundary and focus tokens in light and forced colors', () => {
  const css = file('dashboard.css');
  const token = name => css.match(new RegExp('--' + name + ':\\s*#([a-f0-9]{6})', 'i'))[1];
  const lightness = color => color.match(/../g).map(byte => {
    const channel = parseInt(byte, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const ink of ['control-border', 'accent']) {
    const [a, b] = [lightness(token(ink)), lightness(token('surface'))].sort((x, y) => y - x);
    assert.ok((a + 0.05) / (b + 0.05) >= 3, ink + ' against the composer surface');
  }
  assert.match(shell, /<textarea[^>]+class="field"/);
  assert.match(shell, /<select[^>]+class="field"/);
  assert.match(css, /\.field\s*\{[^}]*border:\s*1px solid var\(--control-border\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]+outline-color:\s*Highlight/);
});

test('both shell pause actions use the same preference observed by all four views', () => {
  assert.match(shell, /<button[^>]+id="pauseBtn"[^>]*>Pause live updates<\/button>/);
  assert.match(shell, /paused \? 'Resume live updates' : 'Pause live updates'/);
  assert.match(shell, /const pauseKey = 'zm\.paused'/);
  assert.match(shell, /savePreference\(pauseKey, paused \? '0' : '1'\)/);
  for (const name of ['graph', 'timeline', 'workspace', 'atc']) {
    const view = file('views/' + name + '.html');
    assert.match(view, /'zm\.paused'/);
    assert.match(view, /addEventListener\('storage'/);
  }
});
