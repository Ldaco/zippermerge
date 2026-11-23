import { execFile } from 'node:child_process';

const THREAD_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    isResolved
    comments(first: 1) { totalCount nodes { author { login __typename } } }
    last: comments(last: 1) { nodes { author { login } } }
  }
`;
const OPEN_PR_QUERY = `
  query ($owner: String!, $name: String!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: 60, after: $endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes { number reviewDecision reviewThreads(first: 100) { ${THREAD_FIELDS} } }
      }
    }
  }
`;
const PR_THREADS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $endCursor) { ${THREAD_FIELDS} }
      }
    }
  }
`;

async function queryRepository(repo, query, cursor, fields = []) {
  const [owner, name] = repo.split('/');
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...fields];
  if (cursor) args.push('-f', `endCursor=${cursor}`);
  const out = await new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
  const { data, errors } = JSON.parse(out);
  if (errors?.length || !data?.repository) throw new Error(errors?.[0]?.message || 'missing GitHub repository data');
  return data.repository;
}

async function* pages(firstPage, nextPage) {
  const cursors = new Set();
  let page = firstPage;
  while (true) {
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean' || page.nodes.some((node) => !node)) {
      throw new Error('incomplete GitHub review page');
    }
    yield page.nodes;
    if (!page.pageInfo.hasNextPage) return;
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('invalid GitHub review cursor');
    cursors.add(cursor);
    page = await nextPage(cursor);
  }
}

export async function* openPrReviewPages(repo) {
  const fetch = async (cursor) => (await queryRepository(repo, OPEN_PR_QUERY, cursor)).pullRequests;
  yield* pages(await fetch(null), fetch);
}

export async function completeReviewThreads(repo, number, firstPage) {
  const nextPage = async (cursor) => {
    const data = await queryRepository(repo, PR_THREADS_QUERY, cursor, ['-F', `number=${number}`]);
    return data.pullRequest?.reviewThreads;
  };
  const threads = [];
  for await (const nodes of pages(firstPage, nextPage)) threads.push(...nodes);
  return threads;
}
