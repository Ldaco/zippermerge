#!/usr/bin/env node
// Who wrote the unresolved review threads on open PRs: bots (authors may resolve once addressed) vs people.
import { PR_REPO } from './config.mjs';
import { completeReviewThreads, openPrReviewPages } from './pr-review-pages.mjs';

if (!PR_REPO) { console.log('No GitHub repo configured (ZM_PR_REPO).'); process.exit(0); }

const byAuthor = {};
const perPr = [];
try {
  for await (const prs of openPrReviewPages(PR_REPO)) {
    for (const p of prs) {
      const threads = await completeReviewThreads(PR_REPO, p.number, p.reviewThreads);
      const open = threads.filter((t) => !t.isResolved);
      if (!open.length) continue;
      const who = {};
      for (const t of open) {
        const a = t.comments.nodes[0]?.author;
        const k = a ? `${a.login}${a.__typename === 'Bot' ? ' (bot)' : ''}` : '(deleted)';
        who[k] = (who[k] || 0) + 1;
        byAuthor[k] = (byAuthor[k] || 0) + 1;
      }
      perPr.push(`#${p.number}: ${Object.entries(who).map(([k, v]) => `${k} x${v}`).join(', ')}`);
    }
  }
} catch (err) {
  console.error(`pr-thread-authors: incomplete review data (${err.message})`);
  process.exit(1);
}
console.log('unresolved threads by author:', JSON.stringify(byAuthor));
console.log(perPr.join('\n'));
