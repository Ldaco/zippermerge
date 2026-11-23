import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const identityFills = new Set([
  '#B4531A', '#5B3FB5', '#0B7A78', '#1F5FBF',
  '#A8316F', '#5E7410', '#8F4A26', '#2F6F3A',
]);
const colorLiteral = /(?<![\w-])(?:#|%23)(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\brgba?\(/gi;

for (const file of ['index.html', 'views/graph.html', 'views/timeline.html', 'views/workspace.html', 'views/atc.html']) {
  test(`${file} uses shared theme tokens for colors`, async () => {
    const source = await readFile(new URL(`../../dashboard/${file}`, import.meta.url), 'utf8');
    const literals = source.split(/\r?\n/).flatMap((line, index) =>
      Array.from(line.matchAll(colorLiteral), ([literal]) => literal)
        .filter((literal) => !/^views\/(?:graph|atc)\.html$/.test(file) ||
          !identityFills.has(literal.toUpperCase().replace(/^%23/, '#')))
        .map((literal) => `${index + 1}: ${literal}`));
    assert.deepEqual(literals, [], `Use dashboard.css tokens in ${file}: ${literals.join(', ')}`);
  });
}
