# Harborlight implementation contract

All JSON APIs are under `/api`. Errors: `{ error: string }` with proper HTTP status. Public types are in `shared/types.ts`; private credential models never form part of a service response. Use same-origin browser cookies or `Authorization: Bearer hl_…` for scoped API keys. Mutations verify request origins. Docker is the default mode; `HARBORLIGHT_MODE=demo` explicitly selects simulated workloads.

Owner/admin browser sessions manage accounts, projects, server settings and global metrics. Members have viewer or operator access to selected projects. Viewers inspect status without secrets, deployment output, runtime logs or backup downloads. Operators configure and run workloads. Inventories omit environment values for every role. Cross-project resources return 404; insufficient privilege returns 403. API keys add project/read-write restrictions to their issuing account's current authority and cannot manage accounts, authentication, server settings, other API keys or deployment triggers.

- GET `/health` -> `{ok:true}`; GET `/auth/session` -> Session.
- POST `/auth/setup` {name,email,password} (first owner only); POST `/auth/login` {email,password}; POST `/auth/logout`. Setup/login -> Session.
- GET `/overview` -> Overview. GET `/metrics` -> Metrics.
- GET `/projects` -> Project[]; POST `/projects` {name,description?,color?} -> Project; PATCH `/projects/:id` partial -> Project; DELETE `/projects/:id` (only empty, 409 otherwise).
- GET `/services` -> filtered Service[]; optional ?projectId=; GET `/services/:id` -> role-filtered Service; POST `/services` {projectId,name,kind,source?,env?,domains?,mounts?,ports?,resources?,notes?} -> Service. PATCH `/services/:id` partial settings -> Service. DELETE `/services/:id` removes runtime/config but retains named volumes and backup files; UI uses typed name confirmation. Database services generate secure defaults and persistence.
- POST `/services/:id/deploy` {forceRebuild?} -> Deployment (202, async worker). Git/inline Dockerfile sources support forced rebuild. POST `/services/:id/start`, `/stop`, `/restart` -> Service. GET `/services/:id/logs?tail=200` -> `{logs:string}` (2000 maximum). GET `/services/:id/deployments` -> Deployment[]. GET `/deployments` -> Deployment[]. GET `/deployments/:id` -> Deployment. Lists are access-filtered; viewer output is blank. Conflicting operations return 409.
- GET `/services/:id/backups` -> Backup[]. POST `/services/:id/backups` -> Backup (202 async). GET `/backups` -> filtered Backup[]. GET `/backups/:id/download` -> attachment, operator required. GET `/backup-schedules`, GET/POST `/services/:id/backup-schedules`, PATCH/DELETE `/backup-schedules/:id`, POST `/backup-schedules/:id/run`. UTC schedules and local retention are described in [the schedule specification](docs/specs/06-backup-schedules.md). No product restore endpoint yet.
- GET `/templates` -> Template[]. POST `/templates/:id/install` {projectId,name} -> Service (config only, explicit Deploy follows).
- GET `/activity` -> Activity[]. GET `/settings` -> Settings; PATCH `/settings` -> Settings.

## Accounts and machine credentials

- GET `/users` -> public accounts; POST `/users` {name,email,password,role,memberships} -> account (201). Role is admin/member; memberships are `{projectId,role:'viewer'|'operator'}`.
- PATCH `/users/:id` {name?,email?,role?,memberships?,disabled?}; DELETE `/users/:id`; POST `/users/:id/password` {password}. The owner cannot be deleted or demoted. Privilege/email changes, password reset, disabling and deletion revoke the account's sessions, keys and deployment triggers.
- GET `/api-keys` lists the browser user's metadata. POST `/api-keys` {name,projectIds,permission:'read'|'write',expiresInDays?} -> metadata plus a one-time token (201). Expiry defaults to 90 days, maximum 365. DELETE `/api-keys/:id` revokes an owned key.
- GET `/services/:id/trigger` -> metadata; POST `/services/:id/trigger/rotate` returns a token once; DELETE revokes it. Public POST `/hooks/deploy/:id` requires that service-specific bearer token, distinct from API keys. This is not a native GitHub HMAC webhook.

## Sources and routing

- GET `/services/:id/source-credentials` returns scopes/capabilities. PUT `/services/:id/source-credentials/git` {username,token} or `/registry` {username,password} stores credentials for the saved source. DELETE on either kind revokes it. Secrets never appear in metadata. Changing the repository revokes mismatched credentials. Private registry support covers image pulls, not build bases/Compose.
- Domains contain id,hostname,port,https,path and optional primary,upstreamScheme,stripPrefix,redirectToHttps. Only one primary exact hostname is allowed. Wildcards match one subdomain level and use HTTP with the bundled proxy. Path boundaries are segment-aware. Upstream HTTPS verifies certificates.
- GET `/services/:id/domains/:domainId/auth` -> {enabled,username?}. PUT at the same path accepts {username,password}; DELETE removes protection. Passwords are 12–72 UTF-8 bytes, hashed with bcrypt. Only operators can use these endpoints. The service must be idle; save then deploy to apply changes. No password/hash is returned.

Production serves `dist/client`; development Vite proxies to port 3000. The CLI in `scripts/harborlight.mjs` uses the same endpoints and has no additional authority. Node >=22.13, npm.
