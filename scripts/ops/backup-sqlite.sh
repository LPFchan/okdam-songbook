#!/bin/sh

set -eu
umask 077

EXIT_USAGE=2
EXIT_DEPENDENCY=3
EXIT_DISK=4
EXIT_LOCK=5
EXIT_FAILURE=6

DB=${SONGBOOK_DB:-/var/lib/songbook/songbook.sqlite}
BACKUP_DIR=${SONGBOOK_BACKUP_DIR:-/var/backups/songbook}
PREFIX=${SONGBOOK_BACKUP_PREFIX:-songbook}
RETENTION_DAYS=${SONGBOOK_RETENTION_DAYS:-30}
MIN_FREE_KIB=${SONGBOOK_MIN_FREE_KIB:-1048576}
OFFSITE_HOOK=${SONGBOOK_OFFSITE_HOOK:-}
OFFSITE_REQUIRED=${SONGBOOK_OFFSITE_REQUIRED:-0}

die() {
  code=$1
  shift
  echo "songbook backup: $*" >&2
  exit "$code"
}

is_uint() {
  case $1 in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$EXIT_DEPENDENCY" "missing dependency: $1"
}

sql_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

check_free_space() {
  available=$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
  is_uint "$available" || die "$EXIT_FAILURE" "could not read free space for $BACKUP_DIR"
  [ "$available" -ge "$MIN_FREE_KIB" ] || die "$EXIT_DISK" "free space ${available} KiB is below ${MIN_FREE_KIB} KiB floor"
}

[ -n "$PREFIX" ] || die "$EXIT_USAGE" "SONGBOOK_BACKUP_PREFIX must not be empty"
case $PREFIX in
  *[!A-Za-z0-9._-]*) die "$EXIT_USAGE" "SONGBOOK_BACKUP_PREFIX contains unsafe characters" ;;
esac
is_uint "$RETENTION_DAYS" || die "$EXIT_USAGE" "SONGBOOK_RETENTION_DAYS must be a non-negative integer"
is_uint "$MIN_FREE_KIB" || die "$EXIT_USAGE" "SONGBOOK_MIN_FREE_KIB must be a non-negative integer"
case $OFFSITE_REQUIRED in 0|1) ;; *) die "$EXIT_USAGE" "SONGBOOK_OFFSITE_REQUIRED must be 0 or 1" ;; esac

require_command sqlite3
require_command gzip
require_command sha256sum
require_command df
require_command awk
require_command find
require_command mktemp
require_command date

[ -f "$DB" ] || die "$EXIT_DEPENDENCY" "database is not a regular file: $DB"
[ ! -L "$DB" ] || die "$EXIT_DEPENDENCY" "database must not be a symlink: $DB"

mkdir -p "$BACKUP_DIR" || die "$EXIT_FAILURE" "could not create backup directory: $BACKUP_DIR"
[ ! -L "$BACKUP_DIR" ] || die "$EXIT_FAILURE" "backup directory must not be a symlink: $BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
check_free_space

LOCK_FILE=$BACKUP_DIR/.backup.lock
lock_mode=none
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "$EXIT_LOCK" "another backup is already running"
  lock_mode=flock
else
  LOCK_DIR=$BACKUP_DIR/.backup.lock.d
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "$EXIT_LOCK" "another backup is already running"
  fi
  lock_mode=mkdir
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT HUP INT TERM
fi

timestamp=$(date -u '+%Y%m%dT%H%M%SZ') || die "$EXIT_FAILURE" "could not create timestamp"
# Include the process id so two successful runs in one second cannot publish
# over one another or turn a valid backup into a false failure.
timestamp=${timestamp}-$$
archive=$BACKUP_DIR/$PREFIX-$timestamp.sqlite.gz
checksum=$archive.sha256
tmp_db=$(mktemp "$BACKUP_DIR/.${PREFIX}.sqlite.XXXXXX") || die "$EXIT_FAILURE" "could not create temporary database"
tmp_archive=$(mktemp "$BACKUP_DIR/.${PREFIX}.archive.XXXXXX") || die "$EXIT_FAILURE" "could not create temporary archive"
trap 'rm -f "$tmp_db" "$tmp_archive"; if [ "$lock_mode" = mkdir ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi' EXIT HUP INT TERM

rm -f "$tmp_db" "$tmp_archive"
db_sql=$(sql_quote "$tmp_db")
if ! sqlite3 "$DB" ".backup '$db_sql'"; then
  die "$EXIT_FAILURE" "SQLite online backup failed"
fi

integrity=$(sqlite3 "$tmp_db" 'PRAGMA integrity_check;' 2>/dev/null || true)
[ "$integrity" = ok ] || die "$EXIT_FAILURE" "backup integrity_check failed: $integrity"

gzip -c -- "$tmp_db" > "$tmp_archive" || die "$EXIT_FAILURE" "gzip archive creation failed"
gzip -t -- "$tmp_archive" || die "$EXIT_FAILURE" "gzip archive validation failed"
[ ! -e "$archive" ] || die "$EXIT_FAILURE" "archive already exists: $archive"
mv "$tmp_archive" "$archive" || die "$EXIT_FAILURE" "could not publish archive"
tmp_archive=

(cd "$BACKUP_DIR" && sha256sum "$(basename "$archive")") > "$checksum" || die "$EXIT_FAILURE" "could not write checksum"
chmod 600 "$archive" "$checksum" 2>/dev/null || true
check_free_space

if [ -n "$OFFSITE_HOOK" ]; then
  [ -f "$OFFSITE_HOOK" ] && [ -x "$OFFSITE_HOOK" ] || die "$EXIT_USAGE" "off-site hook must be an executable file: $OFFSITE_HOOK"
  if ! "$OFFSITE_HOOK" "$archive" "$checksum"; then
    if [ "$OFFSITE_REQUIRED" = 1 ]; then
      die "$EXIT_FAILURE" "required off-site hook failed"
    fi
    echo "warning=optional off-site hook failed" >&2
  fi
fi

find "$BACKUP_DIR" -type f -name "$PREFIX-*.sqlite.gz" -mtime +"$RETENTION_DAYS" -print 2>/dev/null |
while IFS= read -r old_archive; do
  [ "$old_archive" = "$archive" ] && continue
  rm -f -- "$old_archive" "$old_archive.sha256"
done

archive_bytes=$(wc -c < "$archive" | awk '{print $1}')
echo "status=ok"
echo "archive=$archive"
echo "checksum=$checksum"
echo "bytes=$archive_bytes"
echo "integrity=ok"
