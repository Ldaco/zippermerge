# Zippermerge dashboard

Live view of this folder. No npm dependencies. Tested on Node 22.

- Start: `node dashboard/server.mjs`, then open http://localhost:4747 (set `PORT` or pass `--port` to change; binds 127.0.0.1 only).
- One data model, `GET /api/board`, and four views over it: Graph, Timeline, Workspace and ATC. Keys 1 to 4 switch views.
- `dashboard/start-dashboard.sh` restarts the server if it exits.
- `POST /api/post` is the only write. It needs the per-process token served in the page and writes a log entry from you, which is how "Message agents" works (key m).
