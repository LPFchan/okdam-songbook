#!/bin/sh

set -eu
umask 077

EXIT_USAGE=2
EXIT_DEPENDENCY=3
EXIT_VALIDATION=7
EXIT_SAFETY=8

PRODUCTION_DB=${SONGBOOK_DB:-/var/lib/songbook/songbook.sqlite}
ARCHIVE=
TARGET=
FORCE=0
FORCE_PRODUCTION=0
ACKNOWLEDGE_PRODUCTION=0
ACKNOWLEDGE_VALUE=I_UNDERSTAND_PRODUCTION_RESTORE

usage() {
  echo "usage: $0 --archive ARCHIVE --target TARGET [--force] [--force-production] [--acknowledge-production-restore]" >&2
}

die() {
  code=$1
  shift
  echo "songbook restore: $*" >&2
  exit "$code"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$EXIT_DEPENDENCY" "missing dependency: $1"
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --archive)
      [ "$#" -ge 2 ] || { usage; exit "$EXIT_USAGE"; }
      ARCHIVE=$2
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || { usage; exit "$EXIT_USAGE"; }
      TARGET=$2
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    --force-production) FORCE_PRODUCTION=1; shift ;;
    --acknowledge-production-restore) ACKNOWLEDGE_PRODUCTION=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit "$EXIT_USAGE" ;;
  esac
done

[ -n "$ARCHIVE" ] && [ -n "$TARGET" ] || { usage; exit "$EXIT_USAGE"; }
case $ARCHIVE in /*) ;; *) die "$EXIT_USAGE" "archive path must be absolute" ;; esac
case $TARGET in /*) ;; *) die "$EXIT_USAGE" "target path must be absolute" ;; esac
[ -f "$ARCHIVE" ] || die "$EXIT_DEPENDENCY" "archive is not a regular file: $ARCHIVE"
[ ! -L "$ARCHIVE" ] || die "$EXIT_DEPENDENCY" "archive must not be a symlink: $ARCHIVE"
[ ! -L "$PRODUCTION_DB" ] || die "$EXIT_SAFETY" "configured production database must not be a symlink: $PRODUCTION_DB"
CHECKSUM=$ARCHIVE.sha256
[ "$TARGET" != "$ARCHIVE" ] || die "$EXIT_SAFETY" "target must not be the source archive"
[ "$TARGET" != "$CHECKSUM" ] || die "$EXIT_SAFETY" "target must not be the source checksum"
[ -f "$CHECKSUM" ] || die "$EXIT_DEPENDENCY" "checksum sidecar is missing: $CHECKSUM"
[ ! -L "$CHECKSUM" ] || die "$EXIT_DEPENDENCY" "checksum must not be a symlink: $CHECKSUM"

require_command gzip
require_command sha256sum
require_command sqlite3
require_command mktemp
require_command awk
require_command mv
require_command chmod
require_command readlink
require_command stat

TARGET_DIR=$(dirname "$TARGET")
[ -d "$TARGET_DIR" ] || die "$EXIT_SAFETY" "target directory must already exist: $TARGET_DIR"
[ ! -L "$TARGET_DIR" ] || die "$EXIT_SAFETY" "target directory must not be a symlink: $TARGET_DIR"
canonical_target=$(readlink -f "$TARGET") || die "$EXIT_SAFETY" "could not resolve target path"
canonical_production=$(readlink -f "$PRODUCTION_DB") || die "$EXIT_SAFETY" "could not resolve configured production path"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  [ -f "$TARGET" ] && [ ! -L "$TARGET" ] || die "$EXIT_SAFETY" "target must be a regular non-symlink file: $TARGET"
  [ "$FORCE" = 1 ] || die "$EXIT_SAFETY" "refusing to overwrite existing target; pass --force"
  if [ "$canonical_target" != "$canonical_production" ] && [ -f "$PRODUCTION_DB" ] && [ ! -L "$PRODUCTION_DB" ]; then
    target_inode=$(stat -c '%d:%i' "$TARGET") || die "$EXIT_SAFETY" "could not inspect target file"
    production_inode=$(stat -c '%d:%i' "$PRODUCTION_DB") || die "$EXIT_SAFETY" "could not inspect production file"
    [ "$target_inode" != "$production_inode" ] || die "$EXIT_SAFETY" "target is a hard-link alias of the production database"
  fi
fi

if [ "$canonical_target" = "$canonical_production" ]; then
  [ "$FORCE_PRODUCTION" = 1 ] || die "$EXIT_SAFETY" "production path requires --force-production"
  [ "$FORCE" = 1 ] || die "$EXIT_SAFETY" "production path also requires --force"
  [ "$ACKNOWLEDGE_PRODUCTION" = 1 ] || [ "${SONGBOOK_ACKNOWLEDGE_PRODUCTION_RESTORE:-}" = "$ACKNOWLEDGE_VALUE" ] ||
    die "$EXIT_SAFETY" "production restore requires --acknowledge-production-restore or SONGBOOK_ACKNOWLEDGE_PRODUCTION_RESTORE=$ACKNOWLEDGE_VALUE"
  [ ! -e "$PRODUCTION_DB-wal" ] && [ ! -L "$PRODUCTION_DB-wal" ] || die "$EXIT_SAFETY" "production WAL exists; stop the app and checkpoint before restoring"
  [ ! -e "$PRODUCTION_DB-shm" ] && [ ! -L "$PRODUCTION_DB-shm" ] || die "$EXIT_SAFETY" "production SHM exists; stop the app and checkpoint before restoring"
fi
[ "$FORCE_PRODUCTION" = 0 ] || [ "$canonical_target" = "$canonical_production" ] || die "$EXIT_SAFETY" "--force-production requires the exact configured production path"

expected=$(awk 'NF { print $1; exit }' "$CHECKSUM")
case $expected in
  ''|*[!0-9a-fA-F]*) die "$EXIT_VALIDATION" "checksum sidecar does not contain a SHA-256 digest" ;;
esac
[ "${#expected}" -eq 64 ] || die "$EXIT_VALIDATION" "checksum sidecar does not contain a SHA-256 digest"
actual=$(sha256sum "$ARCHIVE" | awk '{print $1}')
[ "$actual" = "$expected" ] || die "$EXIT_VALIDATION" "archive checksum mismatch"
gzip -t -- "$ARCHIVE" || die "$EXIT_VALIDATION" "archive gzip validation failed"

tmp_target=$(mktemp "$TARGET_DIR/.$(basename "$TARGET").restore.XXXXXX") || die "$EXIT_SAFETY" "could not create temporary restore target"
cleanup() { rm -f "$tmp_target"; }
trap cleanup EXIT HUP INT TERM

if ! gzip -cd -- "$ARCHIVE" > "$tmp_target"; then
  die "$EXIT_VALIDATION" "could not decompress archive"
fi
integrity=$(sqlite3 "$tmp_target" 'PRAGMA integrity_check;' 2>/dev/null || true)
[ "$integrity" = ok ] || die "$EXIT_VALIDATION" "restored database integrity_check failed: $integrity"
chmod 600 "$tmp_target"
mv -f -- "$tmp_target" "$TARGET" || die "$EXIT_VALIDATION" "atomic restore rename failed"
tmp_target=
trap - EXIT HUP INT TERM

echo "status=ok"
echo "archive=$ARCHIVE"
echo "target=$TARGET"
echo "integrity=ok"
