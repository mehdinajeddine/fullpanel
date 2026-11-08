# Contributing to FullPanel

FullPanel's code and visual identity are original. Functional analysis of reference products belongs in specifications with evidence and attribution. Do not copy proprietary implementations, bundle fragments, graphics, or brand assets.

1. Pick an acceptance criterion from `docs/FEATURE-PARITY.md`.
2. Explain the user-visible behavior and its limitations.
3. Implement the smallest complete workflow, including errors, authorization, persistence, and recovery where applicable.
4. Run type checks, focused tests, and the production build. Test Docker changes against disposable managed resources.
5. Update the feature matrix and verification record with what passed. A demo simulation is not evidence of a real deployment.

Use Node 24 LTS and `npm ci`. Keep dependency versions in `package-lock.json`. Never commit `.data`, `.env`, backups, credentials, or extracted reference binaries. The API contract and shared TypeScript types must stay consistent with the browser.

Pull requests should describe the problem, the resulting behavior, and meaningful verification. Security-sensitive changes should include failure and abuse cases. Apache-2.0 applies to contributions.

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
npm run test:credentials
npm run test:git
npm run test:environment
# Cached PostgreSQL, Redis, Nginx and alpine:3.21 images are required.
HARBORLIGHT_RESTORE_TEST_ENGINES=postgres,redis,app npm run test:restore
# Requires a production browser build and installed Playwright browser.
npm run test:restore-ui
npm run test:restore-recovery
docker build -t harborlight:local .
npm run test:package
```

These scripts clean up their disposable resources. The CI workflow exercises API/browser behavior, real Docker deployment and routing, and the built container.

## Architecture

- React + TypeScript + Vite, with an original responsive interface.
- Fastify API; per-project access controls, scoped API keys and HttpOnly session cookies.
- Encrypted, atomically persisted local state for a single server process.
- Docker CLI subprocesses with explicit argument arrays and managed-resource labels.
- Traefik integration for host/path routing, bcrypt HTTP authentication and Let's Encrypt HTTPS.
- A separately selected demo runtime for local exploration and browser testing.

See [API-CONTRACT.md](API-CONTRACT.md), [reference analysis](docs/REFERENCE-ANALYSIS.md), and [security model](SECURITY.md).

## Experimental terminal

The terminal prototype is disabled by default. `HARBORLIGHT_EXPERIMENTAL_TERMINAL=true` enables development testing; real Docker PTY behavior and durable session cleanup after a crash still need verification. See the [verification record](docs/VERIFICATION.md) before changing its availability.
