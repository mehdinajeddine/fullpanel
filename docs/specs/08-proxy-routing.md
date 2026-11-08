# Proxy routing and credentials

Harborlight renders its own validated service configuration into Traefik Docker labels. Users cannot supply arbitrary router expressions or labels. The public domain model contains no credentials.

Exact hostnames take precedence over wildcard hostnames. `*.example.test` matches one subdomain level, excluding the apex and nested subdomains. Within the same hostname, the longest matching path wins. `/api` matches `/api` and `/api/...`, excluding `/apix`; duplicate slashes and dot segments are rejected. A trailing slash is normalized away except at the root.

Hostnames and overlapping wildcards belong to one project across all paths. Another project's operator cannot take over a subpath or a more specific hostname. The configured panel hostname (`PUBLIC_URL` or `PANEL_DOMAIN`) is reserved even against administrator-created service routes. Existing invalid overlaps are rejected before redeployment; configuration validation does not silently rewrite running containers.

An optional primary exact hostname drives the UI's Open action. Prefix removal forwards the remainder of a non-root configured path to the application. Upstream HTTPS uses Traefik's certificate verification; there is no insecure verification bypass. These behaviors use Traefik's [router rules](https://doc.traefik.io/traefik/v3.6/reference/routing-configuration/http/routing/rules-and-priority/) and [StripPrefix middleware](https://doc.traefik.io/traefik/v3.6/reference/routing-configuration/http/middlewares/stripprefix/).

When enabled on an HTTPS route, the HTTP redirect uses a separate router and [RedirectScheme middleware](https://doc.traefik.io/traefik/v3.6/reference/routing-configuration/http/middlewares/redirectscheme/), preserving the request host, path and query. Authentication runs on the destination route. Wildcard HTTPS is rejected because the bundled proxy configures HTTP certificate challenges, not DNS challenges.

Route password protection stores a bcrypt hash in encrypted server state. The API only returns enabled status and username. The [BasicAuth middleware](https://doc.traefik.io/traefik/v3.6/reference/routing-configuration/http/middlewares/basicauth/) removes the Authorization header before forwarding. Hashes are visible to Docker administrators through labels. Rotate/remove operations update saved configuration; deployment activates them. Concurrent deletion or permission revocation during password hashing prevents the write.

Tests in `server/proxy-auth.test.ts` cover API secrecy, revocation during hashing and invalid configuration. `scripts/smoke-proxy.ts` runs actual Traefik and Nginx, verifying host/path boundaries, wildcard isolation and precedence, prefix removal, rejected/accepted credentials, credential rotation, absence of forwarded authorization, HTTP-to-HTTPS redirect and runtime limits. Upstream TLS certificate behavior and public ACME issuance are not established by this HTTP fixture.
