# Advanced parity and release-quality specification

The foundational workflows do not constitute complete parity. This document names the larger remaining areas so future work can proceed in verifiable iterations.

## Access and automation

Multiple users require project-scoped authorization at every API route, action stream, log endpoint and terminal. Administrator-only actions must be enforced server-side. Test reads and writes across two isolated projects, not only hidden navigation items.

API keys should be independently revocable, stored as hashes, and scoped to a user or service identity. Webhooks require authorization, replay considerations and bounded job submission. CLI and MCP clients should reuse the same authorization boundary. Machine-readable schemas, pagination and clear error codes are preferable to replicating the reference's private RPC contract.

Notification integrations need an explicit destination and events. Delivery tests, retries and redaction must be observable. A saved webhook URL alone is not a functioning notification system.

## Specialized workloads

A WordPress template is useful but does not provide the complete managed WordPress feature set. Advanced parity includes core/plugin/theme operations, account and role management, configuration editing, database/files transfer, search preview and migration, cache/media tasks, diagnostics and runtime controls. Each should run as an inspectable job with target validation.

A modular runtime requires versioned runtime selection, image generation, process supervision, startup/deployment hooks, durable code and optional authenticated IDE. It is a separate product capability from executing an arbitrary Docker image. Preserve user code when regenerating runtime configuration.

Template recipes should be original, versioned and validated. A recipe declares images, required variables, generated secrets, persistent volumes, dependencies and routes. Installation either completes coherently or exposes which resources were created and how to retry or remove them. Do not claim catalog-size parity without maintaining that catalog.

## Host and cluster operations

Worker nodes, remote builders, tunnels, upgrades, automated cleanup and proxy replacement have host-wide consequences. Their scope, prerequisites and recovery path must be explicit. Never run a broad Docker prune, change Swarm membership, reboot or replace the proxy as an incidental part of inspecting a service.

Use previewable ownership-based plans for cleanup. Keep active workloads and retained volumes out of the deletion set. Upgrades need state compatibility, migration tests and a fallback path. Cluster features require integration tests on an actual disposable multi-node environment before claiming support.

## Evidence standard

A release needs passing type/build checks, meaningful API tests, browser validation of critical journeys and Docker integration checks where Docker behavior is claimed. Tests should exercise boundaries: permissions, durable writes, invalid configuration, service ownership, secrets, source-path containment, job races, backup correctness and failed deployments.

Track the environment and exact outcomes in release notes. Distinguish automated tests, manual checks and unverified external dependencies. Browser screenshots prove visual state; they do not prove deployment or restore behavior. Simulated adapters prove orchestration/UI behavior; they do not prove the Docker adapter.

Public documentation should state current supported features, known gaps, local-development commands, self-hosted setup, data locations, backup/recovery, API authentication, contribution guidance and license. Keep the feature ledger synchronized with code. When a feature is partial, say which part works.

## Iteration protocol

1. Select one or a small group of dependency-related ledger rows.
2. Define the desired user result and its failure states.
3. Implement original backend and UI behavior.
4. Exercise the actual runtime and critical error cases.
5. Record evidence and update status only for the verified scope.
6. Continue to the next dependency-ready rows; do not label the whole product complete while required rows remain pending.
