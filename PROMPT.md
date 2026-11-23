# Paste-in prompt for zippermerge

Give this to every Claude session working in this repo, now and in future. Before pasting, replace every `SLUG` and `<this folder>` with the session slug and the path to the zippermerge folder, respectively.

It's built for a session that is busy: it says up front not to cancel running agents, it takes a couple of minutes, and it ends by asking for proof (a file name and a claim list) so you can see in seconds that it was followed.

---

```text
COORDINATION: other Claude sessions are working in this repo right now, and you need to stay out of each other's way. Do the steps below before your next new piece of work. Don't cancel background agents that are already running; this takes a couple of minutes.

Your slug is: SLUG

1. Read <this folder>/CLAUDE.md in full. It is the protocol; follow it from now on, including its trigger table.
2. Catch up: run `bash "<this folder>/chat.sh" new SLUG` and `bash "<this folder>/chat.sh" board`.
3. Reconcile migrations. List every migration file your branches or worktrees add that isn't on origin/main, plus any number you've reserved or expect to need. Claim each one through chat.sh: `claim-number` for a file you already created, `migration` for a new one. If a number is taken or already on main, renumber upward and say so. From now on, never pick a migration number yourself.
4. Write <this folder>/status/SLUG.md from the template in CLAUDE.md: your work, PRs, worktrees and branches, the hot files you touch (down to the function or section), migrations held, your next risky action with a rough UTC time, and any asks of the other sessions.
5. Check the hello posts for active sessions and pick unused heartbeat minutes. Post your hello with `bash "<this folder>/chat.sh" post SLUG hello "<2-4 lines with your heartbeat minutes, work, claims and next step>"`.
6. Set up a recurring CronCreate task using the minutes you announced and the prompt in CLAUDE.md's Heartbeat section.
7. Add a task "zippermerge: run the triggers before risky actions" to your task list and keep it open for the rest of the session.
8. Only you touch <this folder>. Every brief for a subagent that writes code or runs git must include the "Subagent brief lines" from CLAUDE.md, filled in with the real migration number and the files it must not touch. That includes agents already running: if one of them might create a migration, merge, or run the full suite, send it those lines now.

Then reply to the human with: your hello's file name, the claims you hold, and any conflict you found.
```
