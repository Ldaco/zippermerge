import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
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

class Element {
  children = [];
  attrs = {};
  style = {};
  handlers = {};

  constructor(tag) { this.tag = tag; }
  get firstChild() { return this.children[0]; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  getBBox() {
    // Use deterministic font metrics representative of the radar's SVG text.
    const width = Number(this.attrs.textLength) || this.textContent.length * (this.attrs.class === 'sect' ? 9.4 : 7);
    const anchor = { middle: width / 2, end: width }[this.attrs['text-anchor']] || 0;
    return { x: Number(this.attrs.x) - anchor, y: Number(this.attrs.y) - 11, width, height: 14 };
  }
}

async function renderATC(board) {
  const elements = new Map();
  const opened = [];
  let poll;
  runInNewContext(atc, {
    document: {
      createElement: tag => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element(id));
        return elements.get(id);
      },
    },
    fetch: async () => ({ ok: true, json: async () => board }),
    setInterval(callback, delay) { if (delay === 7000) poll = callback; },
    window: { open: url => opened.push(url) },
  });
  async function rendered() {
    await setImmediate();
    assert.equal(elements.get('pollstat').className, '', elements.get('pollstat').textContent);
  }
  await rendered();
  return {
    elements, opened,
    async refresh(nextBoard) {
      board = nextBoard;
      poll();
      await rendered();
    },
  };
}

function blipFor(children, number) {
  return children.find(node => node.attrs.class === 'blip' && node.children.some(child =>
    child.attrs.class === 'blipt' && child.textContent.split(/\s/)[0] === `#${number}`));
}

function markerOf(blip) {
  return blip.children.find(node => node.attrs.class?.split(' ').includes('b')).attrs;
}

test('ATC reuses the collision-free sector colors for blips and landing sequence tags', async () => {
  const sessions = ['an', 'c0'].map(slug => ({ slug }));
  const queue = sessions.map(({ slug }, index) => ({ number: index + 1, owner: slug, status: 'held' }));
  const { elements } = await renderATC({ sessions, mergeQueue: { queue } });
  const { children } = elements.get('scope');
  const labels = children.flatMap(node => node.children).filter(node => node.attrs.class === 'sect');
  const [table] = elements.get('seq').children;
  const rows = table.children.find(node => node.tag === 'tbody').children;
  assert.notEqual(labels[0].attrs.fill, labels[1].attrs.fill);
  for (const [index, row] of rows.entries()) {
    const tag = row.children.flatMap(node => node.children).find(node => node.className === 'tag sess');
    assert.equal(tag.style.background, labels[index].attrs.fill);
    assert.equal(markerOf(blipFor(children, index + 1)).fill, labels[index].attrs.fill);
  }
});

test('ATC keeps the color of a visible session across polling membership changes', async () => {
  const queue = [{ number: 1, owner: 'c0', status: 'held' }];
  const board = slugs => ({ sessions: slugs.map(slug => ({ slug })), mergeQueue: { queue } });
  const { elements, refresh } = await renderATC(board(['an', 'c0']));
  const scope = elements.get('scope');
  const initial = markerOf(blipFor(scope.children, 1)).fill;
  await refresh(board(['c0']));
  assert.equal(markerOf(blipFor(scope.children, 1)).fill, initial);
  await refresh(board(['an', 'c0']));
  const labels = scope.children.flatMap(node => node.children).filter(node => node.attrs.class === 'sect');
  assert.equal(labels.find(node => node.textContent === 'c0').attrs.fill, initial);
  assert.equal(new Set(labels.map(node => node.attrs.fill)).size, 2);
});

test('ATC keeps both long session labels inside the radar viewBox', async () => {
  const slugs = ['abcdefghijklmnopqrstuvwx', 'zyxwvutsrqponmlkjihgfedc'];
  const { elements } = await renderATC({ sessions: slugs.map(slug => ({ slug })) });
  const labels = elements.get('scope').children.flatMap(node => node.children).filter(node => node.attrs.class === 'sect');
  assert.deepEqual(labels.map(node => node.textContent), slugs);
  for (const label of labels) {
    const { x, width } = label.getBBox();
    assert.ok(x >= 0 && x + width <= 640, `${label.textContent} bounds are ${x}..${x + width}`);
  }
});

test('ATC plots unowned and off-radar PRs in their own holding sectors', async () => {
  const sessions = Array.from('abcdefgh', slug => ({ slug }));
  const owners = ['a', 'g', null];
  const queue = owners.flatMap((owner, i) => Array.from({ length: 6 }, (_, j) => ({
    number: i * 10 + j + 1, owner, status: 'held',
  })));
  const { elements } = await renderATC({ sessions, mergeQueue: { queue } });

  const { children } = elements.get('scope');
  const labels = children.flatMap(node => node.children).filter(node => node.attrs.class === 'sect');
  assert.deepEqual(labels.map(node => node.textContent), ['a', 'b', 'c', 'd', 'e', 'f', 'Other sessions', 'Unowned']);
  assert.ok(children.flatMap(node => node.children).some(node => node.textContent === '+2 sessions not shown'));
  assert.equal(children.filter(node => node.textContent === '+1 holding').length, owners.length);

  const angle = (x, y) => Math.atan2(Number(y) - 300, Number(x) - 320) * 180 / Math.PI;
  const blips = children.filter(node => node.attrs.class === 'blip');
  assert.equal(blips.length, 15);
  for (const [i, group] of [labels[0], labels[6], labels[7]].entries()) {
    const center = angle(group.attrs.x, Number(group.attrs.y) + 8);
    for (let j = 0; j < 5; j++) {
      const number = i * 10 + j + 1;
      const blip = blipFor(blips, number);
      assert.ok(blip, `PR #${number} should be plotted`);
      const { cx, cy } = markerOf(blip);
      const offset = (angle(cx, cy) - center + 540) % 360 - 180;
      assert.ok(Math.abs(offset) < 180 / labels.length, `PR #${number} should be inside ${group.textContent}`);
    }
  }
});

test('ATC holding markers stay outside the approach lane and preserve ready PR hit targets', async () => {
  const sessions = Array.from('abcde', slug => ({ slug }));
  const queue = [
    { number: 1, status: 'ready' },
    { number: 2, status: 'ready' },
    { number: 3, status: 'held', owner: 'b' },
    { number: 4, status: 'held' },
  ];
  const { elements } = await renderATC({ sessions, mergeQueue: { queue } });
  const { children } = elements.get('scope');
  const blips = children.filter(node => node.attrs.class === 'blip');
  // SVG paints later siblings above earlier siblings. Check the painted circle hit areas in that order.
  for (const number of [1, 2]) {
    const ready = blipFor(blips, number);
    const target = markerOf(ready);
    const hit = blips.findLast(node => node.children.some(({ tag, attrs }) => tag === 'circle' &&
      Math.hypot(attrs.cx - target.cx, attrs.cy - target.cy) <= Number(attrs.r) + Number(attrs['stroke-width'] || 0) / 2));
    assert.equal(hit.children.find(node => node.attrs.class === 'blipt').textContent, `#${number}`);
  }
  const approach = markerOf(blipFor(blips, 2));
  for (const number of [3, 4]) {
    const holding = markerOf(blipFor(blips, number));
    const paintedRadii = Number(approach.r) + Number(holding.r) + (Number(approach['stroke-width']) + Number(holding['stroke-width'])) / 2;
    assert.ok(Math.abs(holding.cx - approach.cx) > paintedRadii);
  }
});

function clickRadarMarker(children, marker) {
  const x = Number(marker.cx), y = Number(marker.cy);
  const paintedHit = node => {
    const { tag, attrs } = node;
    if (attrs['pointer-events'] === 'none') return false;
    if (tag === 'circle') return Math.hypot(attrs.cx - x, attrs.cy - y) <= Number(attrs.r) + Number(attrs['stroke-width'] || 0) / 2;
    if (tag !== 'text') return false;
    const box = node.getBBox();
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  };
  // Model SVG sibling paint order and bubbling from the topmost painted node.
  const group = children.findLast(node => node.attrs.class === 'blip' && node.children.some(paintedHit));
  const hit = group.children.findLast(paintedHit);
  const click = hit.handlers.click || group.handlers.click;
  click();
}

test('ATC held and ready markers open their own PR even under approach rider labels', async () => {
  const sessions = Array.from('abcde', slug => ({ slug }));
  const queue = [
    { number: 1, status: 'ready' },
    { number: 2, status: 'ready', riders: Array.from({ length: 8 }, (_, i) => i + 100) },
    ...Array.from({ length: 5 }, (_, i) => ({ number: i + 20, status: 'held', owner: 'c' })),
  ];
  const url = number => `https://github.com/example/repo/pull/${number}`;
  queue.forEach(q => { q.url = url(q.number); });
  const { elements, opened } = await renderATC({ sessions, mergeQueue: { queue } });
  const { children } = elements.get('scope');
  const ready = blipFor(children, 2);
  const held = markerOf(blipFor(children, 24));
  const labelBox = ready.children.find(node => node.attrs.class === 'blipt').getBBox();
  assert.ok(held.cx > labelBox.x && held.cx < labelBox.x + labelBox.width);
  assert.ok(held.cy > labelBox.y && held.cy < labelBox.y + labelBox.height);
  clickRadarMarker(children, held);
  clickRadarMarker(children, markerOf(ready));
  assert.deepEqual(opened, [url(24), url(2)]);
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
    const { elements } = await renderATC({ sessions, mergeQueue: { queue } });
    const { children } = elements.get('scope');
    const approach = markerOf(blipFor(children, 99));
    for (const { number } of queue.slice(1)) {
      const holding = markerOf(blipFor(children, number));
      const paintedRadii = Number(approach.r) + Number(holding.r) + (Number(approach['stroke-width']) + Number(holding['stroke-width'])) / 2;
      assert.ok(Math.abs(holding.cx - approach.cx) > paintedRadii, `PR #${number} in ${count}-sector layout`);
    }
  }
});

test('Workspace g m navigates to Migrations and a bare m opens the shell composer', () => {
  const workspace = script('dashboard/views/workspace.html');
  const shell = script('dashboard/index.html');
  const keyboard = workspace.match(/\/\* ---------- keyboard ---------- \*\/\s*(document\.addEventListener[\s\S]*?\n\}\);)/)[1];
  const onKey = shell.match(/  function onKey\(e\) \{[\s\S]*?\n  \}/)[0];
  const views = [];
  let composerOpens = 0;
  let workspaceKey;
  runInNewContext(keyboard, {
    S: {}, go: view => views.push(view),
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
  press('m', true);
  assert.deepEqual(views, ['migrations']);
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

test('the paste-in commands preserve spaces and literal shell characters in board paths', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'zippermerge-prompt-'));
  try {
    const prompt = source('PROMPT.md').split('```text')[1];
    const commands = Array.from(prompt.matchAll(/`(bash [^`]+)`/g), ([, command]) => command);
    const env = { ...process.env };
    delete env.ZIPPERMERGE_PROMPT_TEST;
    for (const name of ['team board', 'team $ZIPPERMERGE_PROMPT_TEST board', "team's `$ZIPPERMERGE_PROMPT_TEST` board"]) {
      const board = join(scratch, name);
      mkdirSync(board);
      writeFileSync(join(board, 'chat.sh'), 'printf "%s|%s\\n" "$1" "$2"\n');
      const path = board.split(sep).join('/');
      const quoted = "'" + `${path}/chat.sh`.replaceAll("'", "'\\''") + "'";
      const results = commands.map(command => {
        const substituted = command.replaceAll('<this folder>', () => path)
          .replaceAll('<shell-quoted chat.sh path>', () => quoted).replaceAll('SLUG', 'tester');
        const result = spawnSync('bash', ['-c', substituted], { encoding: 'utf8', env });
        assert.ifError(result.error);
        return { status: result.status, output: result.stdout.trim(), error: result.stderr.trim() };
      });
      assert.deepEqual(results, ['new|tester', 'board|', 'post|tester'].map(output => ({ status: 0, output, error: '' })), name);
    }
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
