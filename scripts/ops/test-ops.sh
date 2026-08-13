#!/bin/sh

set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)
BACKUP="$ROOT/scripts/ops/backup-sqlite.sh"
RESTORE="$ROOT/scripts/ops/restore-sqlite.sh"
CHECK="$ROOT/scripts/ops/check-backup.sh"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "SKIP: sqlite3 is not installed"
  exit 0
fi

TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/songbook-ops-test.XXXXXX")
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT HUP INT TERM

db=$TEST_DIR/songbook.sqlite
backups=$TEST_DIR/backups
restore=$TEST_DIR/restore.sqlite
mkdir "$backups"

sqlite3 "$db" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
INSERT INTO songs(title) VALUES ('WAL-safe song');
SQL

SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$backups" SONGBOOK_MIN_FREE_KIB=0 \
  "$BACKUP" > "$TEST_DIR/backup.out"
archive=$(sed -n 's/^archive=//p' "$TEST_DIR/backup.out")
[ -n "$archive" ] && [ -f "$archive" ] && [ -f "$archive.sha256" ]

SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$backups" SONGBOOK_MIN_FREE_KIB=0 \
  SONGBOOK_MAX_AGE_HOURS=26 "$CHECK" --json | tee "$TEST_DIR/check.out"
grep -q '"integrity":"ok"' "$TEST_DIR/check.out"

SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$restore" > "$TEST_DIR/restore.out"
[ "$(sqlite3 "$restore" 'SELECT title FROM songs;')" = 'WAL-safe song' ]
grep -q '^integrity=ok$' "$TEST_DIR/restore.out"

if SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$restore" >/dev/null 2>&1; then
  echo "FAIL: restore overwrote an existing target without --force" >&2
  exit 1
fi

SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$restore" --force >/dev/null

if SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$db" --force >/dev/null 2>&1; then
  echo "FAIL: restore overwrote production path without --force-production" >&2
  exit 1
fi

if SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$db" --force --force-production >/dev/null 2>&1; then
  echo "FAIL: restore overwrote production path without acknowledgement" >&2
  exit 1
fi

: > "$db-wal"
if SONGBOOK_DB="$db" SONGBOOK_ACKNOWLEDGE_PRODUCTION_RESTORE=I_UNDERSTAND_PRODUCTION_RESTORE \
  "$RESTORE" --archive "$archive" --target "$db" --force --force-production >/dev/null 2>&1; then
  echo "FAIL: restore ignored a live WAL companion" >&2
  exit 1
fi
rm -f "$db-wal"

: > "$db-shm"
if SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$db" --force --force-production \
  --acknowledge-production-restore >/dev/null 2>&1; then
  echo "FAIL: restore ignored a live SHM companion" >&2
  exit 1
fi
rm -f "$db-shm"

SONGBOOK_DB="$db" SONGBOOK_ACKNOWLEDGE_PRODUCTION_RESTORE=I_UNDERSTAND_PRODUCTION_RESTORE \
  "$RESTORE" --archive "$archive" --target "$db" --force --force-production >/dev/null

if SONGBOOK_DB="$db" "$RESTORE" --archive "$archive" --target "$TEST_DIR/../$(basename "$TEST_DIR")/songbook.sqlite" --force >/dev/null 2>&1; then
  echo "FAIL: production path alias bypassed exact-file guard" >&2
  exit 1
fi

bad_archive=$backups/bad.sqlite.gz
cp "$archive" "$bad_archive"
printf '%s  %s\n' "$(printf '%064d' 0)" "$(basename "$bad_archive")" > "$bad_archive.sha256"
if SONGBOOK_DB="$db" "$RESTORE" --archive "$bad_archive" --target "$TEST_DIR/bad-restore.sqlite" >/dev/null 2>&1; then
  echo "FAIL: checksum mismatch did not fail" >&2
  exit 1
fi

quoted_backups=$TEST_DIR/'backup "quoted dir'
mkdir "$quoted_backups"
SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$quoted_backups" SONGBOOK_MIN_FREE_KIB=0 \
  "$BACKUP" >/dev/null
SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$quoted_backups" SONGBOOK_MIN_FREE_KIB=0 \
  SONGBOOK_MAX_AGE_HOURS=26 "$CHECK" --json > "$TEST_DIR/quoted-check.json"
if command -v node >/dev/null 2>&1; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' "$TEST_DIR/quoted-check.json"
fi
grep -q '\\\"quoted dir' "$TEST_DIR/quoted-check.json"

if SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$backups" SONGBOOK_MIN_FREE_KIB=9999999999 \
  "$BACKUP" >/dev/null 2>&1; then
  echo "FAIL: low-space floor did not fail" >&2
  exit 1
fi

old_archive=$backups/songbook-20000101T000000Z.sqlite.gz
cp "$archive" "$old_archive"
cp "$archive.sha256" "$old_archive.sha256"
touch -d '40 days ago' "$old_archive" "$old_archive.sha256"
SONGBOOK_DB="$db" SONGBOOK_BACKUP_DIR="$backups" SONGBOOK_RETENTION_DAYS=30 SONGBOOK_MIN_FREE_KIB=0 \
  "$BACKUP" >/dev/null
[ ! -e "$old_archive" ] && [ ! -e "$old_archive.sha256" ]

touch -d '3 days ago' "$backups"/songbook-*.sqlite.gz
if SONGBOOK_BACKUP_DIR="$backups" SONGBOOK_MAX_AGE_HOURS=26 SONGBOOK_MIN_FREE_KIB=0 \
  "$CHECK" >/dev/null 2>&1; then
  echo "FAIL: stale backup did not fail" >&2
  exit 1
fi

echo "PASS: backup, WAL-safe restore, checksum/integrity, retention, disk, freshness, and overwrite guards"
