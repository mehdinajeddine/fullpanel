# Deployment triggers

Implementation module: `server/webhooks.ts`. Isolated verification: `node --import tsx --test server/webhooks.test.ts` (8 tests passing on 2026-11-08). The application integration test in `server/tests/app.test.ts` additionally checks the production API authentication boundary and shared manual-deployment lock with an injected test runtime. The trigger UI is implemented; its browser workflow and a trigger-to-Docker run have not been separately exercised.

## User flow

An authenticated administrator opens a service's deployment trigger controls, generates a token, copies it into the CI system's secret store, and uses it to submit a deployment. The token is visible only in the generation response. Reopening the page shows enabled/disabled state and endpoint, without revealing the token or its hash.

Rotating immediately replaces the previous token. Revocation disables the trigger. Removing a service makes its trigger unusable even if an orphaned stored hash remains. Every valid request uses the same deployment queue and concurrency boundary as a manual deployment. A busy service returns a conflict instead of starting overlapping work.

## API contract

All paths are relative to the panel origin. Management routes use the panel's ordinary authenticated session. The trigger route uses a separate bearer credential.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/services/:id/trigger` | Trigger status |
| POST | `/api/services/:id/trigger/rotate` | Status plus a newly generated `token` |
| DELETE | `/api/services/:id/trigger` | Disabled status |
| POST | `/api/hooks/deploy/:id` | `202` with the queued deployment |

Status has `enabled`, `endpoint`, `method: "POST"`, `authorization: "Bearer"`, and `tokenVisibleOnce: true`. The endpoint is absolute when the server has a configured public URL; otherwise it is a relative path. The token never belongs in the URL, query parameters or request body.

The trigger credential is 32 cryptographically random bytes encoded as base64url. The server stores its SHA-256 hash, compares fixed-size digests in constant time, and never stores the raw bearer token. The existing encrypted state store owns durable hash storage.

Use the request header `Authorization: Bearer <token>`. Unauthenticated, malformed, revoked and wrong-service credentials return `401`. A service already performing an operation returns `409`. Payloads are limited to 16 KiB, and trigger requests are limited to 20 per minute per source IP with the registered Fastify rate limiter. Unknown or unsupported routes do not acquire public access merely because their path contains `hooks`.

## CI use

Keep the token in the CI provider's secret store and mask it in job output. Send a POST to the service's displayed endpoint with the bearer header. Follow the returned deployment ID through the authenticated panel to inspect the result; accepting the trigger is not proof that the deployment succeeded.

This is a generic CI deployment trigger. It does **not** implement GitHub's native HMAC-signed webhook protocol or branch filtering. GitHub Actions can call it from a workflow using a stored secret. A native GitHub webhook integration is a separate feature and must validate the raw request signature, event type and branch before using the same queue.

## Integration requirements

- Register `@fastify/rate-limit` before this module.
- Keep all management routes under the standard authenticated API hook.
- Exempt only POST requests whose exact path is `/api/hooks/deploy/<UUID>` from session authentication; the module performs bearer authentication.
- Provide a synchronous durable hash setter, a scoped service lookup, and the existing deployment queue callback.
- Remove the hash when deleting a service.
- Do not log authorization headers or generation responses. Keep response caching disabled.
- Keep external-origin/CSRF checks for browser requests. Server-to-server CI clients normally send no Origin header.

## Test coverage

The isolated test suite verifies management authentication, disabled defaults, one-time token disclosure, hash-only persistence, correct queue identity, immediate rotation and revocation, wrong-service rejection, deleted-service rejection, ignored query/body credentials, concurrency conflicts, rate limiting, wrong HTTP methods, malformed credentials and payload-size enforcement. Real application integration should also test the production authentication hook and persistence through a server restart.
