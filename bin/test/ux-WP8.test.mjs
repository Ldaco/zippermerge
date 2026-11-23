import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const gallery = readFileSync(new URL('../../dashboard/mockups/index.html', import.meta.url), 'utf8');

test('each prototype card has one link named by its visible title', () => {
  const template = gallery.match(/<template id="prototype-card">([\s\S]*?)<\/template>/);
  assert.ok(template, 'The gallery uses one shared card template');
  assert.equal([...template[1].matchAll(/<a\b/g)].length, 1);
  assert.match(template[1], /<a\b[^>]*>\s*[\s\S]*?<span class="name"><\/span>[\s\S]*?<\/a>/);
  assert.match(gallery, /name\.textContent = m\[2\]/);
  assert.match(gallery, /card\.setAttribute\('aria-labelledby', name\.id\)/);
  assert.match(gallery, /card\.href = href/);
});

test('preview iframes load lazily and are hidden from assistive technology', () => {
  const iframe = gallery.match(/<iframe\b[^>]*>/)?.[0];
  assert.ok(iframe, 'The card contains a preview iframe');
  assert.match(iframe, /\bloading="lazy"/);
  assert.match(iframe, /\baria-hidden="true"/);
  assert.match(iframe, /\btabindex="-1"/);
  assert.match(iframe, /\binert\b/);
});

test('reduced motion disables the card lift and its transition', () => {
  const reduced = gallery.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(reduced, 'The gallery honors the reduced-motion preference');
  assert.match(reduced, /\.m\s*\{[^}]*\btransition:\s*none\b/);
  assert.match(reduced, /\.m:hover\s*\{[^}]*\btransform:\s*none\b/);
});
