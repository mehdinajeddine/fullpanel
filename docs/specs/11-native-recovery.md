# Native recovery and candidate volumes

Implementation evidence is dated 2026-11-08. Real engine verification is recorded separately below; implemented code is not itself a successful recovery test.

## Recovery boundary

Harborlight restores recorded local backups into fresh, service-owned Docker volumes. It does not import into the currently active data directory. The current service remains running while an isolated candidate is initialized and the backup is imported. The candidate uses the target's exact local image ID, not a newer tag. Native authentication and readiness must succeed before the runtime switch. An application image's configured health check is honored; an image without a health check is only verified as running, not as semantically healthy.

The API requires the exact target service name, source and target write access, a deployed running target, a compatible native backup, a stored SHA-256 digest and a private runtime profile. It creates an automatic safety backup first. The selected file is pinned and checked before native processing. The service operation lock prevents overlapping deploy, backup, restore and configuration changes. This API orchestration is separate from the lower-level driver methods.

Backup profiles and applied runtime configuration are stored only in the encrypted state. They record the effective configuration used by the running service, so unsaved deployment changes cannot silently change backup or restore credentials. Future deployment and backup operations resolve the active volume mapping from this applied configuration. Public service writes cannot supply a volume mapping.

## Formats and engine compatibility

| Engine | New backup format | Import | Compatibility |
| --- | --- | --- | --- |
| PostgreSQL | `pg_dumpall` plain SQL | Streaming `psql -X -v ON_ERROR_STOP=1` | Same major version |
| MySQL | All-database SQL, routines, events and triggers | Streaming native `mysql` client | Same major/minor series |
| MariaDB | All-database SQL, routines, events and triggers | Streaming native `mariadb` client | Same major/minor series |
| MongoDB | Gzip native archive | Streaming `mongorestore --archive --gzip --drop --stopOnError` | Same major version |
| Redis | Tar/gzip containing only a `SAVE`-produced `dump.rdb` | Validated RDB extraction, then native startup | Same major version |
| Application volumes | Tar/gzip under logical mount names | Validated extraction into fresh volumes | Identical logical names and mount paths |

Metadata includes format, kind, engine version, local image ID and logical mount paths. Backups predating this metadata, integrity hash or private profile are refused for automatic restoration. Old Redis archives containing live AOF data are not treated as RDB backups. Users retain the ability to download legacy files for an independently supervised recovery.

Native restoration currently requires a single managed volume at the engine's default data path. Custom tablespaces, additional native data mounts, cross-version migrations, replica topology and Compose restoration are outside this implementation. Application backup consistency depends on the workload: copying live volume files does not provide an application transaction or filesystem snapshot.

## Database credentials

All-instance dumps can include users, roles and password hashes. A database restore therefore adopts the source backup profile's managed connection settings, including its database name and credentials. The API updates those specific target overrides and applied configuration after activation. It does not claim that the former target password continues working. Application volume recovery preserves the target application environment.

PostgreSQL imports into a cluster initialized with a temporary bootstrap account, avoiding conflicts with the source's role names. After the source owner can authenticate, the bootstrap account is set to `NOLOGIN` with a null password. PostgreSQL requires its reserved bootstrap role to retain the superuser attribute; it remains a disabled system role rather than a usable second login.

A successful loopback connection alone is not sufficient: PostgreSQL images may allow local `trust` authentication. Readiness compares the configured password with the real `pg_catalog.pg_authid` verifier, checks login permission, expiration and login identity, and uses constant-time key comparison. SCRAM-SHA-256 uses bounded asynchronous PBKDF2 and both stored/server keys; SASLprep follows PostgreSQL's documented raw-password fallback for prohibited characters. Legacy MD5 uses the exact catalog role name. The query contains no interpolated account name and never emits the verifier in progress or error messages. A stale profile is refused before dumping. See [PostgreSQL role password format](https://www.postgresql.org/docs/current/catalog-pg-authid.html) and [PostgreSQL SASL behavior](https://www.postgresql.org/docs/current/sasl-authentication.html).

Native PostgreSQL clients explicitly target local port 5432, override inherited host/host-address/options and unset service configuration variables. A database name that would be interpreted as a libpq connection string is refused. Both the configured `PGDATA` and the server's actual `data_directory` must lie within the single managed volume; a resolved symlink path is checked too. Custom tablespaces are refused. These checks prevent an apparently successful import into a temporary container filesystem from being discarded at the switch.

Restored managed settings are normalized as a complete set. Missing optional MySQL/MariaDB application user/password/database values become empty overrides, preventing stale target or project defaults from surviving silently. PostgreSQL's missing username/database default to its native `postgres` account and associated database; `PGDATA` defaults to the managed data path.

Redis first loads the restored RDB with AOF disabled. It then enables AOF, waits for successful durable rewrite completion, shuts down that temporary instance and starts the final instance with AOF enabled. This avoids silently preferring an empty AOF over the recovered RDB and preserves subsequent writes across restarts.

Passwords are not command arguments. PostgreSQL, MySQL/MariaDB and Redis clients receive private temporary environment files. MongoDB database tools receive a temporary `0600` configuration file, removed from the container and host after use. Native input is streamed from disk into `docker exec -i`; dump size is not bounded by JavaScript string memory. Backup destinations use exclusive `0600` creation and `flush: true`; command success waits for the stream to close after flushing, rather than merely receiving all stdout bytes. Progress logs contain stage descriptions rather than streamed database contents.

The native format behavior follows [PostgreSQL pg_dumpall](https://www.postgresql.org/docs/current/app-pg-dumpall.html), [MySQL SQL-format reload](https://dev.mysql.com/doc/refman/8.4/en/reloading-sql-format-dumps.html), [MongoDB mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/) and [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/). Native SQL dumps are executable database programs; the isolated candidate has no host bind mount or Docker socket and no external network during import.

## Archive checks

Archive validation is streaming, with gzip integrity, tar checksums, entry count and size bounds. It rejects absolute paths, `..`, backslashes, control characters, unknown roots, duplicate entries, conflicting file/directory paths, data after the end marker, truncation, symlinks, hard links, devices and unsupported extension headers. Redis permits only a regular `dump.rdb`. The current implementation refuses archives containing links or long-name/PAX extension headers rather than silently dropping those entries. Safe symlink restoration is not implemented.

Parent paths are tracked in a set so validation scales with path depth rather than comparing every file against all preceding entries. Extraction happens in a disposable helper with no network, a read-only root filesystem, no-new-privileges and only the newly created managed volumes mounted writable. It cannot overwrite the old runtime's volumes.

## Switch, rollback and restart journal

Every new volume is labeled with the service and restore identifiers. The final candidate preserves the active routing, resource limits and published ports. Before stopping the old container, the driver calls `onPrepared` with exact old/candidate container IDs, fresh volume mapping and restored connection settings. The API durably records this intent in encrypted state.

The old container is then stopped and renamed; the candidate takes the canonical service name, starts and is checked again. An ordinary failure removes the candidate and returns the old container to its original name and running state. Failure cleanup deletes only fresh volumes with the exact restore/service labels. Success retains the old named volumes and the automatic safety backup.

On restart, recovery checks exact IDs, service ownership, restore labels, volume mapping and authenticated readiness. A verified active candidate can be adopted into applied configuration. Otherwise, the exact previous container is restored. Unexpected ownership, an unrelated canonical container, or insufficient evidence leaves the intent unresolved and blocks further mutations instead of guessing. The interrupted job remains visibly interrupted; recovery is not reported as an uninterrupted successful job.

A crash before the prepared intent can leave an isolated candidate or new volumes without affecting active data. Their restore labels permit explicit inspection and cleanup. Automatic global Docker pruning is never performed.

## Verification

`server/database-restore.test.ts` passed 14 tests on 2026-11-08. Tests cover valid archives, traversal/link/device/extension rejection, malformed/truncated data, duplicate and conflicting paths, 5,000 sibling files, engine compatibility, legacy profile refusal, native header checks, password-free arguments, temporary client-file permissions/cleanup, real file-to-process stdin streaming and complete private output files with overwrite refusal. PostgreSQL cases include an independently reviewed RFC 7677 verifier, wrong passwords, exact MD5 role names, Unicode normalization, raw fallback, role expiration/identity, endpoint overrides, stale-profile backup refusal, managed-path/realpath checks and custom tablespace rejection. Environment normalization also checks absent source keys against existing target values.

`scripts/smoke-restore.ts` is the opt-in real-engine suite. It requires preinstalled images and selects engines through `HARBORLIGHT_RESTORE_TEST_ENGINES`. It creates separate source and target services with different credentials, writes distinct data, restores the source backup, checks recovered records, retention of old volumes, restart/redeploy persistence and recovery checkpoints. PostgreSQL also exercises failed native import and failure to persist the prepared intent. Only its exact UUID-owned resources are cleaned up. Real-engine results are added after successful completion; no pending engine is counted as verified.

On 2026-11-08, `HARBORLIGHT_RESTORE_TEST_ENGINES=postgres,redis,app node --import tsx scripts/smoke-restore.ts` passed all selected engines:

| Fixture | Verified digest | Result |
| --- | --- | --- |
| PostgreSQL `17-alpine` | `sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` | Source table rows restored into a different service with different original user/password. A Unicode password requiring SASLprep was verified against the real server; an incorrect profile failed readiness and backup before any dump was written. Invalid SQL and a failed prepared-intent callback preserved the exact original container and its target rows. Active/rolled-back recovery paths, old volume retention, new writes after restart and subsequent redeploy passed. |
| Redis `7-alpine` | `sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b` | Source key restored with source-profile authentication, AOF confirmed enabled, old volume retained, new writes survived restart and redeploy; active recovery passed. |
| Nginx application `1.28-alpine` | `sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` | Source HTML volume content served over HTTP after recovery; a nested UTF-8 filename/content, UID 123, GID 234 and mode 0640 were preserved exactly. Old volume retained, new content survived restart and redeploy; active recovery passed. |

The final three-engine run included the PostgreSQL credential/storage guards and nested file ownership assertions above and completed cleanup successfully. A driver checkpoint recovery check is distinct from killing and restarting the entire API process; process-crash integration results belong to the separate API recovery suite.

MySQL, MariaDB and MongoDB restoration code is implemented but has not completed real-engine verification at this point. Docker storage exhaustion stopped the attempted new-image setup before usable engine fixtures were available. No successful recovery claim is made for those engines yet.
