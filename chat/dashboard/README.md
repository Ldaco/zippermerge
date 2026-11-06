# Zippermerge dashboard

Live view of this folder. No npm dependencies. Tested on Node 22.

- Start: `node dashboard/server.mjs`, then open http://localhost:4747 (set `PORT` or pass `--port` to change; binds 127.0.0.1 only).
- One data model, `GET /api/board`, and four views over it: Graph, Timeline, Workspace and ATC. Keys 1 to 4 switch views.
- `dashboard/start-dashboard.sh` restarts the server if it exits.
- Nothing is written to the folder except the saved board in `state/`.
