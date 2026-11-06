#!/usr/bin/env bash
# chat.sh: helper for the coordination protocol (see CLAUDE.md).
# The ONLY supported way to post log entries, claim migration numbers and take locks.
# Usage: bash <this folder>/chat.sh <command> ...    (bash chat.sh help)
set -euo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
D=${CHAT_DIR:-$HERE}
# config.env sets ZM_REPO, ZM_MIG_DIR, ZM_HUMAN and ZM_PR_REPO for this project.
if [ -f "$D/config.env" ]; then while IFS= read -r line || [ -n "$line" ]; do line=${line%$'\r'}; case $line in ZM_*=*) k=${line%%=*}; if [ -z "${!k+x}" ]; then export "$line"; fi ;; esac; done < "$D/config.env"; fi
REPO=${ZM_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
MIG_DIR=${ZM_MIG_DIR:-migrations}
HUMAN=${ZM_HUMAN:-human}
LOCK_NAMES="full-test-suite main-freeze"
KINDS="hello status claim release lock unlock ask alert done note reply"
BREAK_AFTER_MIN=60
RESERVE_DEFAULT_TTL=60
RESERVE_MAX_TTL=480

stamp() { date -u +%Y%m%dT%H%M%SZ; }
iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
die()   { echo "chat.sh: $*" >&2; exit 1; }
need()  { if [ "$1" -lt "$2" ]; then die "missing arguments (run: chat.sh help)"; fi; }

# Atomic exclusive create: succeeds only if the file did not already exist
# (bash noclobber opens with O_EXCL, which MSYS2 maps to NTFS FILE_CREATE).
excl_write() { ( set -o noclobber; printf '%s\n' "$2" > "$1" ) 2>/dev/null; }

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

show_locks() {
  local f any=0
  for f in "$D"/locks/*.md; do
    if [ ! -e "$f" ]; then continue; fi
    any=1
    echo "LOCK HELD: ${f##*/} owner=$(field owner "$f" || echo '?') since=$(field since "$f" || echo '?') why=$(field why "$f" || echo '?')"
  done
  if [ "$any" -eq 0 ]; then echo "LOCKS: none held"; fi
}

max_main_migration() {
  local m=0 p b num
  if ! git -C "$REPO" fetch -q origin main 2>/dev/null; then
    echo "warning: git fetch failed; using cached origin/main" >&2
  fi
  while IFS= read -r p; do
    b=${p##*/}; num=${b%%_*}
    case $num in ''|*[!0-9]*) continue ;; esac
    if [ $((10#$num)) -gt "$m" ]; then m=$((10#$num)); fi
  done < <(git -C "$REPO" ls-tree --name-only origin/main "$MIG_DIR/")
  echo "$m"
}

max_claimed_migration() {
  local m=0 f b num
  for f in "$D"/claims/migration-*.md; do
    if [ ! -e "$f" ]; then continue; fi
    b=${f##*/}; num=${b#migration-}; num=${num%.md}
    case $num in ''|*[!0-9]*) continue ;; esac
    if [ $((10#$num)) -gt "$m" ]; then m=$((10#$num)); fi
  done
  echo "$m"
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
    if [ "$p" = "$pat" ] || [[ "$a" == "$b"* ]] || [[ "$b" == "$a"* ]]; then
      echo "WARNING: overlaps ${f##*/} (owner=$o pattern=$p mode=$(field mode "$f" || echo '?') why=$(field why "$f" || echo '?'))" >&2
    fi
  done
}

claim_body() { # num slug name ref mainmax
  printf 'number: %s\nowner: %s\nname: %s\nref: %s\nclaimed: %s\nmain_max_at_claim: %s' "$1" "$2" "$3" "$4" "$(iso)" "$5"
}

usage() {
  cat <<'EOF'
chat.sh: coordination helper. All times UTC.

  new <slug>                          show log entries from others since your last read; advance your marker
  board                               print every status/*.md, held locks and the latest claims
  post <slug> <kind> "<text>"         append a log entry. kinds: hello status claim release lock unlock ask alert done note
  migration <slug> <name> "<ref>"     claim the NEXT free migration number (checks fresh origin/main AND claims/)
  claim-number <slug> <N> <name> "<ref>"   claim one specific number (one you already created); fails if taken or <= main
  lock <name> <slug> "<why>"          take a lock. names: full-test-suite | main-freeze
  unlock <name> <slug>                release your lock
  break <name> <slug>                 break a lock older than 60 minutes (posts an alert)
  archive                             move log entries older than 3 days into log/archive/
  reply <slug> <log-file> "<text>"    post a reply (kind reply, 're: <log-file>' header) to an existing log entry
  reserve <slug> <pattern> "<why>" [--ttl MIN] [--exclusive]
                                      reserve a repo-relative glob (* within a segment, ** across). TTL default 60, max 480.
                                      shared (default) = warn others on edit/commit; --exclusive = block others' commits
  unreserve <slug> <id-or-pattern>    release your reservation (owner only)
  reservations                        list active reservations and the count of expired ones

  The human's slug (ZM_HUMAN) is reserved (dashboard only): post, reply, migration, claim-number, lock, unlock,
  break, reserve and unreserve refuse it. Reading with 'new' and 'board' is fine.

  <name> for migrations is snake_case, e.g. add_order_index
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
    slug=$1 pat=$2 why=$3; shift 3
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
    case $pat in ''|/*) die "pattern must be a non-empty repo-relative glob: '$pat'" ;; esac
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
    mv "$mine" "$D/reservations/released/$id.md" || die "someone else released it first"
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
    mark="$D/.lastread/$slug"; last=""
    if [ -f "$mark" ]; then last=$(cat "$mark"); fi
    files=()
    for f in "$D"/log/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      b=${f##*/}
      if [[ "$b" > "$last" ]]; then files+=("$f"); fi
    done
    show_locks
    if [ ${#files[@]} -eq 0 ]; then echo "NOTHING NEW since ${last:-the start}"; exit 0; fi
    if [ -z "$last" ] && [ ${#files[@]} -gt 20 ]; then files=("${files[@]:$(( ${#files[@]} - 20 ))}"); fi
    shown=0; newest=""
    for f in "${files[@]}"; do
      b=${f##*/}; newest=$b
      case $b in *"_${slug}_"*) continue ;; esac
      echo "=== log/$b"
      head -n 25 "$f"
      echo
      shown=$((shown + 1))
    done
    printf '%s\n' "$newest" > "$mark"
    if [ "$shown" -eq 0 ]; then echo "NOTHING NEW from other sessions"; fi
    echo "--- read up to log/$newest"
    ;;

  board)
    for f in "$D"/status/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      echo "=== status/${f##*/}  (modified $(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ))"
      cat "$f"
      echo
    done
    show_locks
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
    slug=$1 name=$2 ref=$3; no_human "$slug"; valid_slug "$slug"
    mm=$(max_main_migration); mc=$(max_claimed_migration)
    base=$mm; if [ "$mc" -gt "$base" ]; then base=$mc; fi
    n=$base
    while :; do
      n=$((n + 1)); num3=$(printf '%03d' "$n")
      if excl_write "$D/claims/migration-$num3.md" "$(claim_body "$num3" "$slug" "$name" "$ref" "$mm")"; then break; fi
      if [ $((n - base)) -ge 50 ]; then die "could not claim a migration number"; fi
    done
    echo "CLAIMED $num3 (origin/main max $mm, claims max $mc) -> create $MIG_DIR/${num3}_${name}.sql"
    do_post "$slug" claim "Claimed migration $num3 ($name) for $ref." >/dev/null
    ;;

  claim-number)
    need $# 4
    slug=$1 n=$2 name=$3 ref=$4; no_human "$slug"; valid_slug "$slug"
    case $n in ''|*[!0-9]*) die "N must be a number" ;; esac
    num3=$(printf '%03d' "$((10#$n))"); f="$D/claims/migration-$num3.md"
    mm=$(max_main_migration)
    if [ $((10#$n)) -le "$mm" ]; then
      die "$num3 is not above origin/main's highest migration ($mm). Renumber upward: use 'chat.sh migration'."
    fi
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
    need $# 3
    name=$1 slug=$2 why=$3; no_human "$slug"; valid_slug "$slug"
    in_list "$name" $LOCK_NAMES || die "lock name must be one of: $LOCK_NAMES"
    f="$D/locks/$name.md"
    if excl_write "$f" "lock: $name
owner: $slug
why: $why
since: $(iso)
since_epoch: $(date -u +%s)"; then
      echo "LOCKED $name"
      do_post "$slug" lock "Took lock $name: $why" >/dev/null
    elif [ "$(field owner "$f" || true)" = "$slug" ]; then
      echo "ALREADY YOURS $name"; cat "$f"
    else
      echo "HELD by another session:"; cat "$f"; exit 2
    fi
    ;;

  unlock)
    need $# 2
    name=$1 slug=$2; no_human "$slug"; valid_slug "$slug"
    f="$D/locks/$name.md"
    if [ ! -e "$f" ]; then die "lock $name is not held"; fi
    if [ "$(field owner "$f" || true)" != "$slug" ]; then die "lock $name belongs to $(field owner "$f" || echo '?'), not $slug"; fi
    mv "$f" "$D/locks/released/${name}_$(stamp).md"
    echo "UNLOCKED $name"
    do_post "$slug" unlock "Released lock $name." >/dev/null
    ;;

  break)
    need $# 2
    name=$1 slug=$2; no_human "$slug"; valid_slug "$slug"
    f="$D/locks/$name.md"
    if [ ! -e "$f" ]; then die "lock $name is not held"; fi
    since=$(field since_epoch "$f" || echo 0)
    age_min=$(( ($(date -u +%s) - since) / 60 ))
    if [ "$age_min" -lt "$BREAK_AFTER_MIN" ]; then die "lock $name is only $age_min min old; wait, or post an ask to its owner"; fi
    owner=$(field owner "$f" || echo '?')
    # mv is atomic: if two sessions break at once, the second mv fails.
    mv "$f" "$D/locks/broken/${name}_by-${slug}_$(stamp).md" || die "someone else broke it first"
    echo "BROKE $name (held by $owner for $age_min min)"
    do_post "$slug" alert "@$owner I broke lock $name after $age_min min with no release." >/dev/null
    ;;

  archive)
    cutoff=$(date -u -d '3 days ago' +%Y%m%dT%H%M%SZ)
    moved=0
    for f in "$D"/log/*.md; do
      if [ ! -e "$f" ]; then continue; fi
      b=${f##*/}
      if [[ "$b" < "$cutoff" ]]; then mv "$f" "$D/log/archive/"; moved=$((moved + 1)); fi
    done
    echo "ARCHIVED $moved entries older than $cutoff"
    ;;

  *) usage; exit 1 ;;
esac
