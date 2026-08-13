# Songbook operations scripts

These scripts are deployment-independent helpers for the OCI single-server
Songbook service. They operate on SQLite backups only; they do not start the
application, contact OCI, or contain credentials.

## Paths and configuration

The production convention is:

| Item | Default |
| --- | --- |
| live database | `/var/lib/songbook/songbook.sqlite` |
| backup directory | `/var/backups/songbook` |
| archive prefix | `songbook` |
| retention | 30 days |
| minimum free space | 1 GiB (`1048576` KiB) |

Every path and threshold can be overridden with the environment variables
listed below. The scripts use `umask 077`, create private backup directories,
and never print environment values.

- `SONGBOOK_DB`
- `SONGBOOK_BACKUP_DIR`
- `SONGBOOK_BACKUP_PREFIX`
- `SONGBOOK_RETENTION_DAYS`
- `SONGBOOK_MIN_FREE_KIB`
- `SONGBOOK_MAX_AGE_HOURS` (health check)
- `SONGBOOK_OFFSITE_HOOK` (optional executable hook)
- `SONGBOOK_OFFSITE_REQUIRED=1` (make hook failure fail the backup)

The live database is backed up through SQLite's `.backup` command. A live
SQLite file is never copied with `cp`; this remains safe when WAL files exist.
Each archive is gzip-tested, integrity-checked, and accompanied by a SHA-256
sidecar. Archives older than the configured retention period are removed as a
pair with their sidecars.

## Commands

```sh
scripts/ops/backup-sqlite.sh
scripts/ops/check-backup.sh
scripts/ops/restore-sqlite.sh \
  --archive /var/backups/songbook/songbook-20260813T030000Z.sqlite.gz \
  --target /var/lib/songbook/restore-drill.sqlite
```

Restore intentionally requires a target. Existing targets require
`--force`; the configured production database requires the stronger
`--force-production` flag, an exact path match, and the explicit
`--acknowledge-production-restore` flag (or
`SONGBOOK_ACKNOWLEDGE_PRODUCTION_RESTORE=I_UNDERSTAND_PRODUCTION_RESTORE`).
Production restore also refuses when the database's `-wal` or `-shm` companion
exists. Stop the app/container and checkpoint the database before attempting
that operator-only operation. Restore writes a temporary database in the
target directory, runs `PRAGMA integrity_check`, then uses an atomic rename.

Exit codes are stable for monitoring:

| Code | Meaning |
| ---: | --- |
| 0 | success / healthy |
| 2 | usage or invalid configuration |
| 3 | missing dependency, source, archive, or checksum |
| 4 | insufficient free disk space |
| 5 | lock contention |
| 6 | backup, archive, or off-site hook failure |
| 7 | stale or corrupt backup / failed restore validation |
| 8 | restore target safety refusal |

## Off-host copy hook

Set `SONGBOOK_OFFSITE_HOOK` to an operator-owned executable with mode `0700`
or `0750`. The script receives two arguments: the archive path and its
checksum path. It may call `rsync` or `ssh` using credentials held outside
this repository. Set `SONGBOOK_OFFSITE_REQUIRED=1` when local success is not
enough for the backup job to be considered healthy.

Example hook shape (kept outside the repository):

```sh
#!/bin/sh
set -eu
archive=$1
checksum=$2
rsync --archive --protect-args "$archive" "$checksum" bingus:/srv/songbook/
```

Do not put SSH keys, hosts with embedded credentials, or token values in this
repository or in a unit file. A failed optional hook is reported but does not
discard the verified local archive.

## Monitoring

Run `check-backup.sh` from the same systemd timer/cron family as the backup.
It checks free space, the newest archive age, the checksum, gzip framing, and
the restored database's SQLite integrity. Exit 0 is healthy. Non-zero output
is suitable for an existing OCI monitor or a Telegram notification wrapper;
the wrapper should send only the status and paths, never environment values.
`--json` safely escapes spaces, quotes, and backslashes; it refuses paths with
control characters that JSON cannot safely carry through a shell monitor.

The backup timer should be paired with log rotation or journald retention.
Keep enough disk for at least the configured retention window plus one active
archive. The example unit and timer in `deploy/ops/` are templates and are not
installed or enabled by this change.
