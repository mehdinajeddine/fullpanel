# Service resource monitoring

FullPanel requirement **R17**, informed by the public-history requirements **H01** (measurement meaning and freshness) and **H02** (current runtime identity). Implementation and executed evidence are recorded separately in [the feature ledger](../FEATURE-PARITY.md) and [verification record](../VERIFICATION.md).

## User outcome

The service Overview shows CPU consumption, memory usage and its limit, and received/sent network totals. A collection timestamp and an explicit status distinguish a current measurement, incomplete data, a stopped service and an unreachable runtime. The user can refresh without deploying or changing service configuration.

Every value belongs to the selected service's current containers. A deleted or replaced container must not remain a source of apparently current measurements. A stopped workload has no live measurement; it is not represented as consuming exactly zero resources.

## Measurement contract

`GET /api/services/:id/metrics` returns `ServiceMetrics` from `shared/metrics.ts`. Project viewers and operators, administrators and appropriately scoped read API keys may read it. Authorization is checked before collection and again after the asynchronous operation. Cross-project and revoked access cannot use cached results to bypass those checks.

| Field | Meaning |
| --- | --- |
| `mode` | `docker` for runtime samples; `demo` never establishes an actual measurement. |
| `state` | `available`, `partial`, `stopped`, `not-deployed` or `unavailable`. |
| `sampledAt` | Time of the measurement, or `null` when none exists. Cache reads preserve it. |
| `checkedAt` | Collection/check completion time; it does not turn absent data into a sample. |
| `containers` | Verified current container identities, runtime states, start times where known, individual measurements and timestamps. |
| `totals` | Service sums. Each field is `null` if any selected member lacks that measurement. |
| `message` | A safe explanation; raw Docker errors, environment variables and configuration secrets are excluded. |

CPU follows Docker's container convention: 100% represents one logical core, so a value above 100% is valid. It is not a percentage of the saved CPU quota. Memory is the Linux Docker CLI working-set measurement, which subtracts cache; the limit is the runtime-reported limit, not an unapplied configuration edit. Decimal and binary units are parsed separately. Docker's formatted values have limited precision, so these are operational measurements rather than exact accounting values. [Docker stats reference](https://docs.docker.com/reference/cli/docker/container/stats/).

Received and sent values are cumulative byte counters reported for each container. They are **not bytes per second**. Replacing a container changes the identity and resets the visible counters to those of the replacement. A Compose sum can combine members with different start times; it is not a shared-duration traffic rate. No historical chart, billing accuracy, alert threshold or persistent time-series retention is implied.

## Runtime selection and collection

The Docker collector requires exact FullPanel management, service and project labels. A normal app/database must have its canonical `hl-<service UUID>` container name. Compose members additionally require the matching Compose project, service, container number and canonical name, with the one-off flag false. Previous deployment containers, restore candidates, one-off jobs and unrelated containers are excluded.

The collector reads a reduced inspection containing identities, labels and runtime state. It calls `docker stats --no-stream --no-trunc` with the verified full IDs only, then inspects those IDs again. A stop, restart, rename or replacement observed during collection invalidates the affected sample. Missing or malformed statistics remain `null`; errors never produce synthetic zeros. A vanished runtime that was previously deployed is unavailable, rather than a new undeployed service.

New Compose deployments include the project ownership label. Legacy Compose containers lacking that proof require redeployment before this collector can verify ownership; they must not be silently treated as verified measurements. Unsupported or inconsistent member ownership must not produce an apparently complete total.

Collection is on demand, with a process-local cache of at most 128 services for five seconds and at most eight simultaneous collections. Requests for the same sample share the work. Docker enumeration/inspection and sampling have timeouts; Compose candidates are bounded to 64. Saturation returns an explicit unavailable result instead of building an unbounded queue. The cache is not persisted and does not implement historical retention.

## Interface behavior

The Overview presents icon-and-label cards, a precise collection time and a refresh control. CPU is not clamped to a misleading 100% maximum. Memory distinguishes usage from limit; network cards identify cumulative received/sent bytes. States remain understandable without color, on narrow screens and in the dark theme.

Refreshes occur only while the view is mounted and the document is visible. When a request fails, any retained last measurement is labelled stale with its original time. A successful HTTP response containing `unavailable` or `partial` is not shown as healthy live data. Demo mode explicitly explains that actual service measurements are not collected.

The workspace dashboard keeps its separate scopes visible: aggregate Docker CPU is normalized to daemon CPU capacity; memory and disk belong to the panel process host/data filesystem. A remote Docker daemon or containerized panel can therefore refer to different hosts. Service measurements do not cure this global-scope distinction.

## Acceptance and evidence boundaries

1. Deploy a real application with a known memory limit; verify positive memory, nonnegative CPU and network samples, exact current container identity and bounded collection age.
2. Generate bounded CPU load and a known private-network download; observe positive CPU and growth in the corresponding byte counters.
3. Repeat a cached request and preserve its original sample time. Stop/start/redeploy the service and show absent/recovered/new-container measurements accordingly.
4. Collect a real two-container Compose stack, exclude a one-off job and unrelated containers, and report incomplete totals after stopping one member.
5. Reject cross-project access and revoked authority, including revocation while collection is in flight. Cache sharing must not widen permissions.
6. Exercise malformed/missing units, CPU above 100%, Docker failure, partial rows, ownership mismatches, bounded cache/concurrency and replacement during collection.
7. Verify the browser's timestamps, unavailable/stale states, refresh and mobile layout. Browser fixtures with controlled values are labelled demonstration evidence, not runtime proof.

The real Docker fixture is `npm run test:service-metrics`. The frozen specifications DOCX predates this implementation; this document adds a current requirement/evidence contract without changing that artifact.
