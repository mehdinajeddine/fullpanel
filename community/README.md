# FullPanel community site and API

Standalone Node.js 24 website and read-only information API, with an internal PostgreSQL installation registry. This directory is deployed by itself. It does not import the self-hosted panel or access Docker. Public registration remains disabled; no visitor submissions are accepted.

```sh
cd community
npm ci
npm test
npm start
```

The only direct npm dependency is `pg`, locked with its transitive dependencies. `heroku-postbuild` verifies the bundled dependency notices without changing them. `Procfile` defines one `web` process. The authorized Heroku configuration is **one Basic web dyno and one Postgres Essential-0 database**; there is no separate worker. The website and information API remain available without a configured or reachable database.

## Public contract

- `GET /api/health` (also `HEAD`): `{ "status": "ok", "service": "fullpanel-community" }`. This checks this HTTP process only.
- `GET /api/ready` (also `HEAD`): HTTP 200 with `{ "status": "ready", "service": "fullpanel-community" }` when PostgreSQL answers and the expected registry schema is installed. Otherwise HTTP 503 with `REGISTRY_UNAVAILABLE`. Concurrent probes share one database request and results are cached for one second. This endpoint neither migrates the database nor indicates DNS registration is available.
- `GET /api/v1/info` (also `HEAD`): API version `v1`, product name, Apache-2.0 license, fixed GitHub links, the configured release commit or `null`, and `communityDomains: { status: "planned", registrationEnabled: false }`.
- `/api/v1/community-domains` and `/api/v1/community-domains/register`: reserved, return HTTP 503 with error code `COMMUNITY_DOMAINS_UNAVAILABLE`. No registration, token or DNS operation is exposed through HTTP. Bodies are not parsed or stored; non-read requests close their connection. `Expect` requests are refused with HTTP 417 before upload.
- Unknown API and static paths return HTTP 404; there is no SPA fallback. Known read endpoints refuse other methods with HTTP 405.

Static files under `public/` support GET/HEAD, bounded request paths, content types, ETags and cache revalidation. Directories, hidden files, symlinks and traversal paths are not served. Assets stream from disk with backpressure. Only the public directory is exposed; application source and environment variables are never served.

## Environment

| Variable | Behavior |
| --- | --- |
| `PORT` | Listener port; defaults to 3000. Binds `0.0.0.0`. Heroku supplies this value. |
| `COMMUNITY_RELEASE_COMMIT` | Optional complete lowercase 40-character Git SHA exposed as `release.commit`. Invalid values stop startup. |
| `COMMUNITY_TRUST_HEROKU_PROXY` | Defaults to `false`. Set exactly `true` only behind the Heroku router. |
| `COMMUNITY_CANONICAL_HOST` | Required in trusted Heroku mode. Lowercase DNS hostname only, without scheme, port or path. |
| `DATABASE_URL` | Optional operator-supplied PostgreSQL URL. TLS chain and hostname verification are mandatory; URL query parameters cannot override TLS policy. Keep this secret. No migration runs at startup or on a public request. |
| `COMMUNITY_DATABASE_CA_FILE` | Optional trusted PEM CA bundle path. On Heroku-24 use `/usr/lib/ssl/certs/ca-certificates.crt`, which includes the AWS RDS authorities. No production option disables certificate verification. |

In Heroku mode, HTTP requests to served pages/read APIs redirect to the fixed canonical HTTPS host. HTTPS requests with a different Host receive 421. Missing or ambiguous `X-Forwarded-Proto` is refused. `X-Forwarded-Host` is never trusted. Local HTTP remains usable when proxy mode is disabled.

Before custom DNS and TLS are ready, use the app's assigned `*.herokuapp.com` hostname as canonical. Switch to the chosen custom canonical host after verifying its DNS and certificate. Attaching a domain in Heroku does not by itself publish the website or issue a certificate.

Responses set a CSP permitting only same-origin scripts/styles/assets/connections, `nosniff`, frame protection and a restrictive Permissions Policy. The server does not log request URLs, headers, credentials or bodies. Node request/header/socket timeouts and connection limits bound idle requests. SIGTERM stops accepting requests and allows up to 10 seconds for active connections before closing them.

## Deployment boundary

Deploy only this `community/` subtree to `fullpanel-web-api`. Never push the repository root to this Heroku app: the root package is the self-hosted Docker management panel. No AWS credentials, panel state, `.local` files or Docker socket belong in the community deployment.

## Internal registry and server proof

See [registry/README.md](registry/README.md) for the migration and store contract. The internal store reserves random permanent server identities, hashes tokens, scopes operations to an owner, and handles idempotent rotation/revocation transactionally. Its caller must eventually supply a trusted authenticated owner; the store itself does not authenticate users. No public handler currently calls these mutations.

`domain-proof.mjs` creates short-lived challenges bound to an installation, server identity and ordinary public IPv4 address. Its verifier makes a bounded HTTP request to the literal address on port 80 at the fixed `/.well-known/fullpanel-domain-proof` path. Private/special addresses, redirects, proxies, mismatched socket peers and oversized/slow responses are refused. Tests use the native HTTP parser with injected sockets, without sending external traffic. This is only a proof observation: durable challenge consumption, authorization, abuse controls, DNS writes and activation remain to be implemented.

`npm run test:registry` uses Docker to create its own disposable PostgreSQL container and volume, tests migrations/concurrency/token lifecycle/persistence, and cleans up only its labeled resources. It never uses the operator's `DATABASE_URL`. It is a development/CI fixture, excluded from the Heroku slug.

Run `npm run licenses:generate` after changing dependencies, review and commit the generated public notices, then verify with `node generate-notices.mjs --check`. Complete npm notices and the separate Inter license are distributed in `public/licenses/`.
