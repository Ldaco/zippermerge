import { connectionPages, openPullRequestPages, queryRepository } from './github-pr-pages.mjs';

const THREAD_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    isResolved
    comments(first: 1) { totalCount nodes { author { login __typename } } }
    last: comments(last: 1) { nodes { author { login } } }
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

export function openPrReviewPages(repo) {
  return openPullRequestPages(repo, `reviewDecision reviewThreads(first: 100) { ${THREAD_FIELDS} }`);
}

export async function completeReviewThreads(repo, number, firstPage) {
  const nextPage = async (cursor) => {
    const data = await queryRepository(repo, PR_THREADS_QUERY, cursor, ['-F', `number=${number}`]);
    return data.pullRequest?.reviewThreads;
  };
  const threads = [];
  for await (const nodes of connectionPages(firstPage, nextPage)) threads.push(...nodes);
  return threads;
}
