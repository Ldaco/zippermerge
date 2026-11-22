import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const sessions = ['a', 'b', 'c', 'bravo', 'charlie', 'foxtrot'].map(slug => ({ slug }));
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

  constructor(tag) { this.tag = tag; }
  get firstChild() { return this.children[0]; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener() {}
}

test('ATC plots unowned and off-radar PRs in their own holding sectors', async () => {
  const elements = new Map();
  const sessions = Array.from('abcdefgh', slug => ({ slug }));
  const owners = ['a', 'g', null];
  const queue = owners.flatMap((owner, i) => Array.from({ length: 6 }, (_, j) => ({
    number: i * 10 + j + 1, owner, status: 'held',
  })));
  const board = { sessions, mergeQueue: { queue } };
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
    setInterval() {},
  });
  await setImmediate();

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
      const blip = blips.find(node => node.children.some(child => child.textContent === `#${number}`));
      assert.ok(blip, `PR #${number} should be plotted`);
      const { cx, cy } = blip.children.find(node => node.attrs.class === 'b').attrs;
      const offset = (angle(cx, cy) - center + 540) % 360 - 180;
      assert.ok(Math.abs(offset) < 180 / labels.length, `PR #${number} should be inside ${group.textContent}`);
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
  function press(key) {
    const event = new Event('keydown', { cancelable: true });
    event.key = key;
    workspaceKey(event);
    shellKey(event);
  }
  press('g');
  press('m');
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
