# Immutable application releases and rollback

A successful single-container application deployment records a private snapshot and an image identity. The snapshot contains the effective runtime environment, routing, resource limits and other applied service configuration, together with proxy password hashes. It never contains source-access credentials. Public release history contains only metadata: IDs, timestamps, source type, image reference and immutable ID, source commit, trigger and rollback lineage.

## Image retention

The runtime resolves the image to its Docker content ID before creating the container and deploys that ID. Each release retains a namespaced local tag, `harborlight-release/<service UUID>:<release UUID>`, pointing at the same image. Mutable source tags cannot change the stored release identity. Creating a retention tag does not relabel, modify or delete a shared image.

Rollback verifies that the expected retained tag still resolves to the recorded image ID. Missing or altered retention fails before the current container is touched. No registry pull, Git checkout or image build is performed during rollback. Local image retention is required; moving an encrypted state file to a different Docker host does not also transfer its images.

## Rollback flow

An operator opens Releases, selects a retained version and confirms the current service's exact name. The request creates an inspectable deployment job with its own ID and `rollbackOf` lineage. It reuses the same operation lock as deployment, backup and restoration. A second attempt cannot overlap.

The release's image and runtime configuration are reapplied. The desired configuration stays saved as it was before rollback, and the interface reports the resulting difference explicitly. A later ordinary deployment applies those saved settings again. Active-release metadata identifies what actually runs; deployment timestamps alone do not imply that desired settings are applied.

Named-volume contents are not restored or rewound. Rollback requires matching logical mount names and paths and carries forward the active volume mapping, including any mapping created by a data restoration. This prevents application rollback from accidentally reattaching pre-restoration data. Database schema migrations made by application code are outside the rollback boundary.

Unmanaged current volumes and volume destinations declared by the historical image without an explicit managed mount are refused. The runtime cannot safely infer which old anonymous volume should be reattached.

Domain and published-port ownership checks include other services' desired and applied configuration. An old route cannot reclaim a hostname that another project now uses. A durable private candidate journal reserves rollback names/routes/ports during replacement and after interruption, and keeps historical environment values in log redaction until reconciliation. The candidate is prepared before replacement; a failed start attempts to restore the previous container through the existing deployment path. Standalone replacement can interrupt traffic and does not constitute application-level readiness verification or a zero-downtime guarantee.

An interrupted deployment makes the applied configuration uncertain after restart. The panel clears the active-release claim and blocks rollback, data operations and configuration edits until an explicit successful deployment reconciles the runtime. A service being replaced is not labeled as having a verified active release. This is fail-closed interruption handling, not automatic transaction recovery for every deployment phase.

## Supported scope and API

This milestone supports Docker applications. Demo, database and Compose services explain their unsupported state. Database rollback is deliberately not inferred from an old image: data restoration has separate compatibility checks and safety backups. Legacy deployments without a recorded image and complete snapshot are not retroactively advertised as rollback candidates.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/services/:id/releases` | Supported state, active release ID and safe release metadata |
| POST | `/api/services/:id/rollback` | `202` deployment job; body `{ "releaseId": "<UUID>", "confirmationName": "<service name>" }` |

Project readers can see safe history; only operators can request rollback. Unrelated project releases are unavailable. Release snapshots remain in encrypted storage and are never returned to the browser. Deleting a service removes its release retention references and private snapshots while preserving ordinary named-volume data and public deployment history.

Retention cleanup removes only exact UUID-namespaced tag references, without forced image deletion. If Docker refuses a reference still used by another container, deletion reports that cleanup must be retried; the selected service's container may already have been removed. Shared image tags and labels are left intact. There is currently no automatic release retention limit or image migration between Docker hosts.

## Verification targets

Two distinct image/configuration versions must produce different observable responses and environment values. After moving an original image tag, rollback must still run the recorded ID. Recent writes in a named volume must remain. Missing-image and incompatible-mount cases must fail without replacing the active workload. API and browser checks must confirm exact-name admission, permission boundaries, preserved desired edits, progress, history and reload persistence.

`scripts/smoke-releases.ts` verifies the runtime; `scripts/smoke-releases-ui.ts` verifies the actual browser/API/Docker path. Exact passing scope and limitations are recorded in [VERIFICATION.md](../VERIFICATION.md).
