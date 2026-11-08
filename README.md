# Harborlight

**Your infrastructure. In good hands.**

An independent, open-source control panel for applications and databases on your own Docker host. An original interface and implementation, informed by the workflows documented in Easypanel. Apache-2.0 licensed.

**Status: early development.** The [feature matrix](docs/FEATURE-PARITY.md) records observed reference behavior, acceptance criteria, and implementation status. Harborlight does not claim complete Easypanel parity. See [verification](docs/VERIFICATION.md) for what has actually been exercised.

![Harborlight dashboard with explicitly labeled demonstration data](docs/images/dashboard.png)

The current release includes projects and services, public image/Git/Dockerfile deployments, a restricted Compose runtime, database configuration, domains, environment variables, named volumes, resource limits, deployment output, runtime logs, local backups, UTC backup schedules with retention, and revocable deployment triggers. The interface supports light and dark themes, mobile layouts, and keyboard search.

Multi-user access, private Git/registries, native GitHub webhooks, offsite storage, restore workflows, interactive terminals, rolling deployments, and the reference product's advanced workloads remain tracked work. This release manages standalone Docker containers; it does not provide Swarm parity.

## Run locally

Requirements: Node.js 22.13+ (24 LTS recommended), npm, and Docker Engine with Compose and Buildx for real deployments.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 and create the initial owner account. The backend binds to loopback by default. Docker mode is the default; Docker failures are reported rather than replaced with simulated results.

To explore without creating containers:

```sh
HARBORLIGHT_MODE=demo DATA_DIR=.data/demo npm run dev
```

Demo mode displays a persistent banner, uses illustrative data, and simulates deployment operations. Keep demo and real state in separate data directories.

## Install on a server

Clone your Harborlight repository to a server with Docker Engine and the Compose plugin installed, then run:

```sh
sh scripts/install.sh
```

This builds from source and starts the panel. It does not install Docker, join or leave a Swarm, or expose the administration port publicly. The installer is equivalent to:

```sh
cp .env.example .env
docker compose up -d --build panel
```

On a remote server, forward the loopback port to complete setup:

```sh
ssh -L 3000:127.0.0.1:3000 user@your-server
```

Open http://127.0.0.1:3000 through that tunnel. Create the owner before exposing the administration interface.

### Application domains and HTTPS

Point the domain's DNS A/AAAA records at this server. Set `ACME_EMAIL` in `.env`, ensure ports 80 and 443 are available, and start the optional Traefik proxy:

```sh
docker compose --profile proxy up -d
```

Create a project and service, add its hostname and internal application port in **Domains**, save, then **Deploy**. Services with domains join the `harborlight-proxy` network. The bundled proxy discovers container labels and requests certificates for HTTPS domains. A saved domain is configuration, not proof that DNS or a certificate is ready.

To expose the panel itself over HTTPS after owner setup, configure `PANEL_DOMAIN` and `ACME_EMAIL` in `.env`:

```sh
docker compose -f compose.yaml -f compose.public.yaml --profile proxy up -d
```

### Data and updates

The `harborlight-data` volume contains panel state, its encryption key, build workspaces, and local backups. Back up **the entire data volume**, including `encryption.key`, while the panel is stopped. The key is required to recover the encrypted state. Service data lives in separate named Docker volumes; back those up independently.

```sh
git pull --ff-only
docker compose up -d --build panel
```

Deleting a service retains its named volumes. Inspect and remove unwanted volumes explicitly after confirming recovery is unnecessary. `docker compose down` stops the panel and optional proxy; it does not stop separately deployed applications. Avoid `down --volumes` unless you intend to remove panel data and certificates.

## Development and checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite builds and starts an isolated production server in demo mode. Docker checks are separately opt-in because they create real containers and volumes:

```sh
npm run test:docker
npm run test:proxy
docker build -t harborlight:local .
npm run test:package
```

These scripts clean up their disposable resources. The CI workflow exercises API/browser behavior, real Docker deployment and routing, and the built container.

## Architecture

- React + TypeScript + Vite, with an original responsive interface.
- Fastify API; owner authentication and HttpOnly session cookies.
- Encrypted, atomically persisted local state for a single server process.
- Docker CLI subprocesses with explicit argument arrays and managed-resource labels.
- Traefik integration for host/path routing and Let's Encrypt HTTPS.
- A separately selected demo runtime for local exploration and browser testing.

See [API-CONTRACT.md](API-CONTRACT.md), [reference analysis](docs/REFERENCE-ANALYSIS.md), and [security model](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Each feature should have an explicit acceptance criterion, an original implementation, and verification against its real runtime where relevant. Do not contribute proprietary source, extracted bundles, licensed product assets, or credentials.

Harborlight is not affiliated with or endorsed by Easypanel. The reference installer and extracted distribution used during analysis are not included in this repository.
