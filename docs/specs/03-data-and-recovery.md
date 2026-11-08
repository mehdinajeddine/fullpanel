# Database, backup and recovery specification

These requirements define Harborlight's data guarantees. The product must describe exactly which guarantees its current implementation provides.

## Database provisioning

Database types have tested defaults for image version, internal port, durable mount path and initialization environment. Initial credentials are randomly generated and URI-escaped in connection strings. Database containers join the project network without publishing ports unless explicitly requested.

Separate initializing, running and unhealthy states. A running process is not enough to prove the database accepts authenticated connections. Persisted data must survive a container recreation. Changing an initialization environment variable is not password rotation: rotation needs the database's supported account-management operation.

Major-version image changes can require a migration and must not be advertised as a safe in-place upgrade. Database UI tools are a separate deployment and authentication concern. A generic console must not imply a managed browser tool exists.

## Backup model

A backup job identifies service, database or volume, destination, format, optional schedule, timezone and retention. Runs record a stable ID, start/end, success/failure, object location, size and optionally a checksum. A run succeeds only after the dump or archive finishes and the resulting object is durably written. A partial output is never listed as a valid restore point.

Use database-native logical exports for live databases. A tarball of a running database's files is not a consistent logical backup. Volume archives must say whether they are point-in-time, application-consistent, or merely a copy of live files. Harborlight may deliberately improve on the reference by retaining timestamped archives instead of destructive mirrors, but the difference must be explicit.

Stream large outputs to avoid unbounded memory consumption. Temporary files have restrictive permissions and are cleaned after failure. Do not put database passwords in process arguments when a supported safer mechanism is available. Redact secrets from job logs.

## Destinations and retention

Local destinations are useful for development and secondary copies, but the UI must accurately identify them as residing on the same host. Keep backup paths within the configured destination and reject path traversal. Remote destinations require tests for the operations actually used: upload, list, download and deletion when retention is enabled.

Retention applies only to objects owned by the exact backup job and runs after a successful new backup. Do not delete unrelated files merely because they share a directory. A cleanup failure does not erase proof of a successfully stored backup; report it separately.

Schedules persist across restarts, use an explicit timezone and expose the next run. Prevent overlapping runs for the same target. If scheduling is not implemented, do not accept a schedule field that is silently ignored.

## Restore

Before restore, show exact source object, target service/database, overwrite semantics and source creation time. Require a deliberate target confirmation for destructive restore. A restore job has its own output and cannot report success before the import tool succeeds. Support safety backup or document the operator's required recovery procedure.

Restore verification should exercise the data: read known records, compare counts, authenticate and perform a representative write. File recovery should verify filenames, contents and permissions. A successful download is not a successful restore.

## Acceptance fixtures

- PostgreSQL: create a table and row, export, change the row, restore into a disposable target, and verify the original value.
- MySQL/MariaDB: initialize application and administrative users, export/import a schema with non-ASCII text, verify row contents.
- MongoDB: export/import an authenticated database and verify a nested document and index.
- Redis: verify authenticated access and persistence after restart; do not claim a scheduled logical dump unless it has been implemented separately.
- Volume: write nested files with known checksums, archive, recover into a new volume, compare content and ownership.
- Failure paths: read-only destination, full/unavailable storage, incorrect credentials, interrupted process, zero/partial output and retention failure all produce accurate states.

## Control-plane recovery

Document the Harborlight configuration directory, required encryption keys and sessions/credentials that are or are not restored. Take a consistent backup of configuration. A new installation must be able to read the restored state without inventing identifiers or overwriting existing resources. Versioned state migrations require backup and rollback instructions.
