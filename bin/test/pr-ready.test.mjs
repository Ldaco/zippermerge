import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPrReady } from '../pr-ready.mjs';

const REPO = 'acme/widgets';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

function connection(nodes, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function review(overrides = {}) {
  return {
    id: 'review', state: 'COMMENTED', body: 'Looks good', commit: { oid: HEAD },
    author: { login: 'reviewer' }, submittedAt: '2026-01-01T00:00:00Z', ...overrides,
  };
}

function thread({ isResolved = true, isOutdated = false, reviewId, replyTo = null } = {}) {
  const nodes = reviewId ? [{ replyTo, pullRequestReview: { id: reviewId } }] : [];
  return { isResolved, isOutdated, comments: { nodes } };
}

function pullRequest(overrides = {}) {
  return {
    state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', headRefOid: HEAD,
    author: { login: 'contributor' }, reviewDecision: null,
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewThreads: connection([]), reviews: connection([review()]), ...overrides,
  };
}

function response(pr, extra = {}) {
  return { ok: true, out: JSON.stringify({ data: { repository: { pullRequest: pr } }, ...extra }) };
}

function temporaryChat(t) {
  const chatRoot = mkdtempSync(path.join(tmpdir(), 'zm-pr-ready-'));
  t.after(() => rmSync(chatRoot, { recursive: true, force: true }));
  return chatRoot;
}

async function run(t, { args = [REPO, '123'], fixture = () => response(pullRequest()), deps, repo = '' } = {}) {
  const chatRoot = temporaryChat(t);
  if (deps !== undefined) writeFileSync(path.join(chatRoot, 'deps.json'), deps);
  const lines = [];
  const errors = [];
  const calls = [];
  const request = (command) => {
    // Capture the actual gh command, including its independent page cursors.
    const fields = Object.fromEntries(command.slice(2).filter((_, i) => i % 2).map((arg) => {
      const separator = arg.indexOf('=');
      return [arg.slice(0, separator), arg.slice(separator + 1)];
    }));
    calls.push({ method: command.slice(0, 2), ...fields });
    return fixture(fields);
  };
  const code = await runPrReady(args, {
    repo, chatRoot, request, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line),
  });
  return { code, lines, errors, calls };
}

test('an empty reply-only review does not count even if its thread is resolved', async (t) => {
  const pr = pullRequest({
    reviews: connection([review({ id: 'old', commit: { oid: OLD_HEAD } }), review({ id: 'reply', body: '  \n ' })]),
    reviewThreads: connection([
      thread({ reviewId: 'old' }),
      thread({ reviewId: 'reply', replyTo: { id: 'original-comment' } }),
    ]),
  });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /^NOT READY acme\/widgets#123 - no real review on current head$/);
});

test('a top-level inline comment qualifies a submitted current-head review with no body', async (t) => {
  const pr = pullRequest({ reviews: connection([review({ body: '' })]), reviewThreads: connection([thread({ reviewId: 'review' })]) });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 0);
  assert.match(lines[0], /^READY acme\/widgets#123 .*realReviews=1 CI=SUCCESS$/);
});

test('a review with a body on an older commit does not count', async (t) => {
  const pr = pullRequest({ reviews: connection([review({ commit: { oid: OLD_HEAD } })]) });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /no real review on current head/);
});

test('a pending review with a body does not count', async (t) => {
  const pr = pullRequest({ reviews: connection([review({ state: 'PENDING' })]) });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /no real review on current head/);
});

test('a dismissed review with a body or an inline comment does not count', async (t) => {
  const pr = pullRequest({
    reviews: connection([review({ state: 'DISMISSED' })]),
    reviewThreads: connection([thread({ reviewId: 'review' })]),
  });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /no real review on current head/);
});

test('a current-head change request blocks even with another reviewer’s approval', async (t) => {
  const requestChanges = review({ id: 'request', state: 'CHANGES_REQUESTED', body: 'This is broken' });
  const approve = review({ id: 'approve', state: 'APPROVED', author: { login: 'other-reviewer' } });
  for (const reviews of [[requestChanges], [approve, requestChanges]]) {
    const { code, lines } = await run(t, { fixture: () => response(pullRequest({ reviews: connection(reviews) })) });
    assert.equal(code, 1);
    assert.match(lines[0], /changes requested by reviewer/);
  }
});

test('a later reply or general comment does not clear a change request', async (t) => {
  const requestChanges = review({ id: 'request', state: 'CHANGES_REQUESTED', body: '' });
  const reply = review({ id: 'reply', body: '', submittedAt: '2026-01-01T00:01:00Z' });
  const comment = review({ id: 'comment', body: 'Replied inline', submittedAt: '2026-01-01T00:02:00Z' });
  const { code, lines } = await run(t, { fixture: () => response(pullRequest({ reviews: connection([reply, requestChanges, comment]) })) });
  assert.equal(code, 1);
  assert.match(lines[0], /changes requested by reviewer/);
});

test('a later approval from the same reviewer clears their current-head change request', async (t) => {
  const requestChanges = review({ id: 'request', state: 'CHANGES_REQUESTED' });
  const approve = review({ id: 'approve', state: 'APPROVED', submittedAt: '2026-01-01T00:01:00Z', author: { login: 'Reviewer' } });
  const { code, lines } = await run(t, { fixture: () => response(pullRequest({ reviews: connection([approve, requestChanges]) })) });
  assert.equal(code, 0);
  assert.match(lines[0], /^READY .*realReviews=1/);
});

test('a GitHub changes-requested decision blocks even with a qualifying review on the current head', async (t) => {
  const { code, lines } = await run(t, { fixture: () => response(pullRequest({ reviewDecision: 'CHANGES_REQUESTED' })) });
  assert.equal(code, 1);
  assert.match(lines[0], /GitHub review decision CHANGES_REQUESTED/);
});

test('self-review with a body or top-level inline comment does not count', async (t) => {
  const author = { login: 'Contributor' };
  const prWithBody = pullRequest({ reviews: connection([review({ author })]) });
  const prWithInlineComment = pullRequest({
    reviews: connection([review({ author, body: '' })]),
    reviewThreads: connection([thread({ reviewId: 'review' })]),
  });
  for (const pr of [prWithBody, prWithInlineComment]) {
    const { code, lines } = await run(t, { fixture: () => response(pr) });
    assert.equal(code, 1);
    assert.match(lines[0], /no real review on current head/);
  }
});

test('a review without an author cannot establish independent review', async (t) => {
  const pr = pullRequest({ reviews: connection([review({ author: null })]) });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /no real review on current head/);
});

test('missing PR authorship fails closed even with a substantive review', async (t) => {
  const { code, lines } = await run(t, { fixture: () => response(pullRequest({ author: null })) });
  assert.equal(code, 1);
  assert.match(lines[0], /PR author/);
});

test('an outdated unresolved thread blocks an otherwise ready PR', async (t) => {
  const pr = pullRequest({ reviewThreads: connection([thread({ isResolved: false, isOutdated: true })]) });
  const { code, lines } = await run(t, { fixture: () => response(pr) });
  assert.equal(code, 1);
  assert.match(lines[0], /1 unresolved review thread/);
});

test('reads both connections beyond 100 and associates a late inline comment with its late review', async (t) => {
  const first = pullRequest({
    reviews: connection(Array.from({ length: 100 }, (_, i) => review({ id: `old-${i}`, commit: { oid: OLD_HEAD } })), 'review-100'),
    reviewThreads: connection(Array.from({ length: 100 }, () => thread()), 'thread-100'),
  });
  const fixture = ({ number, endCursor, query }) => {
    if (endCursor === 'thread-100') {
      assert.match(query, /reviewThreads\(first: 100, after: \$endCursor\)/);
      const lateThread = thread({ reviewId: 'review', isResolved: number === '123', isOutdated: true });
      return response({ headRefOid: HEAD, reviewThreads: connection([lateThread]) });
    }
    if (endCursor === 'review-100') {
      assert.match(query, /reviews\(first: 100, after: \$endCursor\)/);
      return response({ headRefOid: HEAD, reviews: connection([review({ body: '' })]) });
    }
    return response(first);
  };
  const { code, lines, calls } = await run(t, { args: [REPO, '123', '124'], fixture });
  assert.equal(code, 1);
  assert.match(lines[0], /^READY acme\/widgets#123 .*realReviews=1/);
  assert.match(lines[1], /^NOT READY acme\/widgets#124 - 1 unresolved review thread/);
  assert.deepEqual(calls.map(({ endCursor }) => endCursor), [undefined, 'thread-100', 'review-100', undefined, 'thread-100', 'review-100']);
  assert.ok(calls.every(({ method }) => method.join(' ') === 'api graphql'));
});

test('GraphQL errors take precedence over an otherwise ready partial response', async (t) => {
  const { code, lines } = await run(t, { fixture: () => response(pullRequest(), { errors: [{ message: 'API returned partial data' }] }) });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['NOT READY acme/widgets#123 - API returned partial data']);
});

test('reports a rate limit on a later page in one line and continues with the next PR', async (t) => {
  const fixture = ({ number, endCursor }) => {
    if (number === '124') return response(pullRequest());
    if (endCursor) return { ok: false, err: 'gh: API rate limit exceeded\nTry again later' };
    return response(pullRequest({ reviews: connection([review()], 'more') }));
  };
  const { code, lines } = await run(t, { args: [REPO, '123', '124'], fixture });
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    'NOT READY acme/widgets#123 - gh: API rate limit exceeded Try again later',
    'READY acme/widgets#124 head=aaaaaaa realReviews=1 CI=SUCCESS',
  ]);
});

test('fails closed if the head changes while loading another page', async (t) => {
  const fixture = ({ endCursor }) => endCursor
    ? response({ headRefOid: OLD_HEAD, reviews: connection([]) })
    : response(pullRequest({ reviews: connection([review()], 'more') }));
  const { code, lines } = await run(t, { fixture });
  assert.equal(code, 1);
  assert.match(lines[0], /PR head changed/);
});

for (const [label, overrides, reason] of [
  ['draft', { isDraft: true }, 'draft'],
  ['closed', { state: 'CLOSED' }, 'PR state CLOSED'],
  ['dirty', { mergeStateStatus: 'DIRTY' }, 'merge state DIRTY'],
  ['unknown merge state', { mergeStateStatus: 'UNKNOWN' }, 'merge state UNKNOWN'],
  ...['FAILURE', 'PENDING'].map((state) => [
    `CI ${state}`, { commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state } } }] } }, `CI ${state}`,
  ]),
  ['missing CI data', { commits: { nodes: [{ commit: { oid: HEAD } }] } }, 'incomplete CI data'],
  ['CI for an older commit', { commits: { nodes: [{ commit: { oid: OLD_HEAD, statusCheckRollup: null } }] } }, 'no matching head commit'],
]) {
  test(`${label} blocks readiness`, async (t) => {
    const { code, lines } = await run(t, { fixture: () => response(pullRequest(overrides)) });
    assert.equal(code, 1);
    assert.ok(lines[0].includes(reason), lines[0]);
  });
}

test('null CI rollup is allowed and PR numbers can use the configured repository', async (t) => {
  const pr = pullRequest({ commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } });
  const { code, lines, calls } = await run(t, { args: ['123', '124'], repo: REPO, fixture: () => response(pr) });
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'READY acme/widgets#123 head=aaaaaaa realReviews=1 CI=none',
    'READY acme/widgets#124 head=aaaaaaa realReviews=1 CI=none',
  ]);
  assert.deepEqual(calls.map(({ owner, name, number }) => [owner, name, number]), [['acme', 'widgets', '123'], ['acme', 'widgets', '124']]);
});

test('ordering dependencies block until merged, even across repositories', async (t) => {
  const deps = JSON.stringify({ 'Acme/Widgets#123': ['other/base#5'], 'acme/widgets#124': ['other/base#6'] });
  const fixture = ({ owner, name, number, query }) => {
    if (owner !== 'other') return response(pullRequest());
    assert.equal(name, 'base');
    assert.match(query, /\{ merged \}/);
    return response({ merged: number === '6' });
  };
  const { code, lines } = await run(t, { args: [REPO, '123', '124'], deps, fixture });
  assert.equal(code, 1);
  assert.match(lines[0], /^NOT READY .*waits for other\/base#5 to merge$/);
  assert.match(lines[1], /^READY acme\/widgets#124 /);
});

test('invalid dependency data blocks without querying GitHub', async (t) => {
  const { code, lines, calls } = await run(t, { deps: JSON.stringify({ 'acme/widgets#123': 'other/base#5' }) });
  assert.equal(code, 1);
  assert.match(lines[0], /invalid or duplicate dependency entry in deps.json/);
  assert.deepEqual(calls, []);
});

function cliFixture(t) {
  const chatRoot = temporaryChat(t);
  writeFileSync(path.join(chatRoot, 'config.env'), `ZM_PR_REPO=${REPO}\n`);
  const mockedGh = path.join(chatRoot, 'mock-gh.mjs');
  const ready = response(pullRequest()).out;
  const draft = response(pullRequest({ isDraft: true })).out;
  writeFileSync(mockedGh, `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFile = (program, args, options, callback) => {
      if (program !== 'gh' || !args.includes('owner=acme') || !args.includes('name=widgets')) {
        throw new Error('Unexpected command: ' + program + ' ' + args.join(' '));
      }
      callback(null, args.includes('number=124') ? ${JSON.stringify(draft)} : ${JSON.stringify(ready)}, '');
    };
    syncBuiltinESMExports();
  `);
  const cli = fileURLToPath(new URL('../pr-ready.mjs', import.meta.url));
  const env = { ...process.env, CHAT_DIR: chatRoot };
  delete env.ZM_PR_REPO;
  const launch = (entry, ...args) => spawnSync(process.execPath, ['--import', pathToFileURL(mockedGh).href, entry, ...args], { encoding: 'utf8', env });
  return { chatRoot, cli, launch };
}

test('the CLI exits 0, 1 or 2 and reads config.env when the repo is omitted', (t) => {
  const { cli, launch } = cliFixture(t);
  const readyRun = launch(cli, '123');
  assert.equal(readyRun.status, 0, readyRun.stderr);
  assert.match(readyRun.stdout, /^READY acme\/widgets#123 /);
  const mixedRun = launch(cli, REPO, '123', '124');
  assert.equal(mixedRun.status, 1, mixedRun.stderr);
  assert.match(mixedRun.stdout, /\nNOT READY acme\/widgets#124 - draft/);
  const usageRun = launch(cli, REPO, 'invalid');
  assert.equal(usageRun.status, 2, usageRun.stderr);
  assert.equal(usageRun.stdout, '');
  assert.match(usageRun.stderr, /^Usage:/);
});

test('the CLI reports a verdict and exits nonzero through a symlinked directory', (t) => {
  const { chatRoot, cli, launch } = cliFixture(t);
  const alias = path.join(chatRoot, 'bin-alias');
  symlinkSync(path.dirname(cli), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runThroughAlias = launch(path.join(alias, path.basename(cli)), '124');
  assert.equal(runThroughAlias.status, 1, runThroughAlias.stderr);
  assert.match(runThroughAlias.stdout, /^NOT READY acme\/widgets#124 - draft/);
});
