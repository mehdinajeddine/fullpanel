# Local backup schedules and retention

Implementation: `server/backup-schedules.ts`, integrated into `server/app.ts` and the encrypted store. Verification: 11 controlled-clock/filesystem tests in `server/backup-schedules.test.ts`, plus an application integration test for configuration, queueing and retained files. See [the parity ledger](../FEATURE-PARITY.md) for the exact runtime and browser evidence.

## Supported scheduling

Each supported database or application-volume service can have up to ten schedules. Frequencies are hourly, daily or weekly, with an explicit **UTC** minute/hour/weekday. Weekday zero is Sunday. This version does not accept arbitrary cron expressions or selectable timezones.

The configured next occurrence is stored as an ISO timestamp. A single process checks due schedules every 15 seconds, so a job can start up to one polling interval after its displayed target time, plus runtime contention. A restart after an outage attempts one missed run and then advances to the next future occurrence; it does not replay every missed interval.

The scheduler calls the same backup queue and service lock as manual backups. A busy service postpones submission for one minute. A failed backup records its error and waits for the next scheduled occurrence unless the operator chooses Run now. Disabling a schedule clears its next run but does not cancel an already running backup. Removing a schedule stops future scheduling and retains its existing backup files.

Schedule state includes `lastStatus`, `lastRunAt`, `lastBackupId`, `lastError`, and a separate `retentionError`. A cleanup failure does not change a successful dump into a failed dump. No schedule starts a Compose backup; Compose database/volume recovery remains a separate task.

## API

All routes require the ordinary owner session.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/backup-schedules` | All schedule records |
| GET | `/api/services/:id/backup-schedules` | Service schedule records |
| POST | `/api/services/:id/backup-schedules` | Create a schedule, `201` |
| PATCH | `/api/backup-schedules/:id` | Update supplied fields only |
| DELETE | `/api/backup-schedules/:id` | Remove configuration, retain backup files |
| POST | `/api/backup-schedules/:id/run` | Queue a manual run of that configuration, `202` |

Editable fields are `frequency`, `minute`, `hour`, `weekday`, `retention` and `enabled`. Defaults are daily at 02:00 UTC, retention seven, enabled. Retention must be 1–100; hour 0–23; minute 0–59; weekday 0–6. The service and schedule identifiers are not editable through PATCH.

The response contains `id`, `serviceId`, `timezone: "UTC"`, `createdAt`, `nextRunAt`, and the status fields above. Manual Run now works for a disabled schedule without enabling its automatic schedule.

## Retention boundary

Retention considers only successful backup records with both the exact schedule ID and service ID. Manual backups and other schedules are excluded. The newest configured count is retained, with a minimum of one. If a copy selected for retention is missing, empty or unsafe, cleanup stops rather than deleting an older usable copy.

The local destination is Harborlight's backup directory. Before deletion, filenames must be simple basenames, canonical paths must remain inside that directory, and files must not be symlinks. A filename also referenced by another backup record is rejected. Files are removed before their metadata is forgotten. Removing a schedule while cleanup is in progress stops further file deletion when the scheduler observes its removal.

Local retention is not offsite disaster recovery. Download a copy to independent storage. The format and consistency limitations of each backup type remain unchanged by scheduling: logical PostgreSQL/MySQL/MariaDB/MongoDB tools and volume archives are different recovery mechanisms, and live application-volume archives are not guaranteed application-consistent snapshots. Redis now calls SAVE and archives only the resulting `dump.rdb`; it does not copy its live append-only files. This archive needs a Redis-aware recovery procedure, which is not currently offered by the UI.

## Verification limits

Tests exercise UTC boundaries, year rollover, one catch-up after a long outage, overlap rejection, one-minute busy retries, failures and manual retries, partial edits, disabled/deleted services, scoped retention, missing latest files, path traversal, symlinks, metadata aliases and API validation. They use a controlled clock and disposable real files, not a production-duration scheduling soak test.

The application test uses an injected runtime and verifies that deleting a service removes its schedules while preserving downloadable backups. Real PostgreSQL dump/recovery and Redis archive creation are verified separately by the Docker smoke suite. The browser suite exercises schedule creation, Run now, pause, removal and retained download availability. Automatic execution and timing are covered by controlled-clock tests; a production-duration soak test remains pending.
