#!/usr/bin/env bash
# Invoke capture.mjs exactly the way settings.json invokes the live hook (absolute path, flags),
# against a scratch CHAT_DIR, and confirm it actually runs: it should learn an identity file.
set -u
scratch="$(mktemp -d)"
mkdir -p "$scratch/status"
printf '# fed (FED Work)\n' > "$scratch/status/fed.md"
payload='{"session_id":"livecheck123","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"bash chat.sh new fed"},"cwd":"."}'
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for p in "$here/capture.mjs"; do
  rm -rf "$scratch/identity"
  printf '%s' "$payload" | CHAT_DIR="$scratch" node "$p" --record-only
  rc=$?
  if [ -f "$scratch/identity/livecheck123.json" ]; then echo "ran ok (exit $rc): $p"; else echo "DID NOT RUN (exit $rc): $p"; fi
done
rm -rf "$scratch"
