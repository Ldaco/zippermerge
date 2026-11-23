import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

function source(file) {
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
}

function script(file) {
  return source(file).match(/<script>([\s\S]*?)<\/script>/)[1];
}

const atc = script('dashboard/views/atc.html');

test('ATC session colors are distinct and survive a change in session order', () => {
  const context = {};
  runInNewContext(atc, context);
  const sessions = ['a', 'b', 'an', 'c0', 'bravo', 'foxtrot'].map(slug => ({ slug }));
  const colors = Array.from(context.ATC.shapeSectors({ sessions }), s => s.color);
  assert.equal(new Set(colors).size, sessions.length);
  assert.deepEqual(
    Array.from(context.ATC.shapeSectors({ sessions: sessions.reverse() }), s => s.color),
    colors.reverse(),
  );
});

class DomText {
  nodeType = 3;
  nodeName = '#text';
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
  get nextSibling() { return nextSibling(this); }
  remove() { removeNode(this); }
}

function nextSibling(node) {
  const siblings = node.parent?.childNodes;
  return siblings?.[siblings.indexOf(node) + 1] ?? null;
}

function removeNode(node) {
  const siblings = node.parent?.childNodes;
  if (siblings) siblings.splice(siblings.indexOf(node), 1);
  node.parent = null;
}

const dataAttribute = key => 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

class Element {
  nodeType = 1;
  childNodes = [];
  attrs = {};
  style = {
    setProperty: (name, value) => this.setAttribute('style', name + ': ' + value),
    getPropertyValue: name => this.attrs.style?.startsWith(name + ': ') ? this.attrs.style.slice(name.length + 2) : '',
  };
  dataset = new Proxy({}, {
    get: (_, key) => this.attrs[dataAttribute(key)],
    set: (_, key, value) => {
      this.setAttribute(dataAttribute(key), value);
      return true;
    },
  });
  classList = { add: name => { this.className = [this.className, name].filter(Boolean).join(' '); } };

  constructor(tag) { this.nodeName = tag; }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return nextSibling(this); }
  get className() { return this.attrs.class || ''; }
  set className(name) { this.setAttribute('class', name); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text) { this.replaceChildren(String(text)); }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  get href() { return this.getAttribute('href'); }
  set href(url) { this.setAttribute('href', url); }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  remove() { removeNode(this); }
  closest() { return null; }
  addEventListener() {}
  insertBefore(node, sibling) {
    if (typeof node === 'string') node = new DomText(node);
    node.remove();
    const index = sibling === null ? this.childNodes.length : this.childNodes.indexOf(sibling);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node);
    node.parent = this;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  prepend(node) { this.insertBefore(node, this.firstChild); }
  replaceChildren(...nodes) {
    for (const node of [...this.childNodes]) node.remove();
    this.append(...nodes);
  }
  getBBox() {
    // Deterministic SVG glyph metrics. The browser checks use actual glyph bounds.
    const width = Array.from(this.textContent).length * 8;
    return { x: Number(this.attrs.x) - width / 2, y: Number(this.attrs.y) - 11, width, height: 14 };
  }
}

async function renderATC(board) {
  const elements = new Map();
  const window = { addEventListener() {} };
  window.parent = window;
  const body = new Element('body');
  let poll;
  runInNewContext(atc, {
    window, AbortController, AbortSignal, Node: { TEXT_NODE: 3 },
    document: {
      body, activeElement: body,
      createElement: tag => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element('div'));
        return elements.get(id);
      },
    },
    fetch: async () => ({ ok: true, json: async () => board }),
    setInterval(callback, delay) { if (delay === 7000) poll = callback; },
  });
  async function rendered() {
    await setImmediate();
    assert.match(elements.get('pollstat').textContent, /^Live · updated/);
    assert.ok(elements.get('board-state').hidden, elements.get('board-message').textContent);
  }
  await rendered();
  return {
    elements, plot: elements.get('radar-plot'),
    async refresh(nextBoard) {
      board = nextBoard;
      poll();
      await rendered();
    },
  };
}

const hasClass = (node, name) => node.className.split(' ').includes(name);
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const prUrl = number => 'https://github.com/example/repo/pull/' + number;
const withUrls = queue => queue.map(entry => ({ ...entry, url: prUrl(entry.number) }));
const markerFor = (plot, number) => descendants(plot).find(node => hasClass(node, 'radar-marker') && node.dataset.pr === String(number));
const labelFor = (plot, number) => descendants(plot).find(node => hasClass(node, 'radar-label') && node.dataset.pr === String(number));
const labelText = label => label.children.find(node => node.nodeName === 'text').textContent;

function translation(node) {
  const [, x, y] = node.attrs.transform?.match(/^translate\((-?[\d.]+) (-?[\d.]+)\)$/) || [];
  return [Number(x || 0), Number(y || 0)];
}

function markPath(marker) {
  return marker.children.find(node => hasClass(node, 'radar-mark'));
}

function markerCenter(marker) { return translation(markPath(marker)); }

function plateBounds(label) {
  const plate = label.children.find(node => hasClass(node, 'radar-plate'));
  const [x, y] = translation(label);
  return { x: x + Number(plate.attrs.x), y: y + Number(plate.attrs.y), width: Number(plate.attrs.width), height: Number(plate.attrs.height) };
}

function graphColors(sessions, previous) {
  const graph = script('dashboard/views/graph.html');
  const helpers = graph.match(/\/\* GRAPH-IDENTITY-BEGIN \*\/([\s\S]*?)\/\* GRAPH-IDENTITY-END \*\//)[1];
  const identity = runInNewContext(helpers + '\n({ identityIndices, slugColor })', { str: value => String(value ?? '') });
  const indices = identity.identityIndices(sessions, previous);
  return { indices, color: slug => identity.slugColor(slug, indices) };
}

function markerColor(plot, number) {
  return markPath(markerFor(plot, number)).style.getPropertyValue('--session-color');
}

test('ATC uses Graph D-13 identity colors for radar markers and sequence tags', async () => {
  const sessions = ['atlas', 'cedar', 'beacon', 'ember', 'an', 'c0', 'gale'].map(slug => ({ slug }));
  const queue = sessions.map(({ slug }, i) => ({ number: i + 1, owner: slug, status: 'held' }));
  const { elements, plot } = await renderATC({ sessions, mergeQueue: { queue } });
  const graph = graphColors(sessions);
  assert.notEqual(graph.color('an'), graph.color('c0'));
  const rows = elements.get('seq').children;
  assert.equal(rows.length, sessions.length);
  for (const [index, row] of rows.entries()) {
    const tag = descendants(row).find(node => hasClass(node, 'session-tag'));
    const expected = graph.color(sessions[index].slug);
    assert.equal(tag.style.getPropertyValue('--session-color'), expected);
    assert.equal(markerColor(plot, index + 1), expected);
  }
});

test('ATC keeps a visible session on its Graph D-13 color through membership changes', async () => {
  const queue = [{ number: 1, owner: 'c0', status: 'held' }, { number: 2, owner: 'an', status: 'held' }];
  const board = slugs => ({ sessions: slugs.map(slug => ({ slug })), mergeQueue: { queue } });
  const original = board(['an', 'c0']);
  const { plot, refresh } = await renderATC(original);
  let graph = graphColors(original.sessions);
  const initial = markerColor(plot, 1);
  assert.equal(initial, graph.color('c0'));
  for (const membership of [['c0'], ['an', 'c0']]) {
    const next = board(membership);
    await refresh(next);
    graph = graphColors(next.sessions, graph.indices);
    assert.equal(markerColor(plot, 1), initial);
    assert.equal(markerColor(plot, 1), graph.color('c0'));
  }
  assert.equal(markerColor(plot, 2), graph.color('an'));
  assert.notEqual(markerColor(plot, 2), initial);
});

test('ATC keeps both long session label plates inside the radar viewBox', async () => {
  const slugs = ['abcdefghijklmnopqrstuvwx', 'zyxwvutsrqponmlkjihgfedc'];
  const { plot } = await renderATC({ sessions: slugs.map(slug => ({ slug })) });
  const labels = descendants(plot).filter(node => hasClass(node, 'radar-label') && slugs.includes(labelText(node)));
  assert.deepEqual(labels.map(labelText), slugs);
  for (const label of labels) {
    const { x, y, width, height } = plateBounds(label);
    assert.ok(x >= 0 && x + width <= 640, labelText(label) + ' overflows horizontally');
    assert.ok(y >= 0 && y + height <= 610, labelText(label) + ' overflows vertically');
  }
});

test('ATC plots unowned and off-radar PRs in their own holding sectors', async () => {
  const sessions = Array.from('abcdefgh', slug => ({ slug }));
  const owners = ['a', 'g', null];
  const queue = owners.flatMap((owner, i) => Array.from({ length: 6 }, (_, j) => ({
    number: i * 10 + j + 1, owner, status: 'held',
  })));
  const { plot } = await renderATC({ sessions, mergeQueue: { queue } });
  const labeled = descendants(plot).filter(node => hasClass(node, 'radar-label')).map(labelText);
  assert.ok(labeled.includes('Other sessions · 2'));
  assert.ok(labeled.includes('Unowned'));
  assert.equal(labeled.filter(text => text === '+1 holding').length, owners.length);

  const sectors = plot.children.filter(node => hasClass(node, 'radar-sector'));
  assert.equal(sectors.length, 8);
  for (const [index, sector] of [sectors[0], sectors[6], sectors[7]].entries()) {
    const [, startX, startY, endX, endY] = sector.attrs.d.match(/L([\d.-]+) ([\d.-]+)A\d+ \d+ 0 [01] 1 ([\d.-]+) ([\d.-]+)Z/);
    const angle = (x, y) => Math.atan2(y - 294, x - 320) * 180 / Math.PI;
    const start = angle(startX, startY);
    const span = (angle(endX, endY) - start + 360) % 360;
    for (const offset of [1, 2, 3, 4, 5]) {
      const number = index * 10 + offset;
      const mark = markerFor(plot, number);
      assert.ok(mark, 'Expected plotted PR #' + number);
      const direction = angle(...markerCenter(mark));
      assert.ok((direction - start + 360) % 360 < span, 'Wrong holding sector for PR #' + number);
    }
    assert.equal(markerFor(plot, index * 10 + 6), undefined);
  }
});

function hitLink(node, x, y) {
  // Traverse links from the last painted sibling to the first.
  if (node.attrs['pointer-events'] === 'none') return null;
  for (const child of node.children.toReversed()) {
    const hit = hitLink(child, x, y);
    if (hit) return hit;
  }
  if (node.nodeName === 'a' && hasClass(node, 'radar-marker')) {
    const circle = node.children.find(child => hasClass(child, 'radar-hit'));
    return Math.hypot(x - Number(circle.attrs.cx), y - Number(circle.attrs.cy)) <= Number(circle.attrs.r) ? node.href : null;
  }
  if (node.nodeName === 'a' && hasClass(node, 'radar-label')) {
    const box = plateBounds(node);
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height ? node.href : null;
  }
  return null;
}

test('ATC holding markers stay outside the approach lane and preserve ready PR hit targets', async () => {
  const sessions = Array.from('abcde', slug => ({ slug }));
  const queue = withUrls([
    { number: 1, status: 'ready' },
    { number: 2, status: 'ready' },
    { number: 3, status: 'held', owner: 'b' },
    { number: 4, status: 'held' },
  ]);
  const { plot } = await renderATC({ sessions, mergeQueue: { queue } });
  for (const number of [1, 2]) {
    const marker = markerFor(plot, number);
    const [x, y] = markerCenter(marker);
    assert.equal(x, 320);
    assert.ok(Number(marker.children.find(child => hasClass(child, 'radar-hit')).attrs.r) >= 12);
    assert.equal(hitLink(plot, x, y), prUrl(number));
  }
  for (const number of [3, 4]) {
    const [x, y] = markerCenter(markerFor(plot, number));
    assert.ok(Math.abs(x - 320) > 24);
    assert.equal(hitLink(plot, x, y), prUrl(number));
  }
});

test('ATC held and ready marker links keep their own targets under an overlapping approach rider label', async () => {
  const sessions = Array.from('abcde', slug => ({ slug }));
  const queue = withUrls([
    { number: 1, status: 'ready' },
    { number: 2, status: 'ready', riders: Array.from({ length: 8 }, (_, i) => i + 100) },
    ...Array.from({ length: 5 }, (_, i) => ({ number: i + 20, status: 'held', owner: 'c' })),
  ]);
  const { plot } = await renderATC({ sessions, mergeQueue: { queue } });
  const label = labelFor(plot, 2);
  assert.match(labelText(label), /^#2 · 8 riders$/);
  const rect = label.children.find(node => hasClass(node, 'radar-plate'));
  const [heldX, heldY] = markerCenter(markerFor(plot, 24));
  // Force an overlap so the test covers paint order independently of label positioning.
  label.setAttribute('transform', 'translate(' + (heldX - Number(rect.attrs.x) - 4) + ' ' + (heldY - Number(rect.attrs.y) - 4) + ')');
  assert.equal(hitLink(label, heldX, heldY), prUrl(2));
  assert.equal(hitLink(plot, heldX, heldY), prUrl(24));
  assert.equal(hitLink(plot, ...markerCenter(markerFor(plot, 2))), prUrl(2));
});

test('ATC opens the ready PR through its unobscured radar number link', async () => {
  const { plot } = await renderATC({
    sessions: [{ slug: 'a' }],
    mergeQueue: { queue: withUrls([{ number: 42, status: 'ready', owner: 'a' }]) },
  });
  const label = labelFor(plot, 42);
  assert.equal(label.nodeName, 'a');
  assert.equal(labelText(label), '#42');
  const box = plateBounds(label);
  assert.equal(hitLink(plot, box.x + box.width / 2, box.y + box.height / 2), prUrl(42));
});

test('ATC keeps full groups of holding blips out of the approach lane at every sector count', async () => {
  for (let count = 1; count <= 8; count++) {
    const sessions = Array.from('abcdefg'.slice(0, count), slug => ({ slug }));
    const owners = sessions.map(({ slug }) => slug);
    if (count === 8) owners.push(null);
    const queue = owners.flatMap((owner, index) => Array.from({ length: 5 }, (_, offset) => ({
      number: index * 5 + offset + 1, owner, status: 'held',
    })));
    queue.unshift({ number: 99, status: 'ready' });
    const { plot } = await renderATC({ sessions, mergeQueue: { queue } });
    assert.equal(markerCenter(markerFor(plot, 99))[0], 320);
    for (const { number } of queue.slice(1)) {
      const mark = markerFor(plot, number);
      assert.ok(mark, 'Expected plotted PR #' + number);
      assert.ok(Math.abs(markerCenter(mark)[0] - 320) > 24, 'PR #' + number + ' crosses the lane in the ' + count + '-sector layout');
    }
  }
});

test('Workspace g m navigates to Migrations and a bare m opens the shell composer', () => {
  const workspace = script('dashboard/views/workspace.html');
  const shell = script('dashboard/index.html');
  const keyboard = workspace.match(/\/\* ---------- keyboard ---------- \*\/\s*(document\.addEventListener[\s\S]*?\n\}\);)/)[1];
  const routing = workspace.match(/function routeHash\(view\) \{[\s\S]*?(?=function setView\(view\))/)[0];
  const onKey = shell.match(/  function onKey\(e\) \{[\s\S]*?\n  \}/)[0];
  const location = { hash: '' };
  let composerOpens = 0;
  let workspaceKey;
  runInNewContext(`${routing}\n${keyboard}`, {
    S: {}, location, shortcutsEnabled: true, pref: () => 'on',
    document: { addEventListener: (_, handler) => { workspaceKey = handler; } },
  });
  const shellKey = runInNewContext(`${onKey}\nonKey`, {
    composerOpen: () => false, canPost: () => true, openComposer: () => { composerOpens++; },
  });
  function press(key, repeat = false) {
    const event = new Event('keydown', { cancelable: true });
    event.key = key;
    event.repeat = repeat;
    workspaceKey(event);
    shellKey(event);
  }
  press('g');
  press('m');
  assert.equal(location.hash, '#/migrations');
  assert.equal(composerOpens, 0);
  press('m', true);
  assert.equal(location.hash, '#/migrations');
  assert.equal(composerOpens, 0);
  press('m');
  assert.equal(composerOpens, 1);
});

test('the paste-in prompt identifies both placeholders and uses a portable status path', () => {
  const [intro, prompt] = source('PROMPT.md').split('```text');
  assert.match(intro, /replace (?:every|all) `SLUG` and `<this folder>`/i);
  assert.match(prompt, /<this folder>\/status\/SLUG\.md/);
  assert.doesNotMatch(prompt, /minutes from the roster/);
});

test('the paste-in commands preserve literal board paths and teach the hook the session identity', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'zippermerge-prompt-'));
  try {
    const [intro, prompt] = source('PROMPT.md').split('```text');
    const quotedApostrophe = intro.match(/replace each apostrophe within it with `([^`]+)`/)[1];
    const commands = Array.from(prompt.matchAll(/`(bash [^`]+)`/g), ([, command]) => command);
    const repo = join(scratch, 'repo');
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.ifError(init.error);
    assert.equal(init.status, 0, init.stderr);
    const env = { ...process.env, ZM_REPO: repo, ZM_REPO_COMMON: join(repo, '.git') };
    delete env.ZIPPERMERGE_PROMPT_TEST;
    const capture = fileURLToPath(new URL('../capture.mjs', import.meta.url));
    for (const name of ['team board', 'team $ZIPPERMERGE_PROMPT_TEST board', "team's `$ZIPPERMERGE_PROMPT_TEST` board"]) {
      const board = join(scratch, name);
      mkdirSync(join(board, 'status'), { recursive: true });
      writeFileSync(join(board, 'status', 'tester.md'), '# tester\n');
      writeFileSync(join(board, 'chat.sh'), 'printf "%s|%s\\n" "$1" "$2"\n');
      const path = board.split(sep).join('/');
      const quoted = "'" + `${path}/chat.sh`.replaceAll("'", () => quotedApostrophe) + "'";
      const shellCommands = commands.map(command => command.replaceAll('SLUG', 'tester')
        .replaceAll('<shell-quoted chat.sh path>', () => quoted));
      const results = shellCommands.map(command => {
        const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env });
        assert.ifError(result.error);
        return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
      });
      assert.deepEqual(results, ['new|tester', 'board|', 'post|tester'].map(output => ({ status: 0, output, error: '' })), name);
      const identities = [[0, 'new'], [2, 'post']].map(([index, subcommand]) => {
        const session_id = `prompt-${subcommand}`;
        const result = spawnSync(process.execPath, [capture], {
          encoding: 'utf8', env: { ...env, CHAT_DIR: board },
          input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: scratch,
            session_id, tool_input: { command: shellCommands[index] } }),
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const file = join(board, 'identity', `${session_id}.json`);
        if (!existsSync(file)) return null;
        const { slug, via } = JSON.parse(readFileSync(file, 'utf8'));
        return { slug, via };
      });
      assert.deepEqual(identities, ['new', 'post'].map(subcommand => ({ slug: 'tester', via: `chat.sh ${subcommand}` })), name);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
