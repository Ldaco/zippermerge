# board.mergeQueue contract (served in GET /api/board)

The server synthesizes this; views only render it. All fields always present (empty arrays when unknown).

```jsonc
"mergeQueue": {
  "generatedAt": "ISO",            // when this block was built
  "nudgeAt": "ISO|null",           // age of the per-PR readiness data (state/pr-nudge.json)
  "mergedFetchedAt": "ISO|null",   // age of the merged-today list
  "plan": { "updatedAt": "ISO|null", "updatedBy": "chat", "note": "string" },
  "runway": {                      // who is merging right now = holder of locks/main-freeze.md
    "held": true, "owner": "fed", "since": "ISO", "why": "squash #101 ...", "prs": [101, 102]   // PR numbers named in why
  },
  "merged": [                      // merged since 00:00 UTC today, newest first, any base
    { "number": 2768, "title": "...", "owner": "fed|null", "base": "main", "mergedAt": "ISO", "mergedBy": "login", "url": "https://github.com/..." }
  ],
  "queue": [                       // open PRs in planned landing order (position 1 = next)
    {
      "position": 1, "number": 101, "title": "...", "owner": "fed", "base": "main", "head": "feat/style-restyle",
      "url": "https://github.com/...",
      "status": "landing|ready|ci|needs-work|stacked|held",
      //   landing    = named in the current main-freeze reason and owned by its holder
      //   ready      = no conflicts, CI not failing, every thread answered
      //   ci         = CI running or GitHub still computing mergeability
      //   needs-work = conflicts, failing CI, unanswered threads, draft
      //   stacked    = base is another open PR's head branch (lands after it)
      //   held       = explicit hold (e.g. draft integration base, unowned)
      "blockers": ["string"],      // human-readable, may be empty
      "phase": "1 · Small PRs into main | null",
      "stackedOn": 2805,           // number of the open PR whose head is this PR's base, else null
      "riders": [103, 104]       // only on a PR that others ride with (e.g. #200); else []
    }
  ],
  "riding": [                      // PRs that land as part of another PR (not separate merges)
    { "number": 103, "title": "...", "owner": "fed", "with": 2800 }
  ],
  "counts": { "mergedToday": 7, "mergedToMainToday": 6, "queue": 9, "ready": 2, "landing": 1, "riding": 23 }
}
```

Ordering: PRs named in the plan (state/merge-plan.json phases[].prs) come first in plan order; any other open PR follows, sorted landing, ready, ci, needs-work, stacked, held, then by number. The queue evaluates `state/pr-holds.json` against the current PR owner and base branch. A PR with an active hold containing "via #NNNN" goes into `riding` and is listed in that PR's `riders`.

## Pre-merge verdict

From the Zippermerge checkout, run `node bin/pr-ready.mjs owner/repo 123` for a live GitHub verdict on a queue entry. Pass multiple PR numbers to check them together, or omit `owner/repo` when `ZM_PR_REPO` is configured. The command reports `READY` only for an open, non-draft PR with a submitted review on the current head that has a non-empty body or a top-level inline comment, zero unresolved threads including outdated threads, `CLEAN` merge state, successful or absent CI, and merged dependencies from the optional `deps.json`. `NOT READY` includes the blockers or the reason GitHub data could not be verified.
