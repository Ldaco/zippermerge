import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../dashboard/views/workspace.html', import.meta.url), 'utf8');
const sharedCss = readFileSync(new URL('../../dashboard/dashboard.css', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('Workspace provides a first skip link, main landmark, and one route heading', () => {
  assert.doesNotThrow(() => new Script(script));
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
});

test('Workspace handles the Migrations chord without consuming bare m and focuses native row links', () => {
  const keyboard = script.match(/\/\* ---------- keyboard ---------- \*\/\s*([\s\S]*?)(?=\/\* ---------- data ---------- \*\/)/)[1];
  const state = { chordAt: 0 };
  const document = { addEventListener(type, callback) { assert.equal(type, 'keydown'); onKey = callback; } };
  let onKey;
  let preference = 'on';
  const destinations = [];
  const dialogs = [];
  const links = Array.from({ length: 2 }, () => ({
    focus() { document.activeElement = this; },
    scrollIntoView({ behavior }) { assert.equal(behavior, 'instant'); },
  }));
  runInNewContext(keyboard, {
    document, S: state, shortcutsEnabled: true,
    $: () => ({ querySelectorAll: () => links }),
    pref: () => preference,
    go: (route) => destinations.push(route),
    openPal: () => dialogs.push('palette'),
    openHelp: () => dialogs.push('help'),
  });
  function press(key, overrides) {
    const event = { key, preventDefault() { this.defaultPrevented = true; }, ...overrides };
    onKey(event);
    return event.defaultPrevented === true;
  }
  press('g');
  assert.equal(press('m'), true);
  assert.deepEqual(destinations, ['migrations']);
  assert.equal(press('m'), false);
  press('g');
  assert.equal(press('w'), true);
  assert.deepEqual(destinations, ['migrations', 'worktrees']);
  assert.equal(press('/', { target: { isContentEditable: true } }), false);
  assert.equal(press('/', { isComposing: true }), false);
  assert.equal(press('/', { defaultPrevented: true }), true);
  assert.deepEqual(dialogs, []);
  assert.equal(press('j'), true);
  assert.equal(document.activeElement, links[0]);
  press('j');
  assert.equal(document.activeElement, links[1]);
  press('k');
  assert.equal(document.activeElement, links[0]);
  assert.equal(press('Enter'), false);
  preference = 'off';
  assert.equal(press('g'), false);
  assert.equal(press('m'), false);
  assert.deepEqual(destinations, ['migrations', 'worktrees']);
  assert.equal(press('j'), false);
  assert.equal(press('/'), false);
  assert.equal(press('k', { ctrlKey: true }), true);
  assert.deepEqual(dialogs, ['palette']);
});

function workspaceFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing Workspace function ${name}`);
  return script.slice(start, script.indexOf('\n}', start) + 2);
}

function node(tag, className = '', text = '', children = []) {
  return {
    tag, className, children: Array.from(children).filter(Boolean), dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { nodes.forEach((child) => this.appendChild(child)); },
    get firstChild() { return this.children[0]; },
    get textContent() { return String(text) + this.children.map((child) => child.textContent).join(' '); },
  };
}

function renderWorkspace(names, call, values) {
  const declarations = names.map(workspaceFunction).join('\n');
  return runInNewContext(`${declarations}\n${call}`, {
    h: node,
    arr: (value) => Array.isArray(value) ? value : [],
    obj: (value) => value ?? {},
    str: (value) => String(value ?? ''),
    num: (value, fallback) => value ?? fallback,
    nowMs: () => 1000,
    tmAt: () => node('time', '', 'in 15m'),
    ...values,
  });
}

test('Workspace gives simultaneous suite locks distinct banners and repository labels', () => {
  const records = [
    { file: 'full-test-suite.md', lock: 'full-test-suite', repoLabel: 'org/configured' },
    { file: 'full-test-suite-scoped.md', lock: 'full-test-suite', repoLabel: 'org/scoped' },
    { file: 'main-freeze.md', lock: 'main-freeze' },
  ];
  const text = (value) => node('span', '', value);
  const banners = renderWorkspace(['keyed', 'lockBanners'], 'lockBanners()', {
    locks: () => records, statusChip: text, slugChip: () => text('alpha'),
    tm: () => text('1m ago'), rich: () => text('test'),
  });
  assert.deepEqual(banners.children.map((banner) => banner.dataset.focusKey),
    records.map(({ file }) => 'lock:' + file));
  assert.match(banners.children[0].textContent, /Test suite locked.*org\/configured/);
  assert.match(banners.children[1].textContent, /Test suite locked.*org\/scoped/);
  assert.match(banners.children[2].textContent, /^Merge freeze/);
  assert.doesNotMatch(banners.children[2].textContent, /org\//);
});

test('Overview keeps all eight operational metrics and their detail', () => {
  const strip = renderWorkspace(['statCard', 'statStrip'], 'statStrip()', {
    S: { data: { migrations: { mainMax: 140 }, claims: [{}],
      worktrees: { items: [{ dirty: 1, behind: 2 }, { dirty: 0, behind: 1 }] },
      logStats: { perSession: { alpha: { h24: 5, h1: 2 }, beta: { h24: 3, h1: 1 } } },
    } },
    sessions: () => [{ slug: 'alpha' }, { slug: 'beta' }],
    presence: ({ slug }) => slug === 'alpha' ? 'ok' : 'amber',
    attention: () => [{ sev: 'red' }, { sev: 'amber' }],
    locks: () => [{ lock: 'main-freeze' }, { lock: 'full-test-suite', repoLabel: 'org/scoped' }],
    askCount: () => 2,
    timelineItems: () => [{ at: 2000, slug: 'alpha', text: 'Review the release' }],
    mqData: () => ({ queue: [] }),
  });
  const metrics = new Map(strip.children.map((card) => [card.firstChild.textContent, card.textContent]));
  assert.deepEqual([...metrics.keys()].sort(), [
    'Inbox', 'Locks held', 'Migrations', 'Next risky action', 'Open asks', 'Posts, 24h', 'Sessions healthy', 'Worktrees',
  ]);
  for (const [label, detail] of Object.entries({
    Inbox: /2.*1 urgent.*1 warning/, 'Locks held': /2.*main-freeze.*org\/scoped/, Migrations: /140.*1 claimed ahead/,
    'Next risky action': /in 15m.*alpha.*Review the release/, 'Open asks': /2.*waiting on a reply/i,
    'Posts, 24h': /8.*3 in the last hour/, 'Sessions healthy': /1\s*\/\s*2/, Worktrees: /2.*1 dirty.*2 behind main/,
  })) assert.match(metrics.get(label), detail);
});

function overviewSessions() {
  const fields = {
    Work: { value: 'Review the release', items: [] },
    'Hot files': { value: 'dashboard/fixture.html', items: [] },
    'Migrations held': { value: '141 fixture', items: [] },
    'Next risky action': { value: 'Review at 17:00 UTC', items: [] },
    Asks: { value: 'Ask about #401', items: [] },
  };
  return renderWorkspace(['sessionCard', 'sessionsPanel'], 'sessionsPanel()', {
    S: { data: {} },
    sessions: () => ['alpha', 'beta'].map((slug) => ({ slug, title: 'Repeated title', state: 'active', hb: { lastPostAt: 'ago' } })),
    routeLink: (route, label) => node('a', '', label),
    keyed: (element) => element,
    heartbeatChip: () => node('span', '', 'Active'),
    fieldOf: (session, key) => fields[key] ?? { value: '', items: [] },
    isNone: ({ value }) => !value,
    rich: (text) => node('span', '', text),
    statusChip: (text) => node('span', '', text),
    prRow: () => node('section', '', '#401 Checks passed'),
    cap: (text) => text,
    tm: () => node('time', '', '12m ago'),
    orderOf: () => Object.keys(fields),
    fieldRow: (label, { value }) => node('div', '', `${label} ${value}`),
  });
}

test('Overview retains session heartbeat, PR checks, and operational fields', () => {
  const sessions = overviewSessions();
  assert.match(sessions.textContent, /Last post\s+12m ago/);
  for (const text of ['#401 Checks passed', 'dashboard/fixture.html', '141 fixture', 'Review at 17:00 UTC', 'Ask about #401']) {
    assert.ok(sessions.textContent.includes(text), `Missing Overview session detail ${text}`);
  }
});

test('Overview merge-queue preview retains the branch lock and pull requests being merged', () => {
  const queue = { queue: [], merged: [], runway: { held: true, owner: 'alpha', prs: [401], why: 'Release window' } };
  const preview = renderWorkspace(['mqRunwayBody', 'mqCard'], 'mqCard()', {
    mqData: () => queue,
    routeLink: (route, title) => node('a', '', title),
    panel: (title, count, content) => node('section', '', title, [content]),
    state: (kind, label) => node('p', '', label),
    statusChip: (label) => node('span', '', label),
    slugChip: (slug) => node('span', '', slug),
    tm: () => node('time', '', '8m ago'),
    prTitle: ({ number }) => node('a', '', '#' + number),
    rich: (text) => node('span', '', text),
  });
  assert.match(preview.textContent, /Merge freeze\s+alpha.*Merging pull requests\s+#401.*Release window/);
});

test('Identically titled Overview sessions do not create duplicate named landmarks', () => {
  const sessions = overviewSessions();
  const list = sessions.children.find((child) => child.tag === 'ul');
  assert.ok(list, 'The Sessions landmark should contain a list');
  assert.equal(list.children.length, 2);
  for (const card of list.children) {
    assert.equal(card.tag, 'li');
    assert.equal(card.attributes['aria-labelledby'], undefined);
    assert.match(card.textContent, /Repeated title/);
  }
});

test('Palette selection adds an inset outline in forced colors', () => {
  const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'));
  const selectedOption = forcedColors.match(/\.pi\[aria-selected="true"\]\s*\{([^}]*)\}/)?.[1];
  assert.match(selectedOption ?? '', /outline:\s*2px solid Highlight/);
  assert.match(selectedOption, /outline-offset:\s*-2px/);
});

test('Unrecognized queue statuses never claim a hold', () => {
  const statuses = script.match(/var QUEUE_STATUS = new Map\(\[[\s\S]*?\]\);/)[0];
  const queueStatus = runInNewContext(`${statuses}\n${workspaceFunction('queueStatus')}\nqueueStatus`, {
    str: String,
    statusChip: (label, role) => ({ label, role }),
  });
  assert.deepEqual(queueStatus({ status: 'ci_running' }), { label: 'Status unknown', role: 'neutral' });
  assert.equal(queueStatus({ status: 'review' }).label, 'Status unknown');
  assert.equal(queueStatus({ status: 'blocked' }).label, 'Status unknown');
  assert.equal(queueStatus({ status: 'held' }).label, 'On hold');
  assert.equal(queueStatus({ status: 'ci' }).label, 'CI running');
  assert.equal(queueStatus({ status: 'stacked', stackedOn: 401 }).label, 'Stacked on #401');
});

test('Each native filter radio has a 24px minimum control box', () => {
  const radio = css.match(/\.filter input\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(radio, /(?:^|[;\s])inline-size:\s*1\.5rem/);
  assert.match(radio, /(?:^|[;\s])block-size:\s*1\.5rem/);
});
