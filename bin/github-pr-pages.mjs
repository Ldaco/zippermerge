import { execFile } from 'node:child_process';

function requestGraphql(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: String(stderr || err?.message || '') });
    });
  });
}

export async function queryRepository(repo, query, cursor, fields = [], request = requestGraphql) {
  const [owner, name] = repo.split('/');
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...fields];
  if (cursor) args.push('-f', `endCursor=${cursor}`);
  const { ok, out, err } = await request(args);
  if (!ok) throw new Error(err.trim());
  const { data, errors } = JSON.parse(out);
  if (errors?.length || !data?.repository) throw new Error(errors?.[0]?.message || 'missing GitHub repository data');
  return data.repository;
}

export async function* connectionPages(firstPage, nextPage) {
  const cursors = new Set();
  let page = firstPage;
  while (true) {
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean' || page.nodes.some((node) => !node)) {
      throw new Error('incomplete GitHub connection page');
    }
    yield page.nodes;
    if (!page.pageInfo.hasNextPage) return;
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('invalid GitHub connection cursor');
    cursors.add(cursor);
    page = await nextPage(cursor);
  }
}

// Use creation order so activity on a PR cannot move it across the cursor.
export async function* openPullRequestPages(repo, fields, request) {
  const query = `
    query ($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 60, after: $endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes { number ${fields} }
        }
      }
    }
  `;
  const fetchPage = async (cursor) => (await queryRepository(repo, query, cursor, [], request)).pullRequests;
  const seen = new Set();
  for await (const nodes of connectionPages(await fetchPage(null), fetchPage)) {
    for (const p of nodes) {
      if (!Number.isSafeInteger(p.number) || seen.has(p.number)) throw new Error('invalid open PR list from GitHub');
      seen.add(p.number);
    }
    yield nodes;
  }
}
