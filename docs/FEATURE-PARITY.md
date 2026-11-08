# Feature parity ledger

Baseline: Easypanel image **2.38.0**, digest recorded in [reference analysis](REFERENCE-ANALYSIS.md), and official docs read on **2026-11-08**. Harborlight is an original implementation. This ledger tracks outcomes, not visual duplication or API compatibility.

## Status and evidence rules

Updated against the implementation and the verification runs below on **2026-11-08**. Status applies to the stated scope, not the whole reference product. `partial` means a stated subset works. `implemented` means the acceptance criterion works in the intended runtime. `verified` additionally has a named passing test or recorded manual result. An API-only implementation does not satisfy an end-user workflow criterion. Browser checks use the explicit demo adapter; separate Docker checks exercise the real adapter. No completion percentage should collapse these distinctions.

Priority: **P0** usable secure foundation; **P1** core operational parity; **P2** advanced parity. Evidence labels: **D** official documentation; **S** installer/image static inspection; **I** Harborlight product requirement inferred from the task. Links in the feature column identify the primary reference. Static evidence is described in `REFERENCE-ANALYSIS.md`.

## Foundation and projects

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| F01 | Initial setup and sign-in (S) | P0 | First administrator is created once; subsequent visits require authentication. | verified — owner bootstrap/API protection [E1], browser setup and reload [E5] |
| F02 | Session lifecycle (S) | P0 | Login, reload, expiry and logout enforce the same identity server-side. | verified — cookie/login/logout protection [E1], session reload [E5]; expiry implemented |
| F03 | Project CRUD (S) | P0 | Create, inspect, rename and remove an empty project; reject conflicting identifiers. | verified — CRUD/conflicts and partial PATCH [E1]; create/edit browser flows [E5] |
| F04 | Project service inventory (S) | P0 | Project view shows services and actual runtime states; empty/error states remain usable. | verified — UI inventory [E5], real Docker status transitions [E2]; disconnected status remains last-known |
| F05 | Project environment (S) | P1 | Shared values reach child services with documented override precedence. | pending |
| F06 | Service notes (S) | P1 | Notes save, reload and remain scoped to the selected service. | implemented — persisted notes API and service settings UI; no dedicated browser assertion |
| F07 | Search and navigation (I) | P0 | Search reaches a service; browser history and direct links preserve selection. | verified for main flows — keyboard palette reaches the selected service and direct route survives reload [E5]; full history/accessibility audit pending |
| F08 | Destructive-action clarity (I) | P0 | Delete identifies target and retained/deleted data before execution. | verified — nonempty-project guard and retained data [E1], typed service deletion [E5] |
| F09 | Authentication abuse controls (I) | P0 | Rate limits, input bounds, origin protection and secure password hashing are tested. | partial — scrypt, session/origin checks and bounded inputs [E1]; login rate limiter implemented, comprehensive security review pending |
| F10 | Secret handling (I) | P0 | Secrets are not printed in activity, logs, Git or API errors. | partial — encrypted state and output/header redaction [E1]; authenticated owner inventory responses still include environment values |
| F11 | Durable configuration (I) | P0 | Restart preserves state; failed writes cannot silently corrupt accepted configuration. | verified — encrypted restart, writer lock, failed-write rollback and fail-closed behavior [E1] |
| F12 | Honest demo/runtime distinction (I) | P0 | Demo data is labeled; Docker failure never produces a fake successful operation. | verified — labeled browser demo [E5], truthful failed jobs [E1], real failed image pull [E2] |

## Applications and deployment

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| A01 | [Image source](https://easypanel.io/docs/services/app) (D,S) | P0 | Pull a public image, deploy it, and show failure output when pulling fails. | verified — real Nginx pull/deploy and failed pull [E2]; browser deployment flow [E5] |
| A02 | Private registry (D,S) | P1 | Authenticate without persisting credentials in command arguments or public logs. | pending |
| A03 | Public Git source (D,S) | P0 | Clone chosen branch, build chosen directory and record the deployed revision. | implemented — public HTTPS Git + branch/context, resolved commit and OCI revision label; real Git integration run pending |
| A04 | Private Git / deploy key (D,S) | P1 | Configure a repository-scoped credential; revoke or rotate it. | pending |
| A05 | GitHub connection and auto-deploy (D,S) | P1 | Verify incoming push authorization and branch before enqueueing deployment. | pending |
| A06 | Source archive upload (D,S) | P2 | Reject traversal and oversized archives; build accepted source. | pending |
| A07 | Inline Dockerfile (D,S) | P1 | Save and build an isolated context containing the supplied Dockerfile. | verified — real isolated inline Dockerfile build and HTTP result [E2] |
| A08 | [Repository Dockerfile builder](https://easypanel.io/docs/builders) (D,S) | P0 | Resolve context and Dockerfile within the source boundary. | implemented — Dockerfile/context validation and realpath containment; real repository fixture still unverified |
| A09 | Buildpacks builder (D,S) | P2 | Build and run a representative supported app with an explicit builder version. | pending |
| A10 | Nixpacks builder (D,S) | P2 | Apply documented build overrides and surface detection errors. | pending |
| A11 | Railpack builder (D,S) | P2 | Build from detected source, honor overrides, protect build secrets. | pending |
| A12 | Save versus deploy (D) | P0 | Saved changes show unapplied state until a successful deploy. | verified — saved configuration and deployment timestamps [E1], browser save/reload then deploy [E5] |
| A13 | Deployment history and output (D,S) | P0 | Each attempt has persisted state, timestamps, source and bounded output. | partial — attempts, timestamps, bounded output and Git commit; image digest/full immutable configuration snapshot absent |
| A14 | Rebuild without cache (D) | P1 | Requested rebuild bypasses Docker build cache and reports that choice. | implemented — Git/inline Dockerfile forceRebuild uses --no-cache and --pull; added after baseline E2, real bypass check pending |
| A15 | Start, stop, restart (D,S) | P0 | Each action changes the selected runtime and is reflected after refresh. | verified — real Docker lifecycle/status [E2], browser stop/start [E5] |
| A16 | Deploy trigger and token rotation (D,S) | P1 | Authorized trigger queues work; old tokens fail immediately after rotation. | verified — scoped bearer generation/rotation/revocation and queue integration [E1]; trigger generation/rotation/revocation UI covered by [E5] |
| A17 | Rollback (I) | P1 | Reapply a retained successful release without guessing its source. | pending |
| A18 | Concurrency and recovery (I) | P0 | Concurrent deploys are serialized; restart marks orphaned work accurately. | partial — concurrent operations rejected with 409 and interrupted jobs marked failed [E1]; no waiting-job serialization or automatic resume |

## Runtime, network and storage

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| R01 | [Environment editor](https://easypanel.io/docs/services/app) (D,S) | P0 | Preserve supported values and report malformed lines before saving. | partial — validated key/value editor, secret masking and persistence [E1,E5]; no .env text import or multiline values |
| R02 | Named persistent volumes (D,S) | P0 | Data survives redeployment; scope and deletion behavior are explicit. | verified — named-volume persistence across PostgreSQL replacement [E2]; delete retains volumes |
| R03 | Bind and file mounts (D,S) | P1 | Mount desired source with validation and an accurate access warning. | pending |
| R04 | CPU and memory limits (D,S) | P0 | Configured limits appear in Docker runtime inspection. | verified — Docker inspect confirms 0.5 CPU / 128 MiB limits [E3]; UI supports limits, not reservations |
| R05 | Port publishing (D,S) | P1 | TCP/UDP target and host ports validate; collisions produce actionable errors. | partial — TCP/UDP configuration and duplicate-port validation [E1]; real externally published service-port workflow unverified |
| R06 | Domains and target port (D,S) | P0 | A hostname reaches the selected service and internal port through the proxy. | verified — real HTTP Host routing to configured service/port, unknown-host 404 [E3] |
| R07 | Automatic HTTPS (D,S) | P1 | Certificate provisioning is real; failures and prerequisites are visible. | partial — Traefik TLS labels and deployment configuration exist; ACME issuance/renewal not exercised |
| R08 | Primary and generated domains (D,S) | P1 | Primary domain drives the Open action and generated URLs. | partial — baseDomain generates hostnames for new apps/templates with target-port defaults; explicit primary-domain selection absent |
| R09 | Paths, wildcards, upstream TLS (D) | P2 | Routing fixtures exercise path and hostname boundaries correctly. | partial — PathPrefix labels implemented; path traffic, wildcards and upstream TLS not verified/supported |
| R10 | Redirects and middleware (D,S) | P1 | Rules can be enabled/disabled and tested without redirect loops. | pending |
| R11 | HTTP Basic Auth (D,S) | P1 | Proxy denies anonymous requests and accepts configured credentials. | pending |
| R12 | Maintenance response (D,S) | P1 | Public requests receive maintenance output while the workload remains running. | pending |
| R13 | Replicas and rolling updates (D,S) | P2 | Scale and deploy preserve declared availability under load. | pending |
| R14 | Command, init, capabilities and sysctls (D,S) | P2 | Advanced values reach runtime without shell interpolation. | partial — inline Compose allows command/entrypoint/init; general capabilities/sysctls/runtime controls absent |
| R15 | Runtime logs (D,S) | P0 | Logs belong to the selected service; search, limit and refresh work. | verified — scoped Docker logs [E2], browser polling/filtering [E5]; pause/tail controls implemented, no server-push stream |
| R16 | Interactive terminal and scripts (D,S) | P1 | Authorized exec is scoped to service; disconnect closes the session. | pending |
| R17 | Metrics (S) | P0 | Real CPU/memory/network samples identify missing data and sample time. | partial — live aggregate Docker CPU/count and process-host memory/disk; mixed sources, no sample timestamps or per-service network metrics |
| R18 | Long-term metrics/log retention (S) | P2 | Retention is bounded and historical queries work after restart. | pending |

## Databases and backups

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| D01 | [PostgreSQL](https://easypanel.io/docs/services/postgres) (D,S) | P0 | Generated credentials connect privately; a record survives restart/redeploy. | verified — PostgreSQL initialization, private cross-container password authentication (wrong-password rejection), persistent row, dump and independent recovery [E2] |
| D02 | [MySQL](https://easypanel.io/docs/services/mysql) (D,S) | P1 | App user and administrative credentials work with durable storage. | partial — generated MySQL defaults, mounts, UI and dump command implemented; real MySQL engine not exercised |
| D03 | [MariaDB](https://easypanel.io/docs/services/mariadb) (D,S) | P1 | Correct image variables initialize a durable, authenticated database. | partial — generated MariaDB defaults, mounts, UI and dump command implemented; real MariaDB engine not exercised |
| D04 | [MongoDB](https://easypanel.io/docs/services/mongo) (D,S) | P1 | Authenticated private connection and persistent document storage work. | partial — generated MongoDB defaults, mounts, UI and dump command implemented; real MongoDB engine not exercised |
| D05 | [Redis](https://easypanel.io/docs/services/redis) (D,S) | P0 | Authentication and persistence are enabled; reconnect succeeds after restart. | verified for runtime — authentication, a key survives restart, RDB-only archive [E2]; archive recovery remains unverified |
| D06 | Credential reveal and connection URL (D,S) | P0 | Reveal is deliberate; URI escaping handles generated special characters. | implemented — masked/reveal/copy URI with encodeURIComponent; browser special-character URI verification pending |
| D07 | Password rotation (D,S) | P1 | Existing database account changes, not only container environment. | pending |
| D08 | External database exposure (D,S) | P1 | Explicit host-port opt-in works and can be removed. | partial — explicit generic published-port controls; real external database connection and revocation unverified |
| D09 | Database browser tools (D,S) | P2 | Tool access is authenticated and disabled tools are unreachable. | pending |
| D10 | [Manual logical dump](https://easypanel.io/docs/backups/database) (D,S) | P0 | Nonempty dump exists only after tool success; records can be restored. | verified for PostgreSQL — native dump restored into a second instance with row assertion [E2]; other engines unverified |
| D11 | Scheduled backups (D,S) | P1 | Persisted schedule runs after restart with timezone and next run shown. | verified for supported UTC workflows — schedule timing, durable settings, restart catch-up and busy retry [E1]; create/run/pause/remove UI [E5]; long-running Docker schedule soak pending |
| D12 | Retention and backup activity (D,S) | P1 | Cleanup touches only this job's files and preserves latest successful copy. | verified at module/API level — exact job/service ownership, keep-newest, missing-copy protection and filesystem safety [E1]; no offsite retention |
| D13 | Database restore (D,S) | P1 | Target confirmation precedes overwrite; restored records are verified. | pending |
| D14 | [Volume backup](https://easypanel.io/docs/backups/volumes) (D,S) | P1 | Format is explicit; files and ownership can be recovered in a disposable test. | partial — timestamped app-volume tar.gz; Redis now archives SAVE-produced RDB separately; app recovery/ownership and Redis recovery not tested |
| D15 | [Local backup destination](https://easypanel.io/docs/storage-providers) (D,S) | P0 | Path is validated and a write/read check succeeds. | partial — fixed local data-directory backups and authenticated downloads [E1,E2]; no configurable provider administration |
| D16 | S3-compatible destination (D,S) | P1 | Upload/download and scoped retention work against a test bucket. | pending |
| D17 | FTP/SFTP destination (D,S) | P2 | Authentication failure is useful; credentials stay secret. | pending |
| D18 | Dropbox / Drive destination (D,S) | P2 | OAuth refresh/revoke and backup access behave correctly. | pending |

## Compose, catalog and specialized workloads

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| C01 | [Inline Compose](https://easypanel.io/docs/services/compose) (D,S) | P1 | Validate and deploy an isolated multi-service definition. | verified for supported subset — real two-image inline Compose stack [E2]; build, host binds, custom labels and external networks rejected |
| C02 | Git Compose (D,S) | P1 | Resolve selected Compose file and relative assets from a chosen branch. | pending |
| C03 | Compose diagnostics (D,S) | P1 | Show actionable config errors and conflicting host-resource warnings. | partial — explicit unsupported-option and YAML errors [E1]; full Compose compatibility/port-conflict planning absent |
| C04 | Compose lifecycle and logs (D,S) | P1 | Start/stop/restart and selected-container logs work across the stack. | partial — real stack deployment/start/stop [E2], aggregate logs implementation; per-container filtering absent |
| C05 | Compose domain target (D,S) | P1 | Route to a selected internal service without exposing its database. | pending |
| C06 | Template catalog (S) | P0 | Search, inspect and instantiate a small original tested catalog. | partial — original 10-template catalog/search/install UI; Redis install [E1] and Nginx/PostgreSQL/Redis runtime fixtures [E2]; remaining templates unverified |
| C07 | Template dependency wiring (I) | P1 | Generated secrets and cross-service URLs agree; failure is recoverable. | pending |
| C08 | [WordPress runtime](https://easypanel.io/docs/services/wordpress) (D,S) | P1 | WordPress with a private database completes browser setup and persists files. | pending |
| C09 | WordPress administration (D,S) | P2 | Users, plugins, themes, updates and maintenance operate through checked jobs. | pending |
| C10 | WordPress migration and diagnostics (D,S) | P2 | Export/import, search preview, cache, media and profiling expose real results. | pending |
| C11 | [Box runtime modules](https://easypanel.io/docs/services/box) (D,S) | P2 | Runtime selection generates a working container with managed processes. | pending |
| C12 | Box presets and browser IDE (D,S) | P2 | Presets preserve stated data; IDE authentication and token rotation work. | pending |
| C13 | Scheduled scripts and hooks (D,S) | P2 | Jobs are scoped, auditable, cancellable and protected against overlap. | pending |

## Server, access and integrations

| ID | Feature / evidence | Priority | Acceptance criterion | Status |
| --- | --- | --- | --- | --- |
| S01 | Server settings and health (S) | P0 | Runtime mode, version, Docker availability and system capacity are truthful. | partial — real Docker version/health and settings; aggregate CPU and process-host memory/disk are different measurement scopes |
| S02 | Multiple users and project access (S) | P1 | Server-side authorization blocks cross-project and admin-only operations. | pending |
| S03 | API credentials (S) | P1 | Keys are scoped, hashed, revocable and distinct from sessions. | pending |
| S04 | [CLI](https://easypanel.io/docs/cli) (D,S) | P2 | Scripts can inspect and deploy with machine-readable output and safe auth. | pending |
| S05 | [MCP](https://easypanel.io/docs/mcp) (D,S) | P2 | Discovery and operations preserve identity, access control and risk annotations. | pending |
| S06 | Notification channels (S) | P2 | Test delivery and deployment failure events reach a configured destination. | pending |
| S07 | Docker maintenance (S) | P2 | Cleanup previews scope and preserves active workloads and retained volumes. | pending |
| S08 | Build workers / remote builders (S,D) | P2 | Selected builder is used, with capacity and unavailable-worker errors. | pending |
| S09 | Cluster nodes and tunnels (S) | P2 | Node/tunnel lifecycle is authenticated and cannot target unrelated hosts. | pending |
| S10 | Panel domain / proxy configuration (S) | P1 | Proxy settings validate before activation; panel remains recoverable locally. | pending |
| S11 | Upgrade and recovery (I,S) | P1 | Versioned migrations and a documented configuration restore path work. | partial — encrypted state/key recovery, writer locking and interrupted-job handling [E1]; versioned upgrade migrations not implemented |
| S12 | Interface preferences (S,I) | P1 | Theme, responsive layout and keyboard access remain consistent across screens. | verified for main flows — persisted dark theme, keyboard palette, mobile navigation and 390px dashboard overflow check [E5]; full accessibility audit pending |

## Verification record — 2026-11-08

The test source files below are the reproducible specification of each check. Runs were performed during this implementation session; there is no claim of independent certification. The reference image identity is separate from the runtime images used by Harborlight's tests.

| Evidence | Command / source | Observed result and exact scope |
| --- | --- | --- |
| E1 | `npm test` — [API/state tests](../server/tests/app.test.ts), [trigger tests](../server/webhooks.test.ts), [schedule tests](../server/backup-schedules.test.ts) | 35 passing tests at the final verification point, covering API/state integration, triggers, scheduling and retention. API integration uses an injected test runtime. Scheduler uses a controlled clock and real disposable files. |
| E2 | `npm run test:docker` — [Docker smoke](../scripts/smoke-docker.ts) | Passed against Docker Engine 29.4.0, linux/arm64 via OrbStack: Nginx HTTP/lifecycle/logs; failed pull preserves runtime; inline Dockerfile; PostgreSQL durable row and native dump restored into a second instance; Redis authentication/restart persistence/RDB-only archive; PostgreSQL cross-container password authentication; two-service Compose deployment/start/stop and retained named volume; Docker version available. |
| E3 | `npm run test:proxy` — [proxy smoke](../scripts/smoke-proxy.ts) | Passed with disposable Traefik v3.6 and Nginx: HTTP hostname routing, unknown-host 404, and inspected CPU/memory limits. This is not an HTTPS/ACME test. |
| E4 | `npm run typecheck`, `npm run build`, Docker build of `harborlight:local` | TypeScript/application build and arm64 container image build passed. Runtime acceptance comes from E2/E3, not compilation alone. |
| E5 | `npm run test:e2e` — [browser workflows](../tests/workflows.spec.ts) | 8/8 passed against the production build in explicit demo mode: owner setup/session reload; project/app creation, source/environment persistence, simulated deployment, log filtering, stop/start; PostgreSQL demo/manual backup/download link/typed deletion; 390×844 dashboard without horizontal overflow. Also project editing/keyboard search, token rotation/revocation, schedule run/pause/removal, template install and dark-theme persistence. Desktop/mobile screenshots were visually inspected. |

The source tags in E2 were `nginx:1.28-alpine`, `postgres:17-alpine`, and `redis:7-alpine`; E3 used `traefik:v3.6`. These tags are mutable. Resolved runtime-image digests are recorded in [VERIFICATION.md](VERIFICATION.md); future tag-based executions can resolve different artifacts. The inspected Easypanel reference digest is pinned in [REFERENCE-ANALYSIS.md](REFERENCE-ANALYSIS.md).

Additional package evidence: `npm run test:package` passed against the built production container, including real API-triggered deployment and encrypted-state/session recovery after SIGKILL. See [VERIFICATION.md](VERIFICATION.md).

## Current boundaries

Harborlight currently operates Docker standalone containers and a restricted inline Compose subset, not a Swarm cluster. Container replacement can interrupt traffic and does not establish application readiness. No zero-downtime or complete failure-rollback guarantee is made.

Still pending are private Git/registry authentication, archive uploads, native GitHub HMAC webhooks, automatic builders, release rollback, terminal sessions, advanced proxy middleware, multi-user authorization, API keys/CLI/MCP, remote backup providers, restore API/UI, managed WordPress/Box, clustered workers and host-upgrade operations. Some configuration fields and labels are present before their full reference workflow exists; their ledger rows remain partial or pending.

The successful PostgreSQL restore in E2 is a test-operated native restore, not a restore feature in the product. The Redis archive check proves output creation, not recovery correctness. The scheduler is tested with a controlled clock; it does not claim a production-duration soak test. HTTP proxy success does not verify certificate issuance. Demo browser success does not by itself verify Docker behavior.
