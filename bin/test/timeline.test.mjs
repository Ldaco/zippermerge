import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/timeline.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];

class Element {
  nodeType = 1;
  children = [];
  textContent = '';

  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); }
}

function loadTimeline() {
  const elements = new Map();
  const document = {
    createElement: () => new Element(),
    createElementNS: () => new Element(),
    createTextNode: (textContent) => ({ nodeType: 3, textContent }),
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const context = createContext({
    document,
    fetch: () => new Promise(() => {}),
    setInterval() {},
    window: { addEventListener() {} },
  });
  runInContext(script, context);
  return context;
}

test('Timeline uses the UTC clock and day for landed PRs', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const context = loadTimeline();
    const mergedAt = '2026-11-22T19:05:00Z';
    assert.equal(new Date(mergedAt).getHours(), 14);
    context.data = { mergeQueue: { merged: [{ number: 1, mergedAt }] } };
    context.renderDetail();
    const [panel] = context.document.getElementById('mq').children;
    const [heading, row] = panel.children[2].children;
    assert.equal(row.children[0].children[0].textContent, '19:05Z');
    assert.equal(heading.children[0].textContent, 'Landed today (UTC) · 1');
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
