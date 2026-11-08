# FullPanel community site and API

Standalone Node.js 24 website and read-only information API. This directory is deployed by itself. It does not import the self-hosted panel, access Docker, require a database, or persist submissions.

```sh
cd community
npm test
npm start
```

There are no npm dependencies or build step. `Procfile` defines one `web` process. On Heroku, configure that process as **one Basic dyno**; no worker or add-on is required.

## Public contract

- `GET /api/health` (also `HEAD`): `{ "status": "ok", "service": "fullpanel-community" }`. This checks this HTTP process only.
- `GET /api/v1/info` (also `HEAD`): API version `v1`, product name, Apache-2.0 license, fixed GitHub links, the configured release commit or `null`, and `communityDomains: { status: "planned", registrationEnabled: false }`.
- `/api/v1/community-domains` and `/api/v1/community-domains/register`: reserved, return HTTP 503 with error code `COMMUNITY_DOMAINS_UNAVAILABLE`. No registration, token issuance, token validation or DNS operation is implemented. Bodies are not parsed or stored; non-read requests close their connection. `Expect` requests are refused with HTTP 417 before upload.
- Unknown API and static paths return HTTP 404; there is no SPA fallback. Known read endpoints refuse other methods with HTTP 405.

Static files under `public/` support GET/HEAD, bounded request paths, content types, ETags and cache revalidation. Directories, hidden files, symlinks and traversal paths are not served. Assets stream from disk with backpressure. Only the public directory is exposed; application source and environment variables are never served.

## Environment

| Variable | Behavior |
| --- | --- |
| `PORT` | Listener port; defaults to 3000. Binds `0.0.0.0`. Heroku supplies this value. |
| `COMMUNITY_RELEASE_COMMIT` | Optional complete lowercase 40-character Git SHA exposed as `release.commit`. Invalid values stop startup. |
| `COMMUNITY_TRUST_HEROKU_PROXY` | Defaults to `false`. Set exactly `true` only behind the Heroku router. |
| `COMMUNITY_CANONICAL_HOST` | Required in trusted Heroku mode. Lowercase DNS hostname only, without scheme, port or path. |

In Heroku mode, HTTP requests to served pages/read APIs redirect to the fixed canonical HTTPS host. HTTPS requests with a different Host receive 421. Missing or ambiguous `X-Forwarded-Proto` is refused. `X-Forwarded-Host` is never trusted. Local HTTP remains usable when proxy mode is disabled.

Before custom DNS and TLS are ready, use the app's assigned `*.herokuapp.com` hostname as canonical. Switch to the chosen custom canonical host after verifying its DNS and certificate. Attaching a domain in Heroku does not by itself publish the website or issue a certificate.

Responses set a CSP permitting only same-origin scripts/styles/assets/connections, `nosniff`, frame protection and a restrictive Permissions Policy. The server does not log request URLs, headers, credentials or bodies. Node request/header/socket timeouts and connection limits bound idle requests. SIGTERM stops accepting requests and allows up to 10 seconds for active connections before closing them.

## Deployment boundary

Deploy only this `community/` subtree to `fullpanel-web-api`. Never push the repository root to this Heroku app: the root package is the self-hosted Docker management panel. No AWS credentials, panel state, `.local` files or Docker socket belong in the community deployment.

The website and this API are a first public release. Community domain registration remains planned. A future registration service needs its own authentication, durable storage, ownership verification and abuse controls before that status can change.
