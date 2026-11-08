# Verification — 2026-11-08

This is a development verification record, not a production-readiness certification or a claim of full reference parity. The [91-criterion ledger](FEATURE-PARITY.md) remains the feature backlog.

## Passing checks

| Check | Result and scope |
| --- | --- |
| `npm run typecheck` | All application, server and test TypeScript compiles. |
| `npm test` | 90 API/state, access-control, credential, proxy, CLI, deployment-trigger, scheduler, environment and restore/archive tests pass, including PostgreSQL verifier, native data-path boundaries, inherited credential clearing and safe temporary-file cleanup after restart. Injected runtimes are used for deterministic API tests; Git askpass invokes the real Git process. |
| `npm run test:e2e` | 14 Chromium workflows pass against a built production server using the explicit demo adapter. |
| `npm run test:docker` | Real Nginx deployment/HTTP/lifecycle/logs, failed-pull preservation, inline Dockerfile build, PostgreSQL password authentication across containers (including wrong-password rejection), persistence and dump restoration into another instance, Redis authentication/restart persistence/RDB-only archive, Compose lifecycle and retained named volume. |
| `npm run test:proxy` | Real Traefik host/path boundaries, one-level wildcard isolation, exact-host priority, prefix removal, bcrypt password denial/success/rotation, removal of upstream Authorization and HTTP→HTTPS redirect. CPU and memory limits match Docker inspection. |
| `npm run test:credentials` | Real disposable authenticated registry: anonymous access fails, scoped credential pulls and deploys Nginx successfully, wrong/revoked/mismatched credentials preserve the old runtime; logs omit secrets. Public Git HTTPS connectivity also succeeds. |
| `npm run test:git` | Actual API-triggered HTTPS clone and subdirectory build of an official Docker fixture; HTTP response, exact commit/OCI revision, forced dependency/build steps without cache and durable deployment history. |
| `npm run test:environment` | Real app/Compose inheritance, empty overrides, literal values, save/deploy separation, old-secret redaction and project isolation. |
| `HARBORLIGHT_RESTORE_TEST_ENGINES=postgres,redis,app npm run test:restore` | Cross-service recovered SQL rows, Redis keys and application HTTP content; retained old volumes and restart/redeploy persistence. Failed SQL import and failed checkpoint persistence preserve the original PostgreSQL container and records. The final fixture verifies a real SASLprep Unicode password and rejects stale PostgreSQL profiles before backup despite loopback trust. Application recovery preserves nested UTF-8 file content, UID/GID and mode. |
| `npm run test:restore-recovery` | Two real SIGKILLs: immediately after a prepared checkpoint and immediately after runtime activation, both before normal completion. Restart verifies original rollback or candidate adoption, SQL data, database credentials, retained old volumes, sessions, resolved workspace cleanup and persistence after redeploy. |
| `npm run test:restore-ui` | Real PostgreSQL restoration triggered through desktop UI, exact confirmation, data/credentials verified over the private network, safety backup downloaded and checked, original source unchanged, old volume retained, new volume active, journal/session/credentials survive API restart, 390px mobile layout verified. |
| `npm run build` | Production browser and server bundles build successfully. |
| `docker build -t harborlight:local .` | The Linux arm64 application container builds from source. |
| `npm run test:package` | Built container serves the interface, creates accounts/scoped keys, deploys Nginx through its real API/Docker adapter, includes Compose/Buildx, and recovers encrypted configuration, sessions, access records and project environments after SIGKILL/restart; key revocation remains effective. |
| `npm audit --json` | Zero known vulnerabilities reported for the final locked dependency graph on this date. |

The fourteen browser workflows cover owner setup and reload; project/application creation and saved environment; deployment/log filtering/stop/start; database backup and typed deletion; mobile navigation without horizontal overflow; project editing and keyboard search; deployment token generation/rotation/revocation; backup schedule creation/run/pause/removal while retaining files; template installation and persisted dark appearance; account creation and viewer boundaries; one-time API-key issuance and revocation; advanced routing and write-only proxy password rotation; private image credential save/remove; project environment import/overrides and honest demo restore limits. Several checks are grouped within one workflow.

Desktop (1440×1000) and mobile (390×844) screenshots were visually inspected. They contain demonstration data: [dashboard](images/dashboard.png), [mobile](images/mobile.png), [dark settings](images/settings-dark.png), [team and access](images/team-access.png), [routing](images/domain-routing.png), [mobile routing](images/domain-routing-mobile.png). New real-runtime captures were also inspected: [restore confirmation](images/restore-confirmation.png), [restore progress](images/restore-progress.png) and [persisted mobile journal](images/restore-journal-mobile.png). Fonts are bundled locally with their OFL licenses.

The integration cycle found and corrected three regressions: isolated Docker auth configuration initially hid host-installed Compose/Buildx plugins; delayed modal focus could redirect fast input into another field; cross-project domain subpaths could capture another project's traffic. Passing checks now exercise plugin discovery, modal editing and hostname reservation. The restoration cycle additionally found PostgreSQL loopback trust accepting a wrong password and modal table styles causing mobile overflow. The final implementation verifies the actual PostgreSQL role secret, isolates native connection parameters, validates native data paths and renders dialogs through a portal. A cross-container password check and responsive layout check verify these corrections. Backend permission tests also reject alternate encoded paths and scope escalation. These are tested defenses, not a claim of exhaustive security review.

## Environment and image provenance

Host checks used macOS arm64, Node 23.11.0, Docker Engine 29.4.0 through OrbStack. The application container uses Node 24 on Alpine. CI declares Node 24/Linux; the remote GitHub CI run has not occurred because publication is pending.

The final local application image is `harborlight:local`, image ID `sha256:28bb54b1107cd25aeef9f44255af80f116e7a1c296c076b59eccbc160ed452ae`. Its package test includes the new project environment API, real inherited workload values, restoration-route registration, production dependencies and persistence after SIGKILL.

| Runtime tag used by the tests | Resolved repository digest |
| --- | --- |
| `nginx:1.28-alpine` | `sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236` |
| `postgres:17-alpine` | `sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac` |
| `redis:7-alpine` | `sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b` |
| `traefik:v3.6` | `sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d` |

Tags can change. These digests identify the distributions resolved in this session; the scripts intentionally retain readable tags for maintenance. The Easypanel reference image has its own independently recorded digest in [REFERENCE-ANALYSIS.md](REFERENCE-ANALYSIS.md).

The Git build fixture is [docker/awesome-compose](https://github.com/docker/awesome-compose), `nginx-golang/backend`, observed commit `30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562`. Its Go 1.18 image is an external test fixture, not a recommended production template. The smoke test records the resolved revision on each run rather than assuming that a mutable branch is unchanged.

## Limits that remain material

- There is no full Easypanel feature parity. Thirty-one ledger rows remain entirely pending at this milestone; other rows state partial scope.
- The 14 main browser workflows use the demo runtime. The dedicated restoration browser test, Docker scripts and package test verify real infrastructure operations.
- HTTPS/ACME issuance was not exercised against a real owned domain. Only HTTP routing is verified.
- Private hosted Git deployment remains untested; exact-repository askpass behavior and public Git deployment are verified separately. Source credentials support HTTPS tokens and pulled images, not SSH deploy keys, private Dockerfile base images or private Compose images.
- MySQL, MariaDB, MongoDB and the remaining application templates are configured in code but have not received the same runtime checks as PostgreSQL/Redis/Nginx. Attempts to download/run the new engines failed because Docker storage was full; only task-owned reference images and explicitly identified task build caches were removed. Those engines are included in a separate CI matrix but no remote CI success is claimed.
- Restoration requires recorded local backups with fresh metadata and compatible engines. It does not support uploaded external archives, Compose, cross-version migrations, custom PostgreSQL tablespaces, or tar archives containing links/extended headers. Original volumes are retained and require explicit later cleanup; application archives copy live files without an application-level consistency guarantee.
- Schedules use UTC and a 15-second polling loop. Controlled-clock tests verify scheduling and retention rules; no long-running production soak test has been performed.
- Standalone container replacement can interrupt traffic. Start success is not application readiness, and no zero-downtime guarantee is claimed.
- Project permissions protect the control-plane API. Domain applications share a proxy Docker network and can reach each other directly on that network; operators must be trusted. The panel is not a hostile-tenant isolation boundary.
- Metrics combine Docker CPU statistics with the panel process host's memory/disk measurements. Remote daemons and containerized hosts can have different measurement scopes.
- The GitHub destination and authenticated publication access are still required. No GitHub repository URL or successful push is claimed.
