# Internal durable installation registry

This module stores reservations and management-token history in PostgreSQL. It has no HTTP routes, public authentication, DNS provider calls, proof-consumption API or activation method. A reserved installation is **pending**, with `appliedIpv4: null`. A valid pending token proves possession of that token only; it does not prove IP control or DNS activation.

## Database lifecycle

```js
import { createRegistryDatabase } from './registry/database.mjs';
const database = createRegistryDatabase({ connectionString, ca });
await database.migrate(); // Explicit operator operation; never a GET/startup side effect.
await database.readiness(); // { ready: true, schemaVersion: 1 }, or false/null.
await database.close();
```

The pool uses at most three connections, bounded connection/query/statement/idle-transaction timeouts and verified TLS. `ca` is an optional PEM bundle capped at 1 MiB. All URL query parameters are refused, including `sslmode`: the connection string cannot overwrite TLS options. Plaintext requires `allowInsecureLoopbackForTests: true` and the exact literal host `127.0.0.1` or `::1`; there is no production environment flag to disable TLS.

Only `fullpanel_registry` is migrated. A transaction-scoped PostgreSQL advisory lock serializes migration attempts. Each migration has a SHA256 checksum in `schema_migrations`; mismatches, unexpected versions or partially incompatible existing schemas fail without reset or DROP. Migration and readiness errors do not expose driver messages, credentials or hosts. Readiness checks the expected version/checksum and required tables, using an actual database query.

Operator CLI, with `DATABASE_URL` already present in the process environment and optional `COMMUNITY_DATABASE_CA_FILE`:

```sh
node registry/migrate.mjs
```

It prints only the applied flag/schema version or a safe error code. Do not put connection URLs in shell commands, tickets, logs or source files. The CLI does not enable insecure fixture mode and does not create a Heroku one-off dyno.

## Store contract

`createRegistryStore(database)` exports these internal operations:

- `reserveInstallation(ownerId, { idempotencyKey, desiredIpv4 })`
- `rotateToken(ownerId, installationId, { idempotencyKey })`
- `revokeInstallation(ownerId, installationId, { idempotencyKey })`
- `getInstallation(ownerId, installationId)`
- `verifyInstallationToken(installationId, token)` → installation or `null`.

`ownerId` is an opaque identifier supplied by a future trusted authentication layer. Passing this string is not authentication. Every owner operation scopes the SQL lookup to that owner; a different owner's installation returns the same 404 as an absent installation. Inputs reject unknown fields, malformed IDs/idempotency keys, noncanonical IPv4 and special/private IPv4 ranges using the shared domain-proof validator. Reserving an address performs no network request.

An installation has `id` (UUID v4), `serverId` (`s-` followed by 32 lowercase random hex characters), `status`, `desiredIpv4`, `appliedIpv4`, `tokenVersion`, `createdAt`, `updatedAt`, and `revokedAt`. Both IDs and ownership are immutable. Status is constrained to pending/active/revoked/suspended. This module only creates pending installations and transitions them to revoked; suspended/active states are reserved for future trusted orchestration. Revoked installations are terminal tombstones. No deletion API exists, and SQL triggers reject record deletion/truncation and identity reassignment during ordinary application operations.

Mutation results are `{ installation, token?, replayed }`. A reservation or rotation returns a 256-bit CSPRNG token prefixed `fpr_` exactly once, after successful commit. Only its SHA256 hash is stored. Old token generations remain in SQL with a revocation timestamp. Rotation atomically revokes the previous generation, inserts the new hash and appends an event. Revocation disables every current token while retaining identifiers, generations and audit history. Suspended/revoked installations cannot authenticate or rotate tokens.

Idempotency is scoped by owner and key, with a hash of the validated operation payload. An identical concurrent/retried request makes no second mutation and returns the current installation state with `replayed: true`, **without the token**. A changed payload/action with the same key returns 409. If a response containing a new token is lost, retrieve the reservation through the same idempotency key and perform a new token rotation with a new key. No raw token is retained to replay it. Unique-key collisions retry a bounded number of freshly generated server IDs and cannot reuse tombstones.

Audit events and idempotency records are append-only. PostgreSQL ownership/superuser privileges remain an operational trust boundary; these triggers are not protection against a malicious database administrator.

Safe error codes are `INVALID_REGISTRY_INPUT` (400), `INSTALLATION_NOT_FOUND` (404), `IDEMPOTENCY_CONFLICT` / `INSTALLATION_INACTIVE` (409), and `REGISTRY_CONFIGURATION_INVALID` / `REGISTRY_SCHEMA_MISMATCH` / `REGISTRY_ID_ALLOCATION_FAILED` / `REGISTRY_UNAVAILABLE` (503).

## Tests

`npm test` includes configuration/TLS unit tests. `npm run test:registry` provisions its own UUID-labeled PostgreSQL Docker container and named volume, bound only to an available loopback port. A generated fixture-only `DATABASE_URL` is passed to the test child in memory; any ambient URL is ignored. Cleanup verifies exact labels/IDs and removes only that container, volume and temporary environment file, including after test failure. It never prunes shared images or resources.

The PostgreSQL tests cover concurrent/idempotent migrations, checksums, concurrent reservations, ownership, forced identifier collisions, token hashes, atomic rotation failure, revocation, suspension, retained history, a real PostgreSQL restart and a fresh connection pool. No production schema or external DNS is touched.
