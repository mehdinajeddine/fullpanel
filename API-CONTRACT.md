# Harborlight implementation contract

All JSON APIs under `/api`. Errors: `{ error: string }` with proper HTTP status. Types in `shared/types.ts`. All endpoints except health/session/setup/login require an owner session (HttpOnly SameSite strict cookie). Request origin verification for mutations. Default mode docker. Explicit `HARBORLIGHT_MODE=demo` provides clearly identified demo data and simulated runtime; no automatic fallback to demo.

- GET `/health` -> `{ok:true}`; GET `/auth/session` -> Session.
- POST `/auth/setup` {name,email,password} (first owner only); POST `/auth/login` {email,password}; POST `/auth/logout`. Setup/login -> Session.
- GET `/overview` -> Overview. GET `/metrics` -> Metrics.
- GET `/projects` -> Project[]; POST `/projects` {name,description?,color?} -> Project; PATCH `/projects/:id` partial -> Project; DELETE `/projects/:id` (only empty, 409 otherwise).
- GET `/services` -> Service[]; optional ?projectId=; GET `/services/:id` -> Service; POST `/services` {projectId,name,kind,source?,env?,domains?,mounts?,ports?,resources?,notes?} -> Service. PATCH `/services/:id` partial settings -> Service. DELETE `/services/:id` removes runtime/config but retains named volumes; requires UI typed name confirmation. Database services generate secure defaults and persistence.
- POST `/services/:id/deploy` -> Deployment (202, async worker). POST `/services/:id/start`, `/stop`, `/restart` -> Service. GET `/services/:id/logs?tail=200` -> `{logs:string}`. GET `/services/:id/deployments` -> Deployment[]. GET `/deployments` -> Deployment[]. GET `/deployments/:id` -> Deployment.
- GET `/services/:id/backups` -> Backup[]. POST `/services/:id/backups` -> Backup (202 async). GET `/backups` -> Backup[]. GET `/backups/:id/download` -> attachment. Manual local database/volume backups. No fake scheduling/restore.
- GET `/templates` -> Template[]. POST `/templates/:id/install` {projectId,name} -> Service (config only, explicit Deploy follows).
- GET `/activity` -> Activity[]. GET `/settings` -> Settings; PATCH `/settings` -> Settings.

Use relative fetch with credentials same-origin. Backend serves dist/client SPA in production, dev Vite proxies :3000. Node >=22.13, npm. Root owner controls shared types/config/infra; backend agent owns server/; frontend owns src/ and index.html; reference agent owns docs/specs, docs/FEATURE-PARITY.md, docs/REFERENCE-ANALYSIS.md. Coordinate contract extensions before changing shared types.
