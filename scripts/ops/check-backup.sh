#!/bin/sh

set -eu
umask 077

EXIT_USAGE=2
EXIT_DEPENDENCY=3
EXIT_DISK=4
EXIT_STALE=7

DB=${SONGBOOK_DB:-/var/lib/songbook/songbook.sqlite}
BACKUP_DIR=${SONGBOOK_BACKUP_DIR:-/var/backups/songbook}
PREFIX=${SONGBOOK_BACKUP_PREFIX:-songbook}
MAX_AGE_HOURS=${SONGBOOK_MAX_AGE_HOURS:-26}
MIN_FREE_KIB=${SONGBOOK_MIN_FREE_KIB:-1048576}

die() {
  code=$1
  shift
  echo "songbook backup check: $*" >&2
  exit "$code"
}

is_uint() {
  case $1 in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$EXIT_DEPENDENCY" "missing dependency: $1"
}

JSON=0
if [ "$#" -gt 1 ]; then
  die "$EXIT_USAGE" "usage: $0 [--json]"
elif [ "$#" -eq 1 ]; then
  [ "$1" = --json ] || die "$EXIT_USAGE" "usage: $0 [--json]"
  JSON=1
fi

is_uint "$MAX_AGE_HOURS" || die "$EXIT_USAGE" "SONGBOOK_MAX_AGE_HOURS must be a non-negative integer"
is_uint "$MIN_FREE_KIB" || die "$EXIT_USAGE" "SONGBOOK_MIN_FREE_KIB must be a non-negative integer"
require_command find
require_command stat
require_command date
require_command df
require_command gzip
require_command sha256sum
require_command sqlite3
require_command mktemp

json_escape() {
  printf '%s' "$1" | sed 's/[\\"]/\\&/g'
}

json_safe_path() {
  path=$1
  tab=$(printf '\tX'); tab=${tab%X}
  newline=$(printf '\nX'); newline=${newline%X}
  cr=$(printf '\rX'); cr=${cr%X}
  formfeed=$(printf '\fX'); formfeed=${formfeed%X}
  backspace=$(printf '\bX'); backspace=${backspace%X}
  case $path in
    *"$tab"*|*"$newline"*|*"$cr"*|*"$formfeed"*|*"$backspace"*) return 1 ;;
    *) return 0 ;;
  esac
}

[ -d "$BACKUP_DIR" ] || die "$EXIT_DEPENDENCY" "backup directory is missing: $BACKUP_DIR"
[ ! -L "$BACKUP_DIR" ] || die "$EXIT_DEPENDENCY" "backup directory must not be a symlink: $BACKUP_DIR"
[ -f "$DB" ] || die "$EXIT_DEPENDENCY" "live database is missing: $DB"
[ ! -L "$DB" ] || die "$EXIT_DEPENDENCY" "live database must not be a symlink: $DB"
live_integrity=$(sqlite3 "$DB" 'PRAGMA quick_check;' 2>/dev/null || true)
[ "$live_integrity" = ok ] || die "$EXIT_STALE" "live database quick_check failed: $live_integrity"
available=$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')
is_uint "$available" || die "$EXIT_DEPENDENCY" "could not read free space for $BACKUP_DIR"
[ "$available" -ge "$MIN_FREE_KIB" ] || die "$EXIT_DISK" "free space ${available} KiB is below ${MIN_FREE_KIB} KiB floor"

latest=
latest_mtime=0
for candidate in "$BACKUP_DIR"/"$PREFIX"-*.sqlite.gz; do
  [ -f "$candidate" ] || continue
  [ ! -L "$candidate" ] || continue
  mtime=$(stat -c '%Y' "$candidate" 2>/dev/null || echo 0)
  is_uint "$mtime" || continue
  if [ -z "$latest" ] || [ "$mtime" -gt "$latest_mtime" ]; then
    latest=$candidate
    latest_mtime=$mtime
  fi
done
[ -n "$latest" ] || die "$EXIT_DEPENDENCY" "no backup archive found"

now=$(date +%s)
age=$((now - latest_mtime))
max_age=$((MAX_AGE_HOURS * 3600))
[ "$age" -le "$max_age" ] || die "$EXIT_STALE" "newest backup is ${age}s old (limit ${max_age}s): $latest"

checksum=$latest.sha256
[ -f "$checksum" ] || die "$EXIT_DEPENDENCY" "checksum sidecar is missing: $checksum"
expected=$(awk 'NF { print $1; exit }' "$checksum")
case $expected in ''|*[!0-9a-fA-F]*) die "$EXIT_STALE" "checksum sidecar is invalid: $checksum" ;; esac
[ "${#expected}" -eq 64 ] || die "$EXIT_STALE" "checksum sidecar is invalid: $checksum"
actual=$(sha256sum "$latest" | awk '{print $1}')
[ "$actual" = "$expected" ] || die "$EXIT_STALE" "archive checksum mismatch: $latest"
gzip -t -- "$latest" || die "$EXIT_STALE" "archive gzip validation failed: $latest"

tmp_db=$(mktemp "$BACKUP_DIR/.backup-check.XXXXXX") || die "$EXIT_STALE" "could not create check target"
cleanup() { rm -f "$tmp_db"; }
trap cleanup EXIT HUP INT TERM
gzip -cd -- "$latest" > "$tmp_db" || die "$EXIT_STALE" "could not decompress latest archive"
integrity=$(sqlite3 "$tmp_db" 'PRAGMA integrity_check;' 2>/dev/null || true)
[ "$integrity" = ok ] || die "$EXIT_STALE" "latest backup integrity_check failed: $integrity"

if [ "$JSON" = 1 ]; then
  json_safe_path "$latest" || die "$EXIT_USAGE" "--json cannot represent archive paths containing control characters"
  archive_json=$(json_escape "$latest")
  printf '{"status":"ok","archive":"%s","ageSeconds":%s,"freeKiB":%s,"integrity":"ok"}\n' "$archive_json" "$age" "$available"
else
  echo "status=ok"
  echo "archive=$latest"
  echo "age_seconds=$age"
  echo "free_kib=$available"
  echo "integrity=ok"
fi
