import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the default pull request template prompts for the required evidence', () => {
  const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');
  const visible = template.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const headings = visible.split(/\r?\n/).filter(line => line.startsWith('## '));
  for (const title of [
    'Issue', 'Root cause', 'Reproduction', 'Failing test committed first',
    'Test plan and results', 'Risk and rollback', 'Files reserved on the board', 'Reviewer or validator',
  ]) {
    assert.ok(headings.includes('## ' + title), `Missing heading: ${title}`);
  }
});
