#!/usr/bin/env node
// Who wrote the unresolved review threads on open PRs: bots (authors may resolve once addressed) vs people.
import { execFileSync } from 'node:child_process';
import { PR_REPO } from './config.mjs';

if (!PR_REPO) { console.log('No GitHub repo configured (ZM_PR_REPO).'); process.exit(0); }
const [OWNER, NAME] = PR_REPO.split('/');

const Q = `query{repository(owner:"${OWNER}",name:"${NAME}"){pullRequests(states:OPEN,first:60){nodes{number reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{login __typename}}}}}}}}}`;
const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${Q}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const prs = JSON.parse(out).data.repository.pullRequests.nodes;
const byAuthor = {};
const perPr = [];
for (const p of prs) {
  const open = p.reviewThreads.nodes.filter((t) => !t.isResolved);
  if (!open.length) continue;
  const who = {};
  for (const t of open) {
    const a = t.comments.nodes[0] && t.comments.nodes[0].author;
    const k = a ? `${a.login}${a.__typename === 'Bot' ? ' (bot)' : ''}` : '(deleted)';
    who[k] = (who[k] || 0) + 1;
    byAuthor[k] = (byAuthor[k] || 0) + 1;
  }
  perPr.push(`#${p.number}: ${Object.entries(who).map(([k, v]) => `${k} x${v}`).join(', ')}`);
}
console.log('unresolved threads by author:', JSON.stringify(byAuthor));
console.log(perPr.join('\n'));
