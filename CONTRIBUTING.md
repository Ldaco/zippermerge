# Contributing

Start a branch from current `origin/main` and reserve the paths you will edit with
`bash chat.sh reserve <slug> <path> "<reason>"`. Use a scratch `CHAT_DIR` and
scratch Git repositories when testing coordination behavior.

## Reproduce and test first

1. Reproduce the issue on `origin/main`. Record the commit, steps, expected result, and actual result.
2. Add a focused regression in a new `bin/test/<name>.test.mjs`. Run `node bin/test/<name>.test.mjs`, confirm it fails for the reported reason, and commit the test by itself. If main already passes, record that result and commit the passing regression.
3. Make the fix, rerun the same command, and put both results in the PR description.

## Run the tests

With Node.js 22, run `npm test` from the repository root for the full suite. On a
shared machine, follow the board's `full-test-suite` lock protocol. Opening a PR
or pushing an update triggers the same command on GitHub-hosted Ubuntu and
Windows (Git Bash). Check both lanes with `gh pr checks <number>`.

## Review and public-repo hygiene

Fill out the PR template using repo-relative paths. Before publishing a diff,
test output, or screenshot, remove secrets and personal filesystem paths.

Ask an independent reviewer who did not write the change to validate the current
PR head from a fresh checkout, rerun the regression, and review the diff. Address
each finding on the same branch and reply in its thread. Once both CI lanes pass
and review is complete, leave the merge to someone else. Never self-merge.
