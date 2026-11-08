# Easypanel reference analysis

Research date: **2026-11-08**. Target implementation: **Harborlight**, an independently implemented, open-source server control panel with a different visual identity.

## Scope and method

This document records observations of the publicly downloadable installer, the requested public Docker image, and the official product documentation. The original application was **not run**. There was no interaction with an Easypanel account or production server. Docker Swarm was not initialized, joined, left, or reconfigured.

The image was pulled, a stopped container with no mounts was created, `/app` was copied to a temporary directory, and that temporary container was removed. Inspection was limited to metadata, package information, file inventory, endpoint and operation-name discovery. Bundled application code is minified. Its presence does not establish source-code licensing or a permission to redistribute it. No original executable code, UI assets, templates, branding, or bundled dependencies were copied into Harborlight.

Extracted third-party material lives outside this repository at `/private/tmp/harborlight-easypanel-reference/app`. Harborlight's specs describe requirements and new implementation choices; they are not a decompiled source distribution. No byte-for-byte, API-wire-compatible, or complete feature parity is claimed.

## Reproducible artifact identity

| Artifact | Observed value |
| --- | --- |
| Installer URL | <https://get.easypanel.io> |
| Installer SHA-256 | `b49929fee4a03fc3b3d4bab8d6f3f67c814e1dbd6d8718f1232ccdefd5576abd` |
| Requested image | `easypanel/easypanel:latest` |
| Resolved repository digest | `sha256:9af9b2f275120b5d6a05bc52a880d7a36f0c7c0f7077f54bc42be3dd5ce7db40` |
| Local image ID | `sha256:b8c141ce0ef09023a86d326b05f80c2bb40b95f960ef5ba01b06a12bb068654d` |
| Platform inspected | `linux/arm64` |
| Image creation timestamp | `2026-10-22T09:01:25.510813507Z` |
| Application package version | `2.38.0` |
| Runtime declared by image | Node.js `22.23.4`, `NODE_ENV=production` |
| Working directory | `/app` |
| Entrypoint / command | `node backend.js` / `start` |
| Exposed port | `3000/tcp` |
| Backend SHA-256 | `a8941eb9a08e8060d1fbb5bdbbbeba2b6450f44e846386a30c5b0109205e66bb` |
| Backend bundle size | 3,077,034 bytes |
| Frontend main bundle | `index-DttTNRUu.js`, 3,065,941 text characters |

`latest` is mutable. These observations apply to the resolved digest and architecture above, not every version or platform. Metadata was read with `docker image inspect`; files were read after `docker cp` from an unstarted container.

## Installer findings

The downloaded script requires root, rejects macOS and execution inside a container, and checks ports 80 and 443. It installs Docker from Docker's Ubuntu package repository when necessary. It then forces the host to leave its current Swarm, pulls the image, and invokes the image's setup command with the Docker socket and `/etc/easypanel` mounted.

The forced Swarm leave is a material host mutation. **This script was not executed.** Harborlight should have its own installer and explicit prerequisites; copying this behavior into a development-machine bootstrap would be inappropriate. The [official getting-started guide](https://easypanel.io/docs) describes installation on a fresh server.

## Static application inventory

Observed files include a minified Node backend, a static frontend entry page and asset bundles, Box and WordPress runtime templates, and framework preset directories. The root application package lists native dependencies for LMDB, SQLite, and pseudo-terminal support. All 28 discovered source maps belonged to dependencies; no application source map was found in the inspected filesystem.

Static strings include Traefik, Docker, rclone, Railpack, Nixpacks, terminal, and metrics-related names. Their presence supports an architectural hypothesis but does not prove which path runs for a specific configuration.

The backend exposes endpoint strings for RPC and tRPC, an OpenAPI document, CLI schemas, MCP, code uploads, tokenized deployment triggers, backup/snapshot operations, WordPress transfers, and storage-provider OAuth callbacks. A conservative literal-name scan found **377 distinct operation-like identifiers**. This is an inventory heuristic, **not** a verified count of callable APIs. Examples cover project/service creation, environment editing, build configuration, domain management, action history, resource statistics, database credentials, backups, users, Docker builders, and notification channels.

No API schemas were extracted by executing the application. Harborlight defines its own REST API and data model; the original endpoint names are not an implementation contract.

## Product behavior supported by official documentation

The recurring user journey is project → service → configuration → deployment → operational feedback. Application configuration can be saved independently from deployment; deployment output and runtime output answer different questions. This distinction should remain visible in Harborlight. [App service reference](https://easypanel.io/docs/services/app)

Compose is a separate workload category with a multi-container definition and lifecycle. Git and inline definitions are supported by the reference, with compatibility checks around shared host resources. [Compose reference](https://easypanel.io/docs/services/compose)

Database services supply durable storage and connection details, begin on private networking, and can explicitly publish a host port. PostgreSQL, MySQL, MariaDB, and MongoDB have logical backup workflows. Redis has persistent storage but no native scheduled database-backup tab in the inspected documentation. [PostgreSQL](https://easypanel.io/docs/services/postgres), [MySQL](https://easypanel.io/docs/services/mysql), [MariaDB](https://easypanel.io/docs/services/mariadb), [MongoDB](https://easypanel.io/docs/services/mongo), [Redis](https://easypanel.io/docs/services/redis)

Database backups are per-run files with restore and retention operations. Volume backups are mirrors with different recovery semantics. The reference's volume sync may remove destination files, and its interface does not provide a volume restore action. Harborlight must clearly name its own backup format and must not present a file copy as a consistent database dump. [Database backups](https://easypanel.io/docs/backups/database), [volume backups](https://easypanel.io/docs/backups/volumes)

Storage destinations include local files, S3-compatible systems, FTP/SFTP, Dropbox, and Google Drive. Connection checks are weaker than an end-to-end backup/restore test. [Storage-provider reference](https://easypanel.io/docs/storage-providers)

Advanced product areas extend beyond a basic Docker dashboard: build detection, modular runtimes, managed WordPress operations, user access, API/CLI/MCP clients, and server operations. They remain explicit backlog items until implemented and verified. [Builders](https://easypanel.io/docs/builders), [Box](https://easypanel.io/docs/services/box), [WordPress](https://easypanel.io/docs/services/wordpress), [CLI](https://easypanel.io/docs/cli), [MCP](https://easypanel.io/docs/mcp)

## Evidence limits

- No live Easypanel UX walkthrough was performed. Public workflows and static feature names were examined; pixel placement, navigation timing, validation behavior, and accessibility remain unverified.
- The docs are live and may describe behavior newer than image version 2.38.0. Features corroborated only by docs are marked as such in the matrix.
- A procedure name demonstrates a feature surface, not correctness, permissions, implementation detail, or availability under every license.
- No licensing, entitlement, activation, or signature checks were bypassed. Harborlight does not reuse the original licensing system.
- Pulling an image verifies availability and artifact identity, not the safety or fitness of its contents.

## Implementation handoff

Use [the parity matrix](FEATURE-PARITY.md) to track scope and the specifications under [specs](specs/01-core-and-ux.md) for original acceptance criteria. Every implemented row needs code and a test or a documented manual verification. A visible control without a working backend is not parity. Docker integration must be verified against disposable Harborlight-owned resources; demo mode must remain visibly identified.
