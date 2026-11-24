import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function visibleHeadings(template) {
  const headings = new Set();
  let closingFence;
  let inComment = false;
  for (const line of template.split(/\r?\n/)) {
    if (closingFence) {
      if (closingFence.test(line)) closingFence = undefined;
      continue;
    }

    const fence = /^ {0,3}(`{3,}(?!`)(?=[^`]*$)|~{3,})/.exec(line);
    if (!inComment && fence) {
      const marker = fence[1];
      closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      continue;
    }

    // Carry an open HTML comment across lines. Comment markers inside fences are literal.
    const text = (inComment ? '<!--' + line : line).replace(/<!--.*?-->/g, '');
    const commentStart = text.indexOf('<!--');
    inComment = commentStart !== -1;
    const visible = inComment ? text.slice(0, commentStart) : text;
    if (visible.startsWith('## ')) headings.add(visible);
  }
  return headings;
}

test('the default pull request template prompts for the required evidence', () => {
  const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');
  const headings = visibleHeadings(template);
  for (const title of [
    'Issue', 'Root cause', 'Reproduction', 'Failing test committed first',
    'Test plan and results', 'Risk and rollback', 'Files reserved on the board', 'Reviewer or validator',
  ]) {
    assert.ok(headings.has('## ' + title), `Missing heading: ${title}`);
  }
});
