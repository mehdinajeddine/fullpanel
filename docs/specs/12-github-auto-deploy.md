# Native GitHub push deployment

This is an independent implementation of GitHub's documented webhook protocol. It does not require a GitHub App installation or OAuth connection. The operator configures a repository webhook in GitHub after generating its secret in Harborlight.

## Operator flow

Save an application with an HTTPS GitHub.com Git source and a branch. In Source, generate the GitHub webhook secret. Copy the displayed endpoint into the repository's webhook settings, select `application/json` and push events, paste the secret, and leave GitHub's TLS verification enabled. An Internet-accessible HTTPS panel endpoint is required for GitHub to deliver requests; a local endpoint alone does not prove external delivery.

The secret appears only in the generation response. Reopening the controls shows configuration and the most recent accepted deployment, never the secret. Rotating replaces it immediately; revoking disables delivery. Changing the saved repository or branch invalidates the old binding permanently until explicit rotation, even if the source is later changed back. Build-context and Dockerfile edits remain ordinary desired configuration.

Cookie-authenticated project operators can manage the webhook. Viewers and API keys cannot read its controls or issue credentials. Changes to the issuing account's credentials or permissions revoke its webhook, and delivery independently checks that the issuer still has operator access. Demo mode reports the integration as unavailable.

## HTTP contract

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/services/:id/github-webhook` | Supported/configured/enabled status, binding, endpoint and last accepted delivery |
| POST | `/api/services/:id/github-webhook/rotate` | Status plus one-time `secret`; accepts an empty JSON object |
| DELETE | `/api/services/:id/github-webhook` | Revoked status |
| POST | `/api/hooks/github/:id` | Public signed-delivery endpoint |

A valid accepted push returns `202` with `status: "queued"`, `deploymentId` and `requestedCommit`. An already accepted delivery returns `200` with `status: "duplicate"` and its original deployment ID. A supported but irrelevant event returns `200` with `status: "ignored"`; a signed ping returns `status: "pong"`. Invalid or revoked signatures return `401`, malformed signed input `400`, and an occupied service `409`. A busy response does not consume the delivery, so it can be redelivered.

Only this exact POST route bypasses ordinary account authentication. Its isolated JSON content parser retains a raw byte buffer. The body is limited to 1 MiB, uncompressed `application/json`, with UTF-8 when a charset is specified. The endpoint allows 60 requests per minute per source IP. Ordinary API JSON parsing and origin checks remain in force.

## Authentication and admission

The server computes HMAC-SHA256 over the original bytes and compares the fixed-size digest with `X-Hub-Signature-256` in constant time before parsing JSON. The high-entropy secret is stored inside the encrypted state file; unlike a bearer token, HMAC verification requires the original secret. Request bodies and secrets must not enter logs or deployment output.

Admission checks the event, repository full name and canonical GitHub URL, exact `refs/heads/<branch>`, `deleted: false`, and a nonzero 40-character commit SHA. Tags, branch deletions and other branches do not deploy. The runtime fetches/checks out the signed push's exact SHA under the existing HTTPS Git credential protections and records both the requested and actual revision. It never takes a repository URL or shell command from the delivery.

The newest 256 accepted receipts per configured service retain both the delivery UUID and SHA-256 of the signed body. GitHub does not sign the delivery header, so changing that header cannot bypass body deduplication within this retained window. This bounded history is not a permanent replay ledger. Secret rotation replaces both the secret and its receipt history. Acceptance and creation of the deployment record share one durable state write; rejection leaves no accepted receipt.

The deployment uses the existing service operation lock, desired configuration snapshot and output/history UI. A `202` means admission, not successful execution. Interrupted work remains a failed attempt after restart and requires deliberate redelivery with a new event or manual deployment rather than silently rerunning infrastructure work.

## Verification

The module and application tests cover protocol and account boundaries. `scripts/smoke-github.ts` exercises the actual HTTP parser, signed payloads, exact public Git revision, image build, HTTP-serving container, duplicates, busy redelivery, encrypted restart and invalidation. Its source fixture is [NGINX's public demonstration repository](https://github.com/nginxinc/NGINX-Demos/tree/master/nginx-hello). It sends local signed fixtures; it does not claim a delivery from GitHub's production servers.

Protocol references: [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks). Verification results belong in [VERIFICATION.md](../VERIFICATION.md).
