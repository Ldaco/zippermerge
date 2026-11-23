import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../../dashboard/views/workspace.html', import.meta.url), 'utf8');
const sharedCss = readFileSync(new URL('../../dashboard/dashboard.css', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('Workspace provides a first skip link, main landmark, and one route heading', () => {
  assert.match(html, /<body>\s*<a\b[^>]*class="skip-link"[^>]*href="#main"/);
  assert.match(html, /<main\b[^>]*id="main"[^>]*>[\s\S]*?<h1\b[^>]*id="view-title"[^>]*tabindex="-1"/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(script, /\$\('view-title'\)\.focus\(/);
  assert.match(html, /<nav\b[^>]*id="workspace-nav"[^>]*aria-label="[^"]+"/);
  assert.match(html, /aria-controls="workspace-nav"[^>]*aria-expanded="false"/);
  assert.match(script, /setAttribute\('aria-current', 'page'\)/);
});

test('Workspace consumes shared styles and preserves focus and reflow', () => {
  assert.match(html, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.doesNotMatch(css, /\b(?:outline\s*:\s*(?:0|none)|all\s*:\s*unset)|--mu2\b|\binfinite\b/i);
  assert.doesNotMatch(css + script, /(?:^|[\s:;,=('"])#[\da-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(/im);
  const tokens = new Set([...sharedCss.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]));
  const localProperties = new Set([...css.matchAll(/(--[\w-]+):/g)].map((match) => match[1]));
  for (const [, token] of css.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(tokens.has(token) || localProperties.has(token), `Unknown CSS property ${token}`);
  }
  assert.match(css, /repeat\(auto-fit,\s*minmax\(/);
  assert.match(css, /@media\s*\(max-width:\s*48rem\)[\s\S]*?\.app\s*\{[^}]*display:\s*block/);
  assert.match(css, /scroll-padding-block-start:/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(sharedCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(script, /behavior:\s*['"]smooth['"]/);
});

test('Workspace has native named dialogs and a labelled autocomplete', () => {
  for (const [id, title] of [['palBack', 'palTitle'], ['helpBack', 'helpTitle']]) {
    const dialog = html.match(new RegExp(`<dialog\\b[^>]*id="${id}"[\\s\\S]*?</dialog>`))?.[0];
    assert.ok(dialog, `Missing native dialog ${id}`);
    assert.ok(dialog.includes(`aria-labelledby="${title}"`));
    assert.match(dialog, /<button\b[^>]*>Close<\/button>/);
  }
  assert.match(html, /<label\b[^>]*for="palIn"[^>]*>[^<]+<\/label>/);
  assert.match(html, /id="palIn"[^>]*role="combobox"[^>]*aria-controls="palList"[^>]*aria-autocomplete="list"[^>]*aria-expanded="false"/);
  assert.match(html, /id="palList"[^>]*role="listbox"[^>]*aria-label(?:ledby)?="[^"]+"/);
  assert.match(script, /\.showModal\(\)/);
  assert.match(script, /setAttribute\('aria-activedescendant',/);
  assert.match(script, /setAttribute\('aria-selected',/);
  assert.match(script, /\.zm\?*\.modal|\.zm\?\.modal/);
});

test('Workspace renders Inbox links and status text without interactive wrappers', () => {
  const inbox = script.slice(script.indexOf('function attRow('), script.indexOf('function nxRow('));
  assert.match(inbox, /h\('li',/);
  assert.match(inbox, /h\('ul',/);
  assert.match(inbox, /routeLink\(/);
  assert.doesNotMatch(script, /setAttribute\('role', 'button'\)/);
  for (const state of ['Active', 'Late', 'Silent', 'Urgent', 'Warning']) assert.ok(script.includes(`'${state}'`), state);
});

test('Workspace exposes filter, sorting, disclosure, and histogram state', () => {
  assert.match(script, /h\('fieldset'[\s\S]*?h\('legend'[\s\S]*?\.type = 'radio'/);
  assert.match(script, /setAttribute\('aria-sort',/);
  assert.match(script, /setAttribute\('aria-expanded',/);
  assert.match(script, /setAttribute\('aria-controls',/);
  assert.match(script, /dataset\.focusKey/);
  const histogram = script.slice(script.indexOf('function histogram('), script.indexOf('function activityView('));
  assert.match(histogram, /h\('details'[\s\S]*?h\('summary'[\s\S]*?tableFor\(/);
  assert.match(histogram, /bins\.forEach/);
  assert.match(histogram, /setAttribute\('role', 'img'\)/);
  assert.match(html, /role="status"\s+aria-atomic="true"[^>]*><\/div>/);
  assert.match(html, /role="alert"[^>]*><\/div>/);
});

test('Workspace shortcuts respect the shared preference and editing context', () => {
  assert.match(script, /zm\.keys/);
  assert.match(script, /e\.defaultPrevented/);
  assert.match(script, /e\.isComposing/);
  assert.match(script, /isContentEditable/);
  assert.doesNotMatch(script, /\bm:\s*'migrations'|['"]g m['"]/);
});
