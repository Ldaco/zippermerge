# Zippermerge

Run several coding agents in one repo without them colliding, and see how they are talking to each other.

When three or four agents work at once, they claim the same database migration number, edit the same files, and fight over the test suite. Asking them to be careful doesn't hold up. Zippermerge gives them one shared place to talk and claim things, enforces the rules in git, and shows you all of it on a dashboard.

## What it does

- **Migration numbers:** an agent claims its number, and two agents can't get the same one. A commit using a number it didn't claim is blocked.
- **Commit checks in git:** the check runs as a `pre-commit` hook and reads what's really staged, so it applies whichever shell or tool made the commit.
- **Conflicts before merge:** trial merges compare each agent's work against the others and the base branch, including uncommitted edits to tracked files.
- **Real conversations:** messages have a sender, recipients and a thread. A question stays open until someone replies to it, and each message records who has received it.
- **Taking turns:** locks and reservations, plus `zm run`, which queues heavy commands such as a full test suite and records the wait.
- **Scope:** give an agent the paths it owns, and committing outside them raises a flag.
- **Dashboard:** Conversation, Timeline, Graph and Work views, with one alert count, and a way to send notes to your agents.

## Quick start

You need Node 22.18 or newer and Git 2.38 or newer. It's written in TypeScript and Node runs it directly, so there is nothing to install or build.

From your repo:

```bash
alias zm="node /path/to/zippermerge/bin/zm.ts"
zm init --migrations db/migrations --human yourname
zm hooks
zm ui
```

`zm ui` prints a dashboard link. That link holds the key for sending notes, so open the dashboard from it.

Give each agent a worktree and a name:

```bash
git worktree add ../wt-fed -b work/fed
cd ../wt-fed
zm join fed --role "Front end" --owns "web/**,docs/**"
```

Then tell the agent how to work with the others. These are the commands it needs:

| Command | What it does |
|---|---|
| `zm inbox` | Reads new messages, in full |
| `zm send --to engine "text"` | Sends a note. `--to` takes a name, a comma list or `all` |
| `zm send --to engine --kind ask "question"` | Asks a question that needs an answer |
| `zm reply <id> "answer"` | Answers it. Only this closes a question |
| `zm ack <id>` | Says the message has been read and taken into account |
| `zm claim <slug>` | Claims the next migration number and gives the file path |
| `zm reserve "docs/**" --exclusive` | Holds files. `zm unreserve` lets them go |
| `zm lock <name>`, `zm unlock <name>` | Takes and releases a lock |
| `zm run --lock test-suite -- <command>` | Runs a heavy command, waiting its turn |
| `zm status` | Shows conflicts and anything else that needs attention |

Everything lives in `.git/zippermerge`, shared by all worktrees. It is plain JSON you can open and read, and agents keep working if the dashboard stops.

Messages are information. Nothing in a message approves anything for an agent, including a note from you.

## Limits

This is an early version.

- Agents have to run `zm inbox` themselves. Nothing pushes messages to them yet, so a note waits until they next check.
- `git commit --no-verify` skips the commit check. A colliding migration number still shows red on the dashboard.
- Trial merges don't see new files that haven't been staged.
- Merges made on GitHub fire no local hook.
- It has only been run on Windows so far.
- Run it from a checkout. Node won't run TypeScript from inside `node_modules`, so it can't be installed as an npm package yet.
- The dashboard relies on Node's `stripTypeScriptTypes`, which is still experimental, so `zm ui` prints one warning about it.

## Tests

```bash
npm test
```

Type checking needs the dev dependencies:

```bash
npm install
npm run typecheck
```
