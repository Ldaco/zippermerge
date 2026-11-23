# Zippermerge

Run several coding agents in one repo without them colliding, and see how they are talking to each other.

When three or four agents work at once, they take the same database migration number, edit the same files and fight over the test suite. Zippermerge gives them one shared folder to coordinate through, checks their commits against it, and shows you all of it live.

## What it does

- **Migration numbers:** an agent claims the next free number with `chat.sh migration`. The claim is an atomic file create, so two agents can't get the same one. It also checks the highest number on `origin/main`.
- **Commit guard:** blocks a commit with an unclaimed migration number, one claimed by someone else, or one at or below main's highest. Also blocks commits on main during a `main-freeze`, and files under someone else's exclusive reservation.
- **Locks and reservations:** `full-test-suite` and `main-freeze` locks, plus shared or exclusive reservations on file patterns that expire on their own.
- **Conflicts before merge:** the dashboard trial-merges every pair of active branches, and each branch against main, with `git merge-tree`. That writes no refs and touches no worktree.
- **Conversation:** a log of hellos, asks, alerts and replies. An ask stays open until someone answers it, and you can message the agents from the dashboard.
- **Activity:** a Claude Code hook records each session's edits, commands and subagents, and warns an agent when someone else just edited the same file.
- **Merge queue:** with a GitHub repo set, works out which PR is ready and what lands next.
- **Dashboard:** four views of one board. Graph, Timeline, Workspace and ATC.

## Setup

You need Node 22, Git 2.38 or newer and bash (Git Bash on Windows). Lock commands use `flock` or Perl, which ships with Git Bash. There is nothing to install or build for the project itself.

1. Clone this somewhere outside the repo you want to coordinate. That folder holds the code and the shared data.
2. Copy `config.env.example` to `config.env` and fill it in.
3. Merge `hooks.example.json` into your repo's `.claude/settings.json`, with the paths changed to where you cloned this. Stay on the same machine: the folder is the shared state.
4. Start the dashboard and open http://localhost:4747:

   ```bash
   node dashboard/server.mjs
   ```

5. Paste `PROMPT.md` into each agent with its slug filled in. It points them at `CLAUDE.md`, the protocol they follow from then on.

## Commands

`bash chat.sh help` lists them all. The ones agents use most:

```bash
bash chat.sh new <slug>                            # what others posted since you last looked
bash chat.sh board                                 # every status, held locks, latest claims
bash chat.sh post <slug> <kind> "<text>"           # post to the log
bash chat.sh migration <slug> <name> "<ref>"       # claim the next migration number
bash chat.sh lock <name> <slug> "<why>"            # take full-test-suite or main-freeze
bash chat.sh reserve <slug> <pattern> "<why>"      # reserve files
bash chat.sh guard --slug <slug>                   # run the commit checks by hand
```

## PR merge readiness

Authenticate the GitHub CLI (`gh`) to check one or more PRs.

```bash
node bin/pr-ready.mjs owner/repo 123 124
node bin/pr-ready.mjs 123 124  # uses ZM_PR_REPO from the environment or config.env
node bin/pr-ready.mjs --require-ci owner/repo 123
```

The command prints one `READY` or `NOT READY` line per PR, with blockers for each `NOT READY` verdict. It exits `0` when all PRs are ready, `1` when any PR is blocked or cannot be checked, and `2` for invalid usage. The command is read-only.

A PR must be open, out of draft, and have a clean GitHub merge state. It needs a submitted review from an independent reviewer on the current head with a non-empty body or a top-level inline comment. Empty reply reviews, self-reviews, and dismissed reviews do not count. An active change request blocks readiness across pushes, and GitHub's `CHANGES_REQUESTED` decision also blocks readiness. All review threads, including outdated ones, must be resolved. GitHub errors, including rate limits and partial GraphQL responses, block readiness.

By default, the CLI accepts successful CI or an absent check rollup (`CI=none`). Use `--require-ci` if the repository expects checks. This requires a `SUCCESS` rollup and blocks readiness while GitHub registers checks for a new head.

To enforce landing order, add an optional `deps.json` alongside `config.env` in the coordination folder (`CHAT_DIR` if set). Keys and dependencies are fully qualified PR references. For example, `{"owner/repo#124": ["owner/repo#123"]}` makes #124 wait for #123 to merge.

## Known limits

- The guard runs as a Claude Code hook, not a git hook, so a `git commit` typed in a terminal isn't checked.
- The guard runs before the command, so in `git add x && git commit` it doesn't see `x`. Stage first, then commit in a separate command.
- The guard checks staged files. If a higher migration number lands first and a branch rebases with nothing staged, only the dashboard flags it.
- Conflict checks only cover worktrees an agent lists under `Worktrees/branches` in its status file.
- Coordination assumes one machine, because agents share a folder on disk.

## Tests

```bash
npm test
```

### Continuous integration

GitHub Actions runs `npm test` with Node 22 on hosted Ubuntu and Windows runners for every pull request and every push to `main`. The Windows job uses Git Bash to cover Windows path handling.
