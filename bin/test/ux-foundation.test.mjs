import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesheet = new URL('../../dashboard/dashboard.css', import.meta.url);
const server = fileURLToPath(new URL('../../dashboard/server.mjs', import.meta.url));
const surfaces = ['canvas', 'surface', 'surface-subtle', 'surface-hover', 'surface-selected'];
const roles = ['danger', 'warning', 'success', 'info', 'neutral', 'ask'];
const identities = Array.from({ length: 8 }, (_, index) => `identity-${index + 1}`).concat('identity-fallback');
const sizes = ['xs', 'sm', 'md', 'lg', 'xl', 'metric'];
const variable = /var\(\s*(--[\w-]+)\s*\)/g;

// These checks inspect the foundation's simple rules and color aliases, with
// comments and quoted strings kept out of the rule/declaration delimiters.
function parseRules(source) {
  const strings = [];
  const css = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (part) => {
    if (part.startsWith('/*')) return ' ';
    return `\u0000${strings.push(part) - 1}\u0000`;
  });
  const restore = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, index) => strings[index]);
  const rules = [];
  const stack = [];
  for (const match of css.matchAll(/([^{}]+)\{|\}/g)) {
    if (match[1]) {
      stack.push({ selector: restore(match[1].trim()), start: match.index + match[0].length, group: false });
      continue;
    }
    const { selector, start, group } = stack.pop();
    if (stack.length) stack.at(-1).group = true;
    if (group) continue;
    const declarations = new Map();
    for (const part of css.slice(start, match.index).split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      declarations.set(part.slice(0, colon).trim(), restore(part.slice(colon + 1).trim()));
    }
    rules.push({ selector, declarations, context: stack.map((rule) => rule.selector) });
  }
  assert.equal(stack.length, 0, 'stylesheet rules must be balanced');
  return rules;
}

function resolveTokens(rules) {
  const tokens = new Map();
  for (const { declarations, selector, context } of rules) {
    if (selector !== ':root' || context.length) continue;
    for (const [name, value] of declarations) {
      if (name.startsWith('--')) tokens.set(name, value);
    }
  }
  function resolve(value, seen = []) {
    const resolved = value.replace(variable, (_, name) => {
      assert.ok(tokens.has(name), `missing token ${name}`);
      assert.ok(!seen.includes(name), `cyclic token reference ${[...seen, name].join(' → ')}`);
      return resolve(tokens.get(name), [...seen, name]);
    });
    assert.doesNotMatch(resolved, /\bvar\(/i, `unresolved token in ${value}`);
    return resolved;
  }
  for (const name of tokens.keys()) resolve(`var(${name})`);
  return resolve;
}

// WCAG 2.2 relative luminance and contrast ratio for opaque sRGB colors.
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
function luminance(color) {
  assert.match(color, /^#[\da-f]{6}$/i, `expected an opaque sRGB token, got ${color}`);
  const [red, green, blue] = color.slice(1).match(/../g).map((hex) => {
    const channel = Number.parseInt(hex, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function assertContrast(resolve, foreground, backgrounds, minimum) {
  const ink = luminance(resolve(`var(--${foreground})`));
  for (const background of backgrounds) {
    const fill = luminance(resolve(`var(--${background})`));
    const ratio = (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05);
    assert.ok(ratio >= minimum, `--${foreground} on --${background}: ${ratio.toFixed(3)}:1 < ${minimum}:1`);
  }
}

test('light tokens meet the design system contrast requirements', async () => {
  const resolve = resolveTokens(parseRules(await readFile(stylesheet, 'utf8')));
  const check = (foreground, backgrounds, minimum = 4.5) => {
    assertContrast(resolve, foreground, backgrounds, minimum);
  };

  for (const text of ['text', 'text-secondary', 'text-muted', 'accent']) check(text, surfaces);
  check('placeholder', ['surface', 'surface-subtle']);
  check('on-accent', ['accent', 'accent-hover']);
  check('disabled-text', ['disabled-bg']);
  check('text', surfaces, 3); // 24px view titles and 32px metrics
  check('control-border', [...surfaces, 'danger-tint'], 3);
  check('accent', surfaces, 3); // selection markers and primary control boundaries
  check('accent-hover', surfaces, 3);
  for (const role of roles) {
    check(role, [`${role}-tint`]);
    check(role, ['canvas', 'surface'], 3);
  }
  check('on-identity', identities);
  for (const fill of identities) check(fill, ['canvas'], 3);

  const layoutTokens = [
    'divider', 'font-ui', 'font-mono', ...sizes.flatMap((size) => [`text-${size}`, `line-${size}`]),
    ...Array.from({ length: 7 }, (_, index) => `space-${index + 1}`),
    'page-inset', 'radius-sm', 'radius-control', 'radius-card', 'radius-dialog', 'radius-pill',
    'shadow-pop', 'shadow-dialog', 'backdrop', 'control-size',
  ];
  for (const token of layoutTokens) assert.ok(resolve(`var(--${token})`));
});

test('focus and minimum type size survive across the foundation primitives', async () => {
  const rules = parseRules(await readFile(stylesheet, 'utf8'));
  const resolve = resolveTokens(rules);
  const ring = rules.find(({ selector, context }) => selector === ':focus-visible' && !context.length)?.declarations;
  assert.equal(ring?.get('outline'), '2px solid var(--accent)');
  assert.equal(ring.get('outline-offset'), '2px');
  assertContrast(resolve, 'accent', [...surfaces, ...roles.map((role) => `${role}-tint`)], 3);
  assertContrast(resolve, 'surface', ['accent', 'accent-hover', ...identities], 3);

  const forbiddenReset = /^(?:all:\s*unset|outline(?:-(?:width|style))?:\s*(?:none|hidden|0(?:px|rem|em)?)(?:\s|$))/i;
  const fontSize = /^([\d.]+)(px|rem|%)$/;
  const assertSize = (value, selector) => {
    const result = fontSize.exec(resolve(value));
    assert.ok(result, `${selector} has an unrecognized font size ${value}`);
    const [, number, unit] = result;
    const minimum = { px: 12, rem: 0.75, '%': 100 }[unit];
    assert.ok(Number(number) >= minimum, `${selector} has font size ${value} below the minimum`);
  };
  for (const size of sizes) assertSize(`var(--text-${size})`, `--text-${size}`);
  for (const { selector, declarations } of rules) {
    for (const [property, value] of declarations) {
      assert.doesNotMatch(`${property}: ${value}`, forbiddenReset, `${selector} removes the focus outline`);
    }
    if (declarations.has('font-size')) assertSize(declarations.get('font-size'), selector);
  }
  for (const [media, property, value] of [
    [/^@media\s*\(forced-colors:\s*active\)$/, 'outline-color', 'Highlight'],
    [/^@media\s*\(prefers-reduced-motion:\s*reduce\)$/, 'scroll-behavior', 'auto !important'],
    [/^@media\s+print$/, 'display', 'table-header-group'],
  ]) {
    assert.ok(rules.some(({ context, declarations }) =>
      context.some((query) => media.test(query)) && declarations.get(property) === value),
    `missing ${property}: ${value} in ${media}`);
  }
});

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: '127.0.0.1', port, path: pathname, method }, async (response) => {
      try {
        response.setEncoding('utf8');
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, headers: response.headers, body });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('dashboard request timed out')));
  });
}

test('GET /dashboard.css serves only the fixed stylesheet with safe headers', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'zippermerge-wp0-'));
  let dashboard;
  let exited;
  t.after(async () => {
    try {
      if (dashboard) {
        dashboard.kill();
        await exited;
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  dashboard = spawn(process.execPath, [server, '--port', String(port)], {
    env: { ...process.env, CHAT_DIR: scratch, ZM_REPO: scratch, ZM_PR_REPO: '',
      BOARD_CACHE_FILE: path.join(scratch, 'board-cache.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  exited = once(dashboard, 'close');
  const [output] = await Promise.race([
    once(dashboard.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
    exited.then(([code]) => assert.fail(`dashboard exited before listening (${code})`)),
  ]);
  assert.match(String(output), /zippermerge dashboard:/);

  const css = await request(port, '/dashboard.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(css.headers['x-content-type-options'], 'nosniff');
  assert.equal(css.headers['cache-control'], 'no-cache');
  assert.equal(css.body, await readFile(stylesheet, 'utf8'));
  for (const attack of ['/dashboard.css/../server.mjs', '/dashboard.css/%2e%2e/server.mjs']) {
    const response = await request(port, attack);
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'not found' });
  }
  for (const query of ['?x', '?file=../server.mjs']) {
    const response = await request(port, `/dashboard.css${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.body, css.body);
  }
  assert.equal((await request(port, '/dashboard.css', 'POST')).status, 404);
});
