import { execFile } from 'node:child_process';

export const PR_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const RATE_LIMIT_RE = /rate[ -]limit|\bHTTP (?:403|429)\b|secondary|abuse/i;

function splitResponse(stdout) {
  const status = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n/.exec(stdout);
  const boundary = status && /\r?\n\r?\n/.exec(stdout);
  const headers = new Map();
  if (!boundary) return { status: 0, headers, body: stdout };
  for (const line of stdout.slice(status[0].length, boundary.index).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body: stdout.slice(boundary.index + boundary[0].length) };
}

function rateLimitDeadline(headers) {
  const now = Date.now();
  const retryAfter = headers.get('retry-after') || '';
  const retry = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const reset = headers.get('x-ratelimit-remaining') === '0' ? Number(headers.get('x-ratelimit-reset')) * 1000 : 0;
  return Math.max(now + PR_RATE_LIMIT_BACKOFF_MS,
    Number.isSafeInteger(retry) ? retry : 0, Number.isSafeInteger(reset) ? reset : 0);
}

// gh --include prints response headers even when the request fails or uses --jq.
export function requestPrApi(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('gh', [...args, '--include'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      const { status, headers, body } = splitResponse(String(stdout || ''));
      const ok = !err && status < 400;
      const message = String(stderr || err?.message || (status >= 400 ? `HTTP ${status}` : ''));
      const limited = !ok && (status === 403 || status === 429 || RATE_LIMIT_RE.test(message));
      resolve({ ok, out: body, err: message, rateLimitUntil: limited ? rateLimitDeadline(headers) : 0 });
    });
  });
}

export async function queryRepository(repo, query, cursor, fields = [], request = requestPrApi) {
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
