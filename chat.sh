#!/usr/bin/env bash
# chat.sh: helper for the coordination protocol (see CLAUDE.md).
# The ONLY supported way to post log entries, claim migration numbers and take locks.
# Usage: bash <this folder>/chat.sh <command> ...    (bash chat.sh help)
set -euo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
D=${CHAT_DIR:-$HERE}
# config.env sets ZM_REPO, ZM_MIG_DIR, ZM_HUMAN and ZM_PR_REPO for this project.
# Keep the assignment syntax in sync with bin/config.mjs.
load_config() {
  local line key value first=1 assignment='^[[:space:]]*(ZM_[A-Z_]+)=(.*)$'
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$first" -eq 1 ]; then line=${line#$'\xef\xbb\xbf'}; first=0; fi
    if [[ ! "$line" =~ $assignment ]]; then continue; fi
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
    if [ -n "${!key+x}" ]; then continue; fi
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    case $value in \"*\"|\'*\') value=${value:1:${#value}-2} ;; esac
    export "$key=$value"
  done < "$1"
}
if [ -f "$D/config.env" ]; then load_config "$D/config.env"; fi
REPO=${ZM_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
MIG_DIR=${ZM_MIG_DIR:-migrations}
MIG_DIR=${MIG_DIR//\\//}
while [[ "$MIG_DIR" == */ ]]; do MIG_DIR=${MIG_DIR%/}; done
HUMAN=${ZM_HUMAN:-human}
LOCK_NAMES="full-test-suite main-freeze"
KINDS="hello status claim release lock unlock ask alert done note reply"
BREAK_AFTER_MIN=60
RESERVE_DEFAULT_TTL=60
RESERVE_MAX_TTL=480
MIGRATION_MAX=999999
CLAIM_MAX_GAP=50

stamp() { date -u +%Y%m%dT%H%M%SZ; }
iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
status_mtime() {
  # Older BSD date accepts only epoch seconds with -r.
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    TZ=UTC0 stat -L -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$1"
}
die()   { echo "chat.sh: $*" >&2; exit 1; }
need()  { if [ "$1" -lt "$2" ]; then die "missing arguments (run: chat.sh help)"; fi; }

single_line() {
  local value=${1//$'\r\n'/ }
  value=${value//$'\r'/ }
  printf '%s' "${value//$'\n'/ }"
}

# Atomic exclusive create: succeeds only if the file did not already exist
# (bash noclobber opens with O_EXCL, which MSYS2 maps to NTFS FILE_CREATE).
excl_write() {
  local error status
  if error=$(
    ( set -o noclobber; { printf '%s\n' "$2" || exit 2; } > "$1" ) 2>&1
  ); then
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 2 ]; then
    # The open succeeded and the write failed. Remove the incomplete record.
    rm -f -- "$1" || true
  elif [ -f "$1" ]; then
    return 1
  fi
  die "could not write $1: $error"
}

archive_record() { # source destination-stem
  local source=$1 stem=$2 target suffix='' n
  for ((n = 0; n < 100; n++)); do
    target="$stem$suffix.md"
    # Reserve a new history name before moving the record over it.
    if excl_write "$target" ''; then
      if mv "$source" "$target"; then return 0; fi
      rm -f "$target"
      return 1
    fi
    if [ ! -e "$target" ]; then return 1; fi
    suffix=.$((n + 1))
  done
  return 1
}

valid_slug() {
  case $1 in
    ''|*[!a-z0-9-]*) die "slug must be lowercase letters, digits or dashes: '$1'" ;;
  esac
}

no_human() {
  if [ "$1" = "$HUMAN" ]; then die "slug '$HUMAN' is reserved: $HUMAN posts through the dashboard"; fi
}

in_list() {
  local x=$1 y; shift
  for y in "$@"; do
    if [ "$x" = "$y" ]; then return 0; fi
  done
  return 1
}

take_file_lock() {
  local fd=$1 wait_seconds=$2
  if command -v flock >/dev/null 2>&1; then
    flock -x -w "$wait_seconds" "$fd"
  elif command -v perl >/dev/null 2>&1; then
    # Git Bash ships Perl, including flock(), but lacks the flock command.
    perl -MFcntl=:flock -MErrno -e '
      open my $gate, ">&=", $ARGV[0] or die "open gate descriptor: $!\n";
      for (my $left = $ARGV[1] * 20 || 1; $left > 0; $left--) {
        exit 0 if flock($gate, LOCK_EX | LOCK_NB);
        die "flock: $!\n" unless $!{EWOULDBLOCK} || $!{EAGAIN} || $!{EINTR};
        select undef, undef, undef, 0.05 if $left > 1;
      }
      exit 1;
    ' "$fd" "$wait_seconds"
  else
    return 127
  fi
}

# Keep the active record in place until its ownership or age has been checked.
# All three lock commands take this gate before reading or changing that record.
lock_gate() {
  local name=$1 wait_seconds=${2:-5} retry=${3:-0} gate status=0
  gate="$D/locks/.$name.change.lock"
  # Keep the same file for every caller. The OS releases the lock when the
  # last inherited descriptor closes, including after a crash or forced exit.
  exec {gate_fd}>> "$gate" || die "could not open the change gate for $name: $gate"
  take_file_lock "$gate_fd" "$wait_seconds" || status=$?
  case $status in
    0) return 0 ;;
    1)
      if [ "$retry" = 1 ]; then
        exec {gate_fd}>&-
        return 1
      fi
      die "could not acquire the change gate for $name: $gate"
      ;;
    127) die "lock commands require flock or Perl" ;;
    *) die "could not acquire the change gate for $name: $gate" ;;
  esac
}

lock_arguments() {
  local args=() repo="" scope timeout_set=0
  wait_mode=0
  wait_timeout=7200
  while [ $# -gt 0 ]; do
    case $1 in
      --wait) wait_mode=1; shift ;;
      --timeout) need $# 2; wait_timeout=$2; timeout_set=1; shift 2 ;;
      --repo) need $# 2; repo=$2; shift 2 ;;
      --) shift; args+=("$@"); break ;;
      *) args+=("$1"); shift ;;
    esac
  done
  need "${#args[@]}" 2
  name=${args[0]} slug=${args[1]} why=$(single_line "${args[2]:-}")
  no_human "$slug"; valid_slug "$slug"
  in_list "$name" $LOCK_NAMES || die "lock name must be one of: $LOCK_NAMES"
  if [ "$wait_mode" = 1 ] && { [ "$cmd" != lock ] || [ "$name" != full-test-suite ]; }; then
    die "--wait is only supported for lock full-test-suite"
  fi
  if [ "$timeout_set" = 1 ]; then
    [ "$wait_mode" = 1 ] || die "--timeout requires --wait"
    [[ "$wait_timeout" =~ ^[0-9]{1,5}$ ]] || die "--timeout must be 1 to 86400 seconds"
    wait_timeout=$((10#$wait_timeout))
    if [ "$wait_timeout" -lt 1 ] || [ "$wait_timeout" -gt 86400 ]; then
      die "--timeout must be 1 to 86400 seconds"
    fi
  fi
  lock_key=$name lock_repo=""
  if [ "$name" = full-test-suite ]; then
    if [ -n "$repo" ]; then
      repo=$(cd -- "$repo" && pwd) || die "could not enter repository: $repo"
    else
      repo=$PWD
    fi
    scope=$(CHAT_DIR="$D" node "$HERE/bin/full-test-lock.mjs" scope "$repo") ||
      die "could not determine repository scope for $repo; pass --repo <path> to a working Git checkout"
    [ -n "$scope" ] || die "repository scope helper returned no result"
    lock_key=${scope%%$'\n'*}; lock_repo=${scope#*$'\n'}
  elif [ -n "$repo" ]; then
    die "--repo is only supported for full-test-suite"
  fi
  f="$D/locks/$lock_key.md"
  queue="$D/locks/waiting/$lock_key"
}

ticket_file() {
  [[ "${1##*/}" =~ ^[0-9]{12}\.md$ ]] && [ -f "$1" ]
}

# A waiting process keeps an OS lease on its ticket. A killed process cannot
# leave a permanent queue head, even when it can't run a cleanup trap.
waiter_live() (
  local probe_fd
  exec {probe_fd}< "$1" || exit 1
  ! take_file_lock "$probe_fd" 0
) 2>/dev/null

queue_head() {
  local entry
  head=""
  for entry in "$queue"/[0-9]*.md; do
    ticket_file "$entry" || continue
    if [ "$entry" = "$ticket" ] || waiter_live "$entry"; then head=$entry; break; fi
    rm -f -- "$entry" || die "could not clear a dead lock waiter"
  done
}

queue_predecessor() {
  local entry
  predecessor=""
  for entry in "$queue"/[0-9]*.md; do
    if [ "$entry" = "$ticket" ]; then break; fi
    if ticket_file "$entry"; then predecessor=$entry; fi
  done
}

queue_join() {
  local entry number=0 base
  mkdir -p -- "$queue"
  # The change gate serializes ticket publication. Sorting fixed-width names
  # preserves arrival order even when several waiters join in one second.
  for entry in "$queue"/[0-9]*.md; do
    ticket_file "$entry" || continue
    base=${entry##*/}; number=$((10#${base%.md}))
  done
  printf -v ticket '%s/%012d.md' "$queue" "$((number + 1))"
  excl_write "$ticket" "owner: $slug
repo: $lock_repo
why: $why
since: $(iso)" || die "could not publish lock ticket"
  exec {lease_fd}>> "$ticket" || die "could not open lock ticket"
  take_file_lock "$lease_fd" 5 || die "could not lease lock ticket"
  echo "WAITING $name repo=$lock_repo timeout=${wait_timeout}s"
}

queue_leave() {
  if [ -n "$ticket" ]; then
    exec {lease_fd}>&-
    rm -f -- "$ticket"
  fi
}

launcher_alive() {
  case $launcher_mode in
    native) node "$HERE/bin/full-test-lock.mjs" windows-alive "$launcher" ;;
    shell) [ "$launcher" -gt 1 ] && kill -0 "$launcher" 2>/dev/null ;;
    timeout) return 0 ;;
  esac
}

find_wait_launcher() {
  local windows_pid="" native_pids
  if [[ "$OSTYPE" != msys* && ! -r "/proc/$BASHPID/winpid" ]]; then return 0; fi
  # A nested Git Bash shell may have an already-exited native parent while
  # its MSYS parent still exists. Keep the MSYS PPID for that invocation.
  if { read -r windows_pid < "/proc/$BASHPID/winpid" || [ -n "$windows_pid" ]; } 2>/dev/null &&
    native_pids=$(node "$HERE/bin/full-test-lock.mjs" windows-launchers "$windows_pid"); then
    launcher=$native_pids
    launcher_mode=native
  elif ! launcher_alive; then
    launcher_mode=timeout
    echo "chat.sh: warning: could not identify the lock wait launcher; the ${wait_timeout}s timeout still applies" >&2
  fi
}

wait_gate() {
  local remaining attempt result jitter
  while :; do
    result=0
    if ! launcher_alive; then result=125; fi
    remaining=$(( deadline - SECONDS ))
    if [ "$result" = 0 ] && [ "$remaining" -le 0 ]; then result=124; fi
    attempt=0
    if [ "$result" = 0 ]; then attempt=$(( remaining < 5 ? remaining : 5 )); fi
    if lock_gate "$lock_key" "$attempt" 1; then
      if [ "$result" = 0 ] && [ "$SECONDS" -ge "$deadline" ]; then result=124; fi
      if [ "$result" != 0 ]; then queue_leave; fi
      return "$result"
    fi
    # When the gate is still busy at cancellation, exiting closes the ticket's
    # lease. The next queue-head check can reap that ticket under the gate.
    if [ "$result" != 0 ]; then return "$result"; fi
    printf -v jitter '0.%03d' "$(( 50 + RANDOM % 150 ))"
    sleep "$jitter"
  done
}

report_wait_exit() {
  if [ "$1" = 125 ]; then
    echo "chat.sh: lock wait cancelled because its launcher exited" >&2
  else
    echo "chat.sh: timed out waiting for $name ($lock_repo) after ${wait_timeout}s" >&2
  fi
}

acquire_lock() {
  local record blocker head predecessor ticket="" lease_fd launcher=$PPID launcher_mode=shell
  local deadline result
  if [ "$wait_mode" = 1 ]; then find_wait_launcher; fi
  deadline=$((SECONDS + wait_timeout))
  while :; do
    if [ "$wait_mode" = 1 ]; then
      result=0
      wait_gate || result=$?
      if [ "$result" != 0 ]; then
        report_wait_exit "$result"
        return "$result"
      fi
    else
      lock_gate "$lock_key"
    fi
    if [ -e "$f" ] && [ ! -f "$f" ]; then
      queue_leave
      die "invalid lock record $f: expected a regular file"
    fi
    if [ -e "$f" ] && [ -z "$ticket" ] && [ "$(field owner "$f" || true)" = "$slug" ]; then
      echo "ALREADY YOURS $name"; cat "$f"
      return 0
    fi
    head=""
    if [ "$name" = full-test-suite ] && [ ! -e "$f" ]; then queue_head; fi
    if [ ! -e "$f" ] && { [ -z "$head" ] || [ "$head" = "$ticket" ]; }; then
      if [ "$wait_mode" = 1 ] && ! launcher_alive; then
        queue_leave
        report_wait_exit 125
        return 125
      fi
      if [ "$wait_mode" = 1 ] && [ "$SECONDS" -ge "$deadline" ]; then
        queue_leave
        report_wait_exit 124
        return 124
      fi
      record="lock: $name
owner: $slug
why: $why
since: $(iso)
since_epoch: $(date -u +%s)"
      if [ "$lock_key" != "$name" ]; then record+=$'\n'"repo: $lock_repo"; fi
      excl_write "$f" "$record" || die "could not create lock $name"
      queue_leave
      echo "LOCKED $name"
      do_post "$slug" lock "Took lock $name: $why" >/dev/null
      return 0
    fi
    if [ "$wait_mode" = 0 ]; then
      if [ -e "$f" ]; then echo "HELD by another session:"; cat "$f"
      else echo "QUEUED waiters have priority for $name:"; cat "$head"; fi
      return 2
    fi
    if [ -z "$ticket" ]; then queue_join; fi
    # The front waiter watches the active lock. Everyone else watches their
    # predecessor, so a release does not send the entire queue to the gate.
    queue_predecessor
    blocker=${predecessor:-$f}
    exec {gate_fd}>&-
    # Watching must never inherit the lease or delay its release on a crash.
    node "$HERE/bin/full-test-lock.mjs" wait "$blocker" "$(( (deadline - SECONDS) * 1000 ))" {lease_fd}>&-
  done
}

# field <key> <file>: print the value of a "key: value" line.
field() {
  local k=$1 f=$2 line
  while IFS= read -r line; do
    case $line in
      "$k: "*) printf '%s\n' "${line#"$k: "}"; return 0 ;;
    esac
  done < "$f"
  return 1
}

valid_log_name() {
  local stamp='^[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z$'
  local kind='[a-z][a-z0-9_-]*\.md' record=${1#*_}
  [[ "${1%%_*}" =~ $stamp ]] || return 1
  # Dashboard entries use the configured human slug, including mixed case.
  [[ "$record" =~ ^[a-z0-9-]+_${kind}$ ]] ||
    { [[ "$record" == "$HUMAN"_* ]] && [[ "${record#"$HUMAN"_}" =~ ^${kind}$ ]]; }
}

ensure_dirs() {
  mkdir -p "$D/status" "$D/log/archive" "$D/claims" "$D/locks/released" "$D/locks/broken" "$D/.lastread" "$D/reservations/released"
}

do_post() { # slug kind body [re-logfile]
  local slug=$1 kind=$2 body=$3 re=${4:-} s f n=0 extra=""
  valid_slug "$slug"
  if [ -n "$re" ]; then extra="
re: $re"; fi
  in_list "$kind" $KINDS || die "kind must be one of: $KINDS"
  s=$(stamp)
  while :; do
    if [ "$n" -eq 0 ]; then f="$D/log/${s}_${slug}_${kind}.md"; else f="$D/log/${s}_${slug}_${kind}-$n.md"; fi
    if excl_write "$f" "from: $slug
kind: $kind
at: $(iso)${extra}

$body"; then break; fi
    n=$((n + 1))
    if [ "$n" -ge 10 ]; then die "could not create a log file"; fi
  done
  echo "POSTED log/${f##*/}"
}

lock_age() {
  local since elapsed
  since=$(field since_epoch "$1" 2>/dev/null || true)
  if ! [[ "$since" =~ ^[0-9]{1,12}$ ]]; then
    since=$(date -u -r "$1" +%s 2>/dev/null) || return 1
  fi
  [[ "$since" =~ ^[0-9]{1,12}$ ]] || return 1
  elapsed=$(( $2 - 10#$since ))
  printf '%s\n' "$(( elapsed > 0 ? elapsed / 60 : 0 ))"
}

show_locks() {
  local f any=0 now age owner repo
  now=$(date -u +%s)
  for f in "$D"/locks/*.md; do
    owner=$(field owner "$f" 2>/dev/null) || continue
    any=1
    repo=$(field repo "$f" 2>/dev/null || true)
    if [ "${f##*/}" = full-test-suite.md ]; then repo=${ZM_PR_REPO:-$REPO}; fi
    age=$(lock_age "$f" "$now" || echo '?')
    echo "LOCK HELD: ${f##*/} owner=$owner since=$(field since "$f" 2>/dev/null || echo '?') age=$age min${repo:+ repo=$repo} why=$(field why "$f" 2>/dev/null || echo '?')"
    if [ "$age" != '?' ] && [ "$age" -ge "$BREAK_AFTER_MIN" ]; then
      echo "WARNING: ${f##*/} held by $owner for $age min (threshold: $BREAK_AFTER_MIN min)"
    fi
  done
  if [ "$any" -eq 0 ]; then echo "LOCKS: none held"; fi
  if [ "${1:-}" = '--waiters' ]; then
    for f in "$D"/locks/waiting/*/[0-9]*.md; do
      ticket_file "$f" && waiter_live "$f" || continue
      owner=$(field owner "$f" 2>/dev/null) || continue
      echo "LOCK WAITING: repo=$(field repo "$f" 2>/dev/null || echo '?') owner=$owner since=$(field since "$f" 2>/dev/null || echo '?') why=$(field why "$f" 2>/dev/null || echo '?')"
    done
  fi
}

publish_main_cache() (
  local tracking_ref=$1 previous=$2 tip=$3 fetch_head staged current fd
  fetch_head=$(git -C "$REPO" rev-parse --path-format=absolute --git-path FETCH_HEAD) || exit 1
  exec {fd}>> "$fetch_head.zippermerge.lock" || exit 1
  take_file_lock "$fd" 0 || exit 1

  current=$(git -C "$REPO" rev-parse --verify --quiet "$tracking_ref" || true)
  # If another fetch changed the ref, only publish a snapshot that advances it.
  if [ "$current" != "$tip" ] && [ "$current" != "$previous" ]; then
    git -C "$REPO" merge-base --is-ancestor "$current" "$tip" || exit 1
  fi
  staged=$(mktemp "$fetch_head.XXXXXXXXXX") || exit 1
  trap 'rm -f -- "$staged"' EXIT
  printf "%s\t\tbranch 'main' of origin\n" "$tip" > "$staged" || exit 1
  if [ "$current" != "$tip" ]; then
    git -C "$REPO" -c core.filesRefLockTimeout=0 -c reftable.lockTimeout=0 \
      update-ref "$tracking_ref" "$tip" "$current" || exit 1
  fi
  mv -f -- "$staged" "$fetch_head"
)

max_main_migration() (
  local m=0 entries file num scratch main_ref tip previous tracking_ref=refs/remotes/origin/main
  [ -n "$MIG_DIR" ] || die "migration directory must be a repo-relative path"
  # Read a fresh snapshot without contending for origin/main or FETCH_HEAD.
  previous=$(git -C "$REPO" rev-parse --verify --quiet "$tracking_ref" 2>/dev/null || true)
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/zippermerge-main.XXXXXXXXXX") || die "could not allocate a temporary fetch ref"
  main_ref="refs/zippermerge/claim-main/${scratch##*/}"
  trap 'git -C "$REPO" update-ref -d "$main_ref" 2>/dev/null || true; rmdir "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  git -C "$REPO" fetch -q --no-tags --no-prune --no-prune-tags --no-write-fetch-head --no-auto-maintenance --refmap= \
    origin "refs/heads/main:$main_ref" || die "could not fetch origin/main"
  tip=$(git -C "$REPO" rev-parse --verify "$main_ref^{commit}") || die "could not read fetched origin/main"
  # Keep the guard and dashboard cache current when it can be published safely.
  publish_main_cache "$tracking_ref" "$previous" "$tip" >/dev/null 2>&1 || true
  entries=$(git -C "$REPO" ls-tree --name-only "$tip:$MIG_DIR") ||
    die "could not read migration directory '$MIG_DIR' on origin/main"
  while IFS= read -r file; do
    num=${file%%_*}
    case $num in ''|*[!0-9]*) continue ;; esac
    num=${num#"${num%%[!0]*}"}; num=${num:-0}
    if [ "${#num}" -gt "${#MIGRATION_MAX}" ]; then
      printf 'chat.sh: warning: ignoring migration prefix above %s on origin/main: %s\n' "$MIGRATION_MAX" "$file" >&2
      continue
    fi
    if [ $((10#$num)) -gt "$m" ]; then m=$((10#$num)); fi
  done <<< "$entries"
  echo "$m"
)

max_claimed_migration() {
  local m=$1 max=0 f b num sorted
  local numbers=()
  for f in "$D"/claims/migration-*.md; do
    if [ ! -e "$f" ]; then continue; fi
    b=${f##*/}; num=${b#migration-}; num=${num%.md}
    case $num in ''|*[!0-9]*) continue ;; esac
    if [ "${#num}" -le "${#MIGRATION_MAX}" ]; then numbers+=("$((10#$num))"); fi
  done
  # Keep advancing through plausible claims. Distant historical outliers stay on disk.
  sorted=$(printf '%s\n' "${numbers[@]}" | sort -n) || die "could not sort migration claims"
  while IFS= read -r num; do
    if [ -z "$num" ]; then continue; fi
    if [ $((num - m)) -gt "$CLAIM_MAX_GAP" ]; then break; fi
    max=$num
    if [ "$num" -gt "$m" ]; then m=$num; fi
  done <<< "$sorted"
  echo "$max"
}

# Reservation helpers. A reservation file is reservations/<stamp>_<slug>.md with key: value lines.
# strip_glob <pattern>: drop trailing '*' characters (for the prefix-overlap check).
strip_glob() { local p=$1; while [ "${p%\*}" != "$p" ]; do p=${p%\*}; done; printf '%s' "$p"; }

# warn_overlaps <slug> <pattern>: warn (stderr) about active reservations by others that overlap.
warn_overlaps() {
  local slug=$1 pat=$2 now f o p exp a b
  now=$(date -u +%s)
  a=$(strip_glob "$pat")
  for f in "$D"/reservations/*.md; do
    if [ ! -e "$f" ]; then continue; fi
    o=$(field owner "$f" || echo '?')
    if [ "$o" = "$slug" ]; then continue; fi
    exp=$(field expires_epoch "$f" || echo 0)
    if [ "$exp" -le "$now" ]; then continue; fi
    p=$(field pattern "$f" || echo '')
    b=$(strip_glob "$p")
    if [[ "$a" == "$b"* || "$b" == "$a"* || "$p" == $pat || "$pat" == $p ]]; then
      echo "WARNING: overlaps ${f##*/} (owner=$o pattern=$p mode=$(field mode "$f" || echo '?') why=$(field why "$f" || echo '?'))" >&2
    fi
  done
}

valid_migration_name() {
  case $1 in
    ''|[!a-z]*|*[!a-z0-9_]*) die "migration name must be snake_case (letters, digits and underscores, starting with a lowercase letter)" ;;
  esac
}

claim_body() { # num slug name ref mainmax
  printf 'number: %s\nowner: %s\nname: %s\nref: %s\nclaimed: %s\nmain_max_at_claim: %s' "$1" "$2" "$3" "$4" "$(iso)" "$5"
}

usage() {
  cat <<'EOF'
chat.sh: coordination helper. All times UTC.

  new <slug>                          show log entries from others since your last read; advance your marker
  board                               print every status/*.md, held locks, queue and latest claims
  post <slug> <kind> "<text>"         append a log entry. kinds: hello status claim release lock unlock ask alert done note
  migration <slug> <name> "<ref>"     claim the NEXT free migration number (checks fresh origin/main AND claims/)
  claim-number <slug> <N> <name> "<ref>"   claim one specific number (one you already created); fails if taken or <= main
  lock <name> <slug> ["<why>"]        take a lock. names: full-test-suite | main-freeze
  lock --wait [--timeout SECONDS] full-test-suite <slug> ["<why>"]
                                      join the FIFO queue (default timeout 7200s, exit 124 on timeout,
                                      125 if the launcher exits). For long waits use a background tool
                                      that keeps the launcher alive, such as Bash run_in_background.
  unlock <name> <slug>                release your lock
  break <name> <slug>                 break a lock older than 60 minutes (posts an alert)
  archive                             move log entries older than 3 days into log/archive/
  guard [--slug S]                    pre-commit check of the current dir: migration claims, main-freeze, others' hot files
  reply <slug> <log-file> "<text>"    post a reply (kind reply, 're: <log-file>' header) to an existing log entry
  reserve <slug> <pattern> "<why>" [--ttl MIN] [--exclusive]
                                      reserve a repo-relative glob (* within a segment, ** across). TTL default 60, max 480.
                                      shared (default) = warn others on edit/commit; --exclusive = block others' commits
  unreserve <slug> <id-or-pattern>    release your reservation (owner only)
  reservations                        list active reservations and the count of expired ones

  The human's slug (ZM_HUMAN) is reserved (dashboard only): post, reply, migration, claim-number, lock, unlock,
  break, reserve and unreserve refuse it. Reading with 'new' and 'board' is fine.

  <name> for migrations is snake_case, e.g. add_order_index
  full-test-suite is scoped to the current Git repository. Use --repo <path> with
  lock, unlock or break when running from a different checkout. main-freeze is board-wide.
  Settings: config.env in this folder (ZM_REPO, ZM_MIG_DIR, ZM_HUMAN, ZM_PR_REPO). CHAT_DIR moves the data folder.
EOF
}

ensure_dirs
cmd=${1:-help}
if [ $# -gt 0 ]; then shift; fi

case $cmd in
  help|-h|--help) usage ;;

  post)
    need $# 3
    no_human "$1"
    do_post "$1" "$2" "$3"
    ;;

  reply)
    need $# 3
    slug=$1 lf=${2#log/} text=$3; no_human "$slug"; valid_slug "$slug"
    case $lf in ''|*/*|*\\*) die "log-file must be a bare file name from log/: '$2'" ;; esac
    if [ ! -f "$D/log/$lf" ]; then die "log/$lf does not exist"; fi
    do_post "$slug" reply "$text" "$lf"
    ;;

  reserve)
    need $# 3
    slug=$1 pat=$2 why=$(single_line "$3"); shift 3
    no_human "$slug"; valid_slug "$slug"
    ttl=$RESERVE_DEFAULT_TTL mode=shared
    while [ $# -gt 0 ]; do
      case $1 in
        --exclusive) mode=exclusive; shift ;;
        --ttl) need $# 2; ttl=$2; shift 2 ;;
        *) die "unknown option '$1' (run: chat.sh help)" ;;
      esac
    done
    case $ttl in ''|*[!0-9]*) die "--ttl must be a whole number of minutes" ;; esac
    ttl=$((10#$ttl))
    if [ "$ttl" -lt 1 ]; then die "--ttl must be at least 1"; fi
    if [ "$ttl" -gt "$RESERVE_MAX_TTL" ]; then ttl=$RESERVE_MAX_TTL; fi
    pat=${pat//\\//}; pat=${pat#./}
    case $pat in
      *$'\r'*|*$'\n'*) die "pattern must be a single line" ;;
      ''|/*) die "pattern must be a non-empty repo-relative glob: '$pat'" ;;
    esac
    warn_overlaps "$slug" "$pat"
    now=$(date -u +%s); s=$(stamp); n=0
    while :; do
      if [ "$n" -eq 0 ]; then id="${s}_${slug}"; else id="${s}_${slug}-$n"; fi
      if excl_write "$D/reservations/$id.md" "owner: $slug
pattern: $pat
mode: $mode
why: $why
since: $(iso)
since_epoch: $now
ttl_min: $ttl
expires_epoch: $((now + ttl * 60))"; then break; fi
      n=$((n + 1))
      if [ "$n" -ge 10 ]; then die "could not create a reservation file"; fi
    done
    do_post "$slug" note "Reserved $pat ($mode, $ttl min): $why" >/dev/null
    echo "RESERVED $id"
    ;;

  unreserve)
    need $# 2
    slug=$1 key=$2; no_human "$slug"; valid_slug "$slug"
    key=${key//\\//}; key=${key%.md}
    mine=""; other=""
    for f in "$D"/reservations/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      b=${f##*/}; b=${b%.md}
      o=$(field owner "$f" || echo '?')
      if [ "$b" = "$key" ] || [ "$(field pattern "$f" || true)" = "$key" ]; then
        if [ "$o" = "$slug" ]; then mine=$f; break; fi
        other="$b (owner $o)"
      fi
    done
    if [ -z "$mine" ]; then
      if [ -n "$other" ]; then die "reservation $other is not yours; only the owner can release it"; fi
      die "no reservation matching '$key'"
    fi
    id=${mine##*/}; id=${id%.md}; pat=$(field pattern "$mine" || echo '?')
    archive_record "$mine" "$D/reservations/released/$id" || die "could not archive reservation $id"
    do_post "$slug" note "Released reservation $pat ($id)." >/dev/null
    echo "RELEASED $id"
    ;;

  reservations)
    now=$(date -u +%s); active=0; expired=0
    for f in "$D"/reservations/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      exp=$(field expires_epoch "$f" || echo 0)
      if [ "$exp" -le "$now" ]; then expired=$((expired + 1)); continue; fi
      active=$((active + 1)); b=${f##*/}
      echo "RESERVED ${b%.md}: owner=$(field owner "$f" || echo '?') pattern=$(field pattern "$f" || echo '?') mode=$(field mode "$f" || echo '?') left=$(( (exp - now + 59) / 60 )) min why=$(field why "$f" || echo '?')"
    done
    if [ "$active" -eq 0 ]; then echo "RESERVATIONS: none active"; fi
    echo "EXPIRED: $expired"
    ;;

  new)
    need $# 1
    slug=$1; valid_slug "$slug"
    mark="$D/.lastread/$slug"; seen=""
    if [ -f "$mark" ]; then
      while IFS= read -r b || [ -n "$b" ]; do
        b=${b%$'\r'}
        if valid_log_name "$b"; then seen=${seen:+$seen$'\n'}$b; fi
      done < "$mark"
    fi
    # The marker lists names seen in the newest second. Old markers list only one name.
    last=${seen%%$'\n'*}; last_stamp=${last%%_*}
    newest=$last; latest=$seen
    files=()
    for f in "$D"/log/*.md; do
      if [ ! -f "$f" ] || ! valid_log_name "${f##*/}"; then continue; fi
      b=${f##*/}; s=${b%%_*}
      if [[ "$s" < "$last_stamp" ]]; then continue; fi
      if [ "$s" = "$last_stamp" ]; then
        case $'\n'$seen$'\n' in *$'\n'"$b"$'\n'*) continue ;; esac
      fi
      files+=("$f")
      if [ "$s" != "${newest%%_*}" ]; then latest=""; fi
      newest=$b
      latest=$b${latest:+$'\n'$latest}
    done
    show_locks
    if [ ${#files[@]} -eq 0 ]; then echo "NOTHING NEW since ${last:-the start}"; exit 0; fi
    if [ -z "$last" ] && [ ${#files[@]} -gt 20 ]; then files=("${files[@]:$(( ${#files[@]} - 20 ))}"); fi
    shown=0
    for f in "${files[@]}"; do
      b=${f##*/}
      case $b in *"_${slug}_"*) continue ;; esac
      echo "=== log/$b"
      # Keep quoted headers and reader output visibly inside the post body.
      awk '
        body && /^(=== |from:|kind:|at:|via:|re:|--- read up to |LOCK HELD:|LOCKS:|NOTHING NEW)/ { $0 = "  " $0 }
        { print }
        /^\r?$/ { body = 1 }
      ' "$f"
      echo
      shown=$((shown + 1))
    done
    tmp=$(mktemp "$mark.XXXXXX")
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s\n' "$latest" > "$tmp"
    mv -f -- "$tmp" "$mark"
    if [ "$shown" -eq 0 ]; then echo "NOTHING NEW from other sessions"; fi
    echo "--- read up to log/$newest"
    ;;

  board)
    for f in "$D"/status/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      echo "=== status/${f##*/}  (modified $(status_mtime "$f"))"
      cat "$f"
      echo
    done
    show_locks --waiters
    echo "LATEST CLAIMS:"
    claims=()
    for f in "$D"/claims/migration-*.md; do
      if [ -e "$f" ]; then claims+=("$f"); fi
    done
    if [ ${#claims[@]} -gt 0 ]; then
      start=$(( ${#claims[@]} > 8 ? ${#claims[@]} - 8 : 0 ))
      for f in "${claims[@]:$start}"; do
        echo "  ${f##*/}: owner=$(field owner "$f" || echo '?') name=$(field name "$f" || echo '?') ref=$(field ref "$f" || echo '?')"
      done
    else
      echo "  none"
    fi
    ;;

  migration)
    need $# 3
    slug=$1 name=$2 ref=$(single_line "$3"); no_human "$slug"; valid_slug "$slug"
    valid_migration_name "$name"
    mm=$(max_main_migration); mc=$(max_claimed_migration "$mm")
    base=$mm; if [ "$mc" -gt "$base" ]; then base=$mc; fi
    n=$base
    while :; do
      n=$((n + 1))
      if [ "$n" -gt "$MIGRATION_MAX" ]; then die "no migration numbers remain below or equal to $MIGRATION_MAX"; fi
      num3=$(printf '%03d' "$n")
      if excl_write "$D/claims/migration-$num3.md" "$(claim_body "$num3" "$slug" "$name" "$ref" "$mm")"; then break; fi
      if [ $((n - base)) -ge "$CLAIM_MAX_GAP" ]; then die "could not claim a migration number"; fi
    done
    echo "CLAIMED $num3 (origin/main max $mm, claims max $mc) -> create ${MIG_DIR%/}/${num3}_${name}.sql"
    do_post "$slug" claim "Claimed migration $num3 ($name) for $ref." >/dev/null
    ;;

  claim-number)
    need $# 4
    slug=$1 n=$2 name=$3 ref=$(single_line "$4"); no_human "$slug"; valid_slug "$slug"
    valid_migration_name "$name"
    case $n in ''|*[!0-9]*) die "N must be a number" ;; esac
    if [ "${#n}" -gt "${#MIGRATION_MAX}" ]; then die "N must be at most ${#MIGRATION_MAX} digits"; fi
    n=$((10#$n))
    num3=$(printf '%03d' "$n"); f="$D/claims/migration-$num3.md"
    mm=$(max_main_migration)
    if [ "$n" -le "$mm" ]; then
      die "$num3 is not above origin/main's highest migration ($mm). Renumber upward: use 'chat.sh migration'."
    fi
    mc=$(max_claimed_migration "$mm")
    base=$mm; if [ "$mc" -gt "$base" ]; then base=$mc; fi
    if [ $((n - base)) -gt "$CLAIM_MAX_GAP" ]; then die "N must be within $CLAIM_MAX_GAP of the current maximum ($base)"; fi
    if excl_write "$f" "$(claim_body "$num3" "$slug" "$name" "$ref" "$mm")"; then
      echo "CLAIMED $num3"
      do_post "$slug" claim "Claimed migration $num3 ($name) for $ref." >/dev/null
    elif [ "$(field owner "$f" || true)" = "$slug" ]; then
      echo "ALREADY YOURS $num3"; cat "$f"
    else
      echo "TAKEN $num3:"; cat "$f"; exit 2
    fi
    ;;

  lock)
    lock_arguments "$@"
    acquire_lock
    ;;

  unlock)
    lock_arguments "$@"
    lock_gate "$lock_key"
    if [ ! -e "$f" ]; then die "lock $name is not held"; fi
    owner=$(field owner "$f" || echo '?')
    if [ "$owner" != "$slug" ]; then die "lock $name belongs to $owner, not $slug"; fi
    archive_record "$f" "$D/locks/released/${lock_key}_$(stamp)" || die "could not archive lock $name"
    echo "UNLOCKED $name"
    do_post "$slug" unlock "Released lock $name." >/dev/null
    ;;

  break)
    lock_arguments "$@"
    lock_gate "$lock_key"
    if [ ! -e "$f" ]; then die "lock $name is not held"; fi
    age_min=$(lock_age "$f" "$(date -u +%s)") || die "lock $name has no valid acquisition time"
    if [ "$age_min" -lt "$BREAK_AFTER_MIN" ]; then die "lock $name is only $age_min min old; wait, or post an ask to its owner"; fi
    owner=$(field owner "$f" || echo '?')
    archive_record "$f" "$D/locks/broken/${lock_key}_by-${slug}_$(stamp)" || die "could not archive lock $name"
    echo "BROKE $name (held by $owner for $age_min min)"
    do_post "$slug" alert "@$owner I broke lock $name after $age_min min with no release." >/dev/null
    ;;

  archive)
    # Some BSD versions use -d to set the daylight saving time flag.
    cutoff=$(date -u -v-3d +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -d '3 days ago' +%Y%m%dT%H%M%SZ)
    moved=0
    for f in "$D"/log/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      b=${f##*/}
      if [[ "$b" < "$cutoff" ]]; then mv "$f" "$D/log/archive/"; moved=$((moved + 1)); fi
    done
    echo "ARCHIVED $moved entries older than $cutoff"
    ;;

  guard)
    CHAT_DIR="$D" exec node "$HERE/bin/guard.mjs" check "$@"
    ;;

  *) usage; exit 1 ;;
esac
