# Container port diagnostics

Implemented for single-container services. A user configuring a domain can inspect the current container's TCP listeners, then choose an internal target port without guessing from a default of 80.

## User workflow

The Domains screen offers **Inspect ports**, an observation timestamp and explicit available, partial, stopped, missing or unsupported states. Each observed listener identifies its port, IPv4/IPv6 address and binding scope. Loopback listeners cannot be selected for a domain. A wildcard or interface listener is a candidate, not proof of HTTP, TLS or proxy connectivity; IPv6-only and interface-specific binding still require verification.

Declared container ports appear separately. Docker's `Config.ExposedPorts` can include image `EXPOSE`, `--expose` and published-port configuration; it does not prove that any process is listening. UDP declarations are informational, not HTTP route candidates.

Choosing a TCP port changes only the selected domain's draft. The user must still save and deploy to apply it. No host port is published, no container restarted and no route changed during inspection. Read-only users can inspect but cannot edit a route.

Results expire for selection after 30 seconds. Errors or a changed container/deployment/status disable selection until refresh. Inspection is on demand, with one request at a time, a 20-second client timeout and cancellation when hidden, unmounted or the runtime changes. The UI does not continuously scan the service.

## Runtime and API

`GET /api/services/:id/ports` requires project read access, including scoped API-key permissions. Authorization and runtime identity are checked again after asynchronous collection or a cache hit. Revoked membership/session/key access cannot reuse a cached result.

The Docker adapter checks the canonical name, full container ID and managed/service/project ownership labels before executing fixed argument arrays for `cat /proc/net/tcp` and `cat /proc/net/tcp6`. Each operation is bounded by a five-second timeout. The container's name, labels, ID, state and start timestamp are checked again afterward. It does not read host process tables or scan external addresses.

Parsing accepts Linux little-endian IPv4/IPv6 socket tables and only TCP state `0A` (LISTEN). IPv4 loopback, IPv6 loopback and IPv4-mapped loopback are distinguished. Malformed, truncated or oversized tables are rejected; a table is limited to 1.9 MB and 2,048 listener rows. Connection rows in other TCP states do not become listeners. Duplicate bindings are removed.

The cache lasts five seconds, retains at most 128 service entries and allows at most eight collections simultaneously. Concurrent requests for the same runtime share work. Lifecycle mutations invalidate both cached and in-flight results; cache hits preserve the measurement time.

## Limits

- Compose child containers and UDP listener observation are not implemented.
- Minimal images without `cat`, disabled IPv6 or unreadable proc tables yield an unavailable or partial observation, never fabricated results.
- Stopped containers can retain declarations but have no observed listeners.
- Previously deployed but disappeared/replaced runtimes are unavailable, not reported as a successful empty inspection.
- Demo mode has no live listeners. Browser fixture values are explicitly simulated.
- A TCP listener is not an application health check. An address visible in the container namespace is not proof of external or proxy reachability.

## Verification

Eleven collector/cache/API tests cover parsing, ownership, restart races, redaction, permission scopes and revocation. The combined backend suite passes 158 tests.

`npm run test:ports` creates one UUID-owned Node 24 Alpine container with no network attachment or published host ports. It verifies real wildcard IPv4 `3000`, loopback `3001`, optional wildcard IPv6 `3002`, declared-but-not-listening `8080`, stopped state, removal and exact cleanup. IPv6 succeeded on the recorded Linux ARM64 Docker 29.4.0 run. On hosts without IPv6 support the fixture reports that specific skip.

The browser workflow covers explicit inspection, declaration/listener distinction, loopback refusal, draft-only selection, freshness/error handling and mobile layout. Current combined UI/build results are recorded in [VERIFICATION.md](../VERIFICATION.md).
