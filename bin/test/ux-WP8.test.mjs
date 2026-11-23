import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const gallery = readFileSync(new URL('../../dashboard/mockups/index.html', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../dashboard/dashboard.css', import.meta.url), 'utf8');
const card = gallery.match(/<template id="prototype-card">([\s\S]*?)<\/template>/)?.[1] ?? '';

test('gallery loads the shared dashboard stylesheet', () => {
  assert.match(gallery, /<link\b[^>]*rel="stylesheet"[^>]*href="\/dashboard\.css"[^>]*>/);
});

test('gallery links inherit the shared accent focus outline', () => {
  assert.match(shared, /^:focus-visible\s*\{[^}]*\boutline:\s*[^;{}]*var\(--accent\)/m);
  assert.doesNotMatch(gallery, /--accent\s*:/);
  assert.doesNotMatch(gallery, /\boutline(?:-color)?\s*:/);
});

test('each prototype card has one link named by its visible title', () => {
  const links = card.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
  assert.deepEqual(links, ['<a class="name"></a>']);
  assert.match(gallery, /var link = card\.querySelector\('\.name'\)/);
  assert.match(gallery, /link\.textContent = m\[2\]/);
  assert.match(gallery, /link\.href = href/);
});

test('preview iframes load lazily and are hidden from assistive technology', () => {
  const iframe = card.match(/<iframe\b[^>]*>/)?.[0];
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
