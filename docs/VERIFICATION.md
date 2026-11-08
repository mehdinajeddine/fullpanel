# Verification — initial implementation, 2026-11-08

This is a development verification record, not a production-readiness certification or a claim of full reference parity. The [91-criterion ledger](FEATURE-PARITY.md) remains the feature backlog.

## Passing checks

| Check | Result and scope |
| --- | --- |
| `npm run typecheck` | All application, server and test TypeScript compiles. |
| `npm test` | 35 API/state, deployment-trigger, scheduler and retention tests pass. Injected runtimes are used for deterministic API tests. |
| `npm run test:e2e` | 8 Chromium workflows pass against a built production server using the explicit demo adapter. |
| `npm run test:docker` | Real Nginx deployment/HTTP/lifecycle/logs, failed-pull preservation, inline Dockerfile build, PostgreSQL password authentication across containers (including wrong-password rejection), persistence and dump restoration into another instance, Redis authentication/restart persistence/RDB-only archive, Compose lifecycle and retained named volume. |
| `npm run test:proxy` | Real Traefik HTTP hostname routing; unmatched hostname returns 404. CPU and memory limits match Docker inspection. |
| `npm run build` | Production browser and server bundles build successfully. |
| `docker build -t harborlight:local .` | The Linux arm64 application container builds from source. |
| `npm run test:package` | Built container serves the interface, creates an owner, deploys Nginx through its real API/Docker adapter, includes Compose/Buildx, and recovers encrypted configuration and sessions after SIGKILL/restart. |
| `npm audit --json` | Zero known vulnerabilities reported for the final locked dependency graph on this date. |

The eight browser workflows cover owner setup and reload; project/application creation and saved environment; deployment/log filtering/stop/start; database backup and typed deletion; mobile navigation without horizontal overflow; project editing and keyboard search; deployment token generation/rotation/revocation; backup schedule creation/run/pause/removal while retaining files; template installation and persisted dark appearance. Several checks are grouped within one workflow.

Desktop (1440×1000) and mobile (390×844) screenshots were visually inspected. They contain demonstration data: [dashboard](images/dashboard.png), [mobile](images/mobile.png), [dark settings](images/settings-dark.png). Fonts are bundled locally with their OFL licenses.

## Environment and image provenance

Host checks used macOS arm64, Node 23.11.0, Docker Engine 29.4.0 through OrbStack. The application container uses Node 24 on Alpine. CI declares Node 24/Linux; the remote GitHub CI run has not occurred because publication is pending.

| Runtime tag used by the tests | Resolved repository digest |
| --- | --- |
| `nginx:1.28-alpine` | `sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` |
| `postgres:17-alpine` | `sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` |
| `redis:7-alpine` | `sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b` |
| `traefik:v3.6` | `sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d` |

Tags can change. These digests identify the distributions resolved in this session; the scripts intentionally retain readable tags for maintenance. The Easypanel reference image has its own independently recorded digest in [REFERENCE-ANALYSIS.md](REFERENCE-ANALYSIS.md).

## Limits that remain material

- There is no full Easypanel feature parity. Forty ledger rows remain entirely pending at this milestone; other rows state partial scope.
- Browser operations use the demo runtime. The Docker scripts and package test separately verify real infrastructure operations.
- HTTPS/ACME issuance was not exercised against a real owned domain. Only HTTP routing is verified.
- Public Git deployment, exact commit capture and forced rebuild are implemented and API-tested; a real external Git build is not yet part of the integration evidence.
- MySQL, MariaDB, MongoDB and the remaining application templates are configured in code but have not received the same runtime checks as PostgreSQL/Redis/Nginx.
- PostgreSQL restore was performed by the test using native tools. The product still has no restore API or UI. Redis archive creation and restart persistence do not prove a complete disaster-recovery workflow.
- Schedules use UTC and a 15-second polling loop. Controlled-clock tests verify scheduling and retention rules; no long-running production soak test has been performed.
- Standalone container replacement can interrupt traffic. Start success is not application readiness, and no zero-downtime guarantee is claimed.
- Metrics combine Docker CPU statistics with the panel process host's memory/disk measurements. Remote daemons and containerized hosts can have different measurement scopes.
- The GitHub destination and authenticated publication access are still required. No GitHub repository URL or successful push is claimed.
