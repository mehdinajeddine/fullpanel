# Verified local restoration

Restoration consumes a completed Harborlight backup with a versioned manifest, SHA-256 digest and a private source runtime profile. Older backups without this metadata remain downloadable but cannot enter the automatic restore workflow. Demo backups contain no recoverable data; restore is available only in Docker mode.

## Request and authorization

An operator selects a successful backup and a running, deployed destination of the same service kind, then types the exact destination name. The dialog identifies the source time, overwrite effects, automatic safety backup, retained old volumes and brief service interruption. Database recovery adopts the source backup's database names and credentials; connected applications may need updated connection settings.

POST `/api/services/:id/restore` accepts `{backupId, confirmationName}` and returns a queued `RestoreJob` with HTTP 202. GET `/api/restores`, `/api/services/:id/restores` and `/api/restores/:id` expose the scoped journal. The caller needs operator permission on both source and destination projects, including when using a scoped write API key. Authority is checked again before the safety backup and runtime mutation. Jobs share the service mutation lock with deploy, backup and configuration changes.

## Pipeline

1. Resolve a regular, non-symlink file inside the local backup directory. Pin it in a private restore work directory, then verify size and SHA-256 before accessing the destination.
2. Validate the manifest, private applied source profile, engine series and archive format. PostgreSQL, MongoDB and Redis require the same major version; MySQL and MariaDB require the same major/minor series. Database restoration requires one managed volume at the supported default data path. Application recovery requires identical logical volume names and mount paths.
3. Create and verify a pre-restore backup of the destination. A failed safety backup prevents restoration.
4. Create fresh managed candidate volumes and use the exact image of the current destination runtime. Import and verify the candidate before stopping the old service. Stream database input/output and keep passwords out of command arguments.
5. Persist a private prepared-restore intent before the switch. Stop the previous container, switch the verified candidate into place and retain the old volumes. A caught switch failure attempts to restore the prior runtime.
6. Persist the new applied volume mapping and managed database environment, finish the journal and remove temporary files. Public service responses omit the internal volume mapping and private profiles.

A panel restart marks an interrupted job failed, then reconciles any prepared intent against exact managed container identities. A confirmed candidate applies the new mapping; a confirmed original runtime keeps the old mapping. An unavailable or ambiguous Docker runtime retains the intent and blocks further mutations for that service until reconciliation can be completed. It does not guess that a restore succeeded. Temporary pinned backup files are removed for resolved, terminal jobs after restart. Workspaces for unresolved intents remain available for inspection; cleanup rejects substituted parent/job symlinks and unknown job directories.

## Format boundaries

PostgreSQL uses a native cluster SQL dump; MySQL/MariaDB use native SQL dumps; MongoDB uses a compressed native archive; Redis uses a SAVE-produced RDB archive. Database clients verify readiness and saved credentials. PostgreSQL additionally compares the saved password to its real catalog verifier, because loopback trust alone does not prove password correctness; the supported native workflow requires an administrative role able to read that verifier. Native client connection parameters are controlled independently of workload environment values. Application volume archives copy live files and do not establish application-level consistency.

Volume extraction accepts regular files and directories only, within the declared roots. It rejects traversal, duplicate paths, symlinks, hardlinks, devices, extended tar headers, invalid checksums and truncated archives before extraction. Backups containing unsupported entry types cannot currently be restored automatically. The extraction helper has no network and a read-only root filesystem; only new candidate volumes are writable.

Old volumes and the safety backup remain after success. They consume space and are not automatically deleted. Compose restoration, uploaded external archives, cross-engine migrations and remote storage are outside this workflow. Local backups and the encryption key must also be copied off the host for host-loss recovery.

## Acceptance

Deterministic tests cover dual-project permissions, checksum and path refusal, safety-backup failure, shared locks, revoked authority, pending versus applied configuration, interrupted-job state and prepared-intent reconciliation. Real engine fixtures must prove record/file contents, authentication and persistence after the restore, plus preservation of old data on refused or failed recovery. Browser success alone is not runtime evidence; current passing scopes are recorded in `docs/VERIFICATION.md`.
