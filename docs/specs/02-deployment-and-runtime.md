# Deployment and runtime specification

Harborlight's runtime implementation is independent of the inspected application's bundled code. This document defines desired behavior, not a claim that it already exists.

## Configuration and releases

A service has a type, source configuration, environment, mounts, domains, resource limits and runtime options. Saving edits changes desired configuration. An explicit deployment snapshots that configuration into a release. The interface can then distinguish desired configuration from the last successful deployment.

Deployment jobs have stable IDs, timestamps, initiating actor, source revision or image digest, state and bounded output. State progresses through queued, preparing, building/pulling, applying, verifying, then succeeded or failed. A cancelled or interrupted job must not remain permanently running after process restart. At most one deployment per service applies at a time.

Errors identify the failing phase and preserve useful output. Source failures do not silently replace a running healthy container. Retain enough previous release information to support an explicit rollback. A failed rollback is also a job with inspectable output.

## Source handling

An image source validates its reference and pulls before replacement. Record the resolved digest when possible. Private registry credentials must be supplied through a secret channel and never echoed.

A Git source specifies repository, branch/ref, build context and Dockerfile path. Build directory resolution must remain inside the checked-out repository, including symlink boundaries. Use an argument-array subprocess API, not interpolated shell commands. Reject unsupported repository schemes. Capture the checked-out commit so the operator can identify the deployed source.

Inline Dockerfiles build in a dedicated service workspace. Uploaded archives require decompressed size limits and path/symlink validation. Runtime environment values must not automatically become image build arguments; secret build inputs need an explicit mechanism.

Builder plugins must declare their installed version and availability. Unsupported builder choices fail validation. Buildpacks, Nixpacks and Railpack are separate features that require their own working fixtures; showing their names in a select box does not satisfy parity.

## Container ownership and lifecycle

Docker resources are namespaced and labeled as Harborlight-owned, with project and service identifiers. Destructive operations select by persisted identity and ownership, never by arbitrary user-supplied Docker IDs. Project networks allow intended internal communication while databases remain unpublished by default.

Deploy creates or replaces the selected workload; start and stop preserve configuration; restart reports actual outcome. Named volumes survive ordinary redeployment. Service deletion preserves volumes by default unless the operator explicitly requests data destruction and the backend supports it safely. Never prune unrelated Docker resources.

CPU, memory and ports are validated before use. Docker error output is surfaced without leaking environment values. Logs are bounded, scoped and distinguish stdout/stderr when available. Metrics include their collection time and units; missing samples are missing, not zero.

## Routing

Domain configuration contains hostname, path, internal port and TLS intent. Validate hostnames and prevent arbitrary Traefik-expression injection. A default proxy network must be reachable by the selected workload. HTTPS success means a working certificate, not merely a saved checkbox.

Display DNS and certificate prerequisites. Domain deletion removes its route. Public HTTP routing must not accidentally expose a private database. More advanced routes, wildcard domains, redirects, Basic Auth and maintenance responses need separate traffic-level checks.

## Compose

Compose definitions belong to a namespaced project. Parse and validate before applying; show conflicts in published host ports and fixed resource names. Decide and document which high-privilege Compose settings are supported. Public routes target a specific internal Compose service. Lifecycle and log views account for multiple containers, not only the first one returned by Docker.

## Acceptance scenarios

1. Deploy an HTTP image, request its endpoint, change a setting, verify it remains unapplied until deployment, then verify the new runtime configuration.
2. Deploy an image that does not exist; assert failed job output and an accurate running-service state.
3. Build a tiny Git repository with a nested Dockerfile and verify recorded revision and context boundaries.
4. Race two deploy requests and verify deterministic serialization with no orphaned container names.
5. Create persistent data, redeploy, then verify the data remains.
6. Verify CPU/memory limits and labels using Docker inspect; compare displayed runtime state after stop and restart.
7. Deploy a two-container Compose fixture and verify scoped logs and private inter-service connectivity.
8. Route an HTTP hostname through the proxy. Test TLS separately on an owned domain; local compilation alone does not verify ACME.
