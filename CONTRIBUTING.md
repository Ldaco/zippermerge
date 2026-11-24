# Contributing

Start a branch from current `origin/main`. In your worktree, export `CHAT_DIR`
with the absolute path to the team's shared coordination board. By default,
`chat.sh` uses its own directory. Run `bash chat.sh board` to check the shared
roster, then reserve your paths with `bash chat.sh reserve <slug> <path> "<reason>"`.
When finished, run `bash chat.sh unreserve <slug> <reservation-id>`.
For experiments, use a scratch Git repository and a scratch `CHAT_DIR`.

## Reproduce and test first

1. Reproduce the issue on `origin/main`. Record the commit, steps, expected result, and actual result.
2. Add a focused regression in a new `bin/test/<name>.test.mjs`. Run `node bin/test/<name>.test.mjs` and commit the test by itself. If main already passes, submit the regression alone and report the base commit and passing result.
3. If the baseline fails for the reported reason, make the fix, rerun the same command, and put the failing and passing results in the PR description.

## Run the tests

From the root of a fresh checkout, run `npm ci` to install dependencies, then
`npm run test:install-browser` to install the pinned headless Chromium. See the
[README test setup](README.md#tests).

On a shared machine, acquire the shared board's `full-test-suite` lock before
running `npm test` from the repository root with Node.js 22. Release the lock
when the command finishes, including on failure. The [coordination protocol](CLAUDE.md#commands)
lists the lock, unlock, and reservation commands. Opening or updating a PR runs
`npm test` on GitHub-hosted Ubuntu and Windows (Git Bash). Check both lanes with
`gh pr checks <number>`.

## Review and public-repo hygiene

Fill out the PR template using repo-relative paths. Before publishing a diff,
test output, or screenshot, remove secrets and personal filesystem paths.

Ask an independent reviewer to rerun the regression and inspect the diff in a
fresh checkout of the current PR head. They must submit a GitHub review on
that commit from a login distinct from the author's, with a nonempty review body
or a top-level inline comment.

Fix findings on the same branch and reply in each thread. After a push, ask for
review of the new head. Each thread, including outdated ones, also needs explicit
resolution. Check [PR merge readiness](README.md#pr-merge-readiness) and both CI
lanes, then leave the merge to someone else. Never self-merge.
