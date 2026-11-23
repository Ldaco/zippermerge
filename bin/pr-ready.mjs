#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalPath, CHAT_ROOT, PR_REPO } from './config.mjs';
import { connectionPages, queryRepository } from './github-pr-pages.mjs';

const REPO_NAME = /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i;
const USAGE = 'Usage: node bin/pr-ready.mjs [owner/repo] <pr> [<pr>...]';

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const THREADS = `
  ${PAGE_INFO}
  nodes {
    isResolved
    comments(first: 1) { nodes { replyTo { id } pullRequestReview { id } } }
  }
`;
const REVIEWS = `
  ${PAGE_INFO}
  nodes { id state body commit { oid } }
`;

function pullRequestQuery(fields, paginated = false) {
  return `
    query ($owner: String!, $name: String!, $number: Int!${paginated ? ', $endCursor: String' : ''}) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { ${fields} }
      }
    }
  `;
}

const READINESS_QUERY = pullRequestQuery(`
  state isDraft mergeStateStatus headRefOid
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  reviewThreads(first: 100) { ${THREADS} }
  reviews(first: 100) { ${REVIEWS} }
`);
const THREADS_QUERY = pullRequestQuery(`headRefOid reviewThreads(first: 100, after: $endCursor) { ${THREADS} }`, true);
const REVIEWS_QUERY = pullRequestQuery(`headRefOid reviews(first: 100, after: $endCursor) { ${REVIEWS} }`, true);
const MERGED_QUERY = pullRequestQuery('merged');

function isPrNumber(value) {
  return /^[1-9][0-9]*$/.test(value) && Number(value) <= 2147483647;
}

function isPrRef(value) {
  if (typeof value !== 'string') return false;
  const [repo, number, extra] = value.split('#');
  return REPO_NAME.test(repo) && isPrNumber(number) && extra === undefined;
}

function readDependencies(chatRoot) {
  let data;
  try {
    data = JSON.parse(readFileSync(path.join(chatRoot, 'deps.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`cannot read deps.json: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('deps.json must be an object mapping PRs to arrays of dependencies');
  }
  const dependencies = new Map();
  for (const [pr, required] of Object.entries(data)) {
    const key = pr.toLowerCase();
    if (!isPrRef(pr) || !Array.isArray(required) || !required.every(isPrRef) || dependencies.has(key)) {
      throw new Error(`invalid or duplicate dependency entry in deps.json for ${pr}`);
    }
    dependencies.set(key, required);
  }
  return dependencies;
}

async function fetchPullRequest(repo, number, query, cursor, request) {
  const data = await queryRepository(repo, query, cursor, ['-F', `number=${number}`], request);
  if (!data.pullRequest) throw new Error(`GitHub returned no pull request for ${repo}#${number}`);
  return data.pullRequest;
}

async function checkReadiness(repo, number, dependencies, request) {
  const fetchPage = (query, cursor) => fetchPullRequest(repo, number, query, cursor, request);
  const pr = await fetchPage(READINESS_QUERY);
  const head = pr.headRefOid;
  const commit = pr.commits?.nodes?.[0]?.commit;
  if (!head || commit?.oid !== head) throw new Error('GitHub returned no matching head commit for CI');
  const rollup = commit.statusCheckRollup;
  if (rollup !== null && typeof rollup?.state !== 'string') {
    throw new Error('GitHub returned incomplete CI data');
  }
  const ci = rollup?.state ?? 'none';

  function pages(field, query) {
    return connectionPages(pr[field], async (cursor) => {
      const page = await fetchPage(query, cursor);
      if (page.headRefOid !== head) throw new Error('PR head changed while reading GitHub data; rerun the check');
      return page[field];
    });
  }

  // Each thread starts with its top-level comment. Associate that comment with
  // its review ID so a separate review created for a reply gets no credit.
  let unresolved = 0;
  const inlineReviews = new Set();
  for await (const threads of pages('reviewThreads', THREADS_QUERY)) {
    for (const thread of threads) {
      if (typeof thread.isResolved !== 'boolean') throw new Error('GitHub returned incomplete review thread data');
      if (!thread.isResolved) unresolved++;
      const root = thread.comments?.nodes?.[0];
      if (root?.replyTo === null && root.pullRequestReview?.id) inlineReviews.add(root.pullRequestReview.id);
    }
  }

  let realReviews = 0;
  for await (const reviews of pages('reviews', REVIEWS_QUERY)) {
    for (const review of reviews) {
      if (review.commit?.oid !== head || review.state === 'PENDING') continue;
      if (review.body.trim() || inlineReviews.has(review.id)) realReviews++;
    }
  }

  const reasons = [];
  if (pr.state !== 'OPEN') reasons.push(`PR state ${pr.state ?? 'unknown'}`);
  if (pr.isDraft !== false) reasons.push(pr.isDraft === true ? 'draft' : 'draft status unknown');
  if (!realReviews) reasons.push('no real review on current head');
  if (unresolved) reasons.push(`${unresolved} unresolved review thread(s), including outdated threads`);
  if (pr.mergeStateStatus !== 'CLEAN') reasons.push(`merge state ${pr.mergeStateStatus ?? 'unknown'}`);
  if (rollup !== null && ci !== 'SUCCESS') reasons.push(`CI ${ci}`);
  for (const dependency of dependencies) {
    const [dependencyRepo, dependencyNumber] = dependency.split('#');
    const required = await fetchPullRequest(dependencyRepo, dependencyNumber, MERGED_QUERY, null, request);
    if (required.merged !== true) reasons.push(`waits for ${dependency} to merge`);
  }
  return { head, ci, realReviews, reasons };
}

export async function runPrReady(args, {
  repo = PR_REPO, chatRoot = CHAT_ROOT, request, stdout = console.log, stderr = console.error,
} = {}) {
  const [first, ...rest] = args;
  const explicitRepo = first?.includes('/');
  const target = explicitRepo ? first : repo;
  const numbers = explicitRepo ? rest : args;
  if (!REPO_NAME.test(target) || !numbers.length || !numbers.every(isPrNumber)) {
    stderr(`${USAGE}\nUse ZM_PR_REPO to supply the default repository.`);
    return 2;
  }

  let dependencies;
  let configError;
  try {
    dependencies = readDependencies(chatRoot);
  } catch (error) {
    configError = error;
  }

  let exitCode = 0;
  for (const number of numbers) {
    const ref = `${target}#${number}`;
    try {
      if (configError) throw configError;
      const deps = dependencies.get(ref.toLowerCase()) ?? [];
      const { head, ci, realReviews, reasons } = await checkReadiness(target, number, deps, request);
      if (reasons.length) {
        stdout(`NOT READY ${ref} - ${reasons.join('; ')}`);
        exitCode = 1;
      } else {
        stdout(`READY ${ref} head=${head.slice(0, 7)} realReviews=${realReviews} CI=${ci}`);
      }
    } catch (error) {
      const reason = error.message.replace(/\s+/g, ' ').trim();
      stdout(`NOT READY ${ref} - ${reason || 'GitHub check failed'}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && !path.relative(canonicalPath(import.meta.filename), canonicalPath(process.argv[1]))) {
  process.exitCode = await runPrReady(process.argv.slice(2));
}
