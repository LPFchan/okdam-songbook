# OCI backup operation templates

These files are examples for the eventual OCI host. They are not installed,
enabled, or connected to a live service by this repository change. Copy them
into the host's systemd configuration only after reviewing paths, user/group,
permissions, log retention, and the operator's off-host backup hook.

The service runs the repository's `scripts/ops/backup-sqlite.sh` with a private
environment file. The timer runs daily at 03:15 UTC with a randomized delay.
The freshness check can be run by an existing monitoring timer or by a small
notification wrapper that maps non-zero exit codes to Telegram alerts.

Keep secrets and SSH credentials out of these templates. If an off-host copy
is required, set `SONGBOOK_OFFSITE_HOOK` to a mode-0700/0750 operator-owned
executable path in the environment file. The hook receives the archive and
checksum paths as arguments.

The expected persistent directories are `/var/lib/songbook` for the live
database and `/var/backups/songbook` for local archives. Backups must be on a
filesystem with enough room for the configured retention window and one
active archive. Journald or the host's existing log rotation must retain job
failure output long enough to investigate it.

Before a production restore, stop the application/container, checkpoint the
database, verify that `/var/lib/songbook/songbook.sqlite-wal` and
`/var/lib/songbook/songbook.sqlite-shm` do not exist, and invoke the restore
with both force flags plus the explicit production acknowledgement. A normal
restore drill always targets a separate file. The acknowledgement flag or
environment value is intentionally absent from the example environment file.
