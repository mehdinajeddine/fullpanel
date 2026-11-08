# Default test URL and certificate state

Status: **partial implementation** on 2026-11-08: opt-in public-IPv4 HTTP hostname allocation is implemented; public service reachability and HTTPS are not verified. Tracks R08 (default and primary domains), R07 (HTTPS) and R06 (routing). This supplements the current backlog; the approved DOCX and historical corpus remain dated snapshots.

Future dependency: [M03's server-purpose policy](17-server-purpose.md) will require restricted HTTPS access and authentication for development/staging. Today's generated HTTP route does not satisfy that policy; it must not remain an unprotected alternative when M03 is implemented.

## Current behavior and missing outcome

Settings → **Automatic test URLs** exposes **Public server IPv4**, stored as `settings.testDomainIp`. Empty is the default and disables future automatic test URLs. An owner/admin can enter the server's canonical public IPv4; private, loopback, special-use/reserved addresses, IPv6 and leading-zero forms are rejected. This validates address syntax/policy, not ownership or reachability. No public address is discovered automatically.

When a create request omits `domains` and `kind` is `app`, allocation follows this precedence:

1. A nonempty `baseDomain` retains the existing `<service>-<project>.<baseDomain>` HTTPS route and takes priority.
2. Otherwise, a nonempty `testDomainIp` creates `fp-<service-UUID-without-hyphens>.<IPv4-with-hyphens>.sslip.io`, with `https: false`, path `/` and target port 80 or the template's declared HTTP port.
3. Otherwise, no domain is generated.

Explicit domains, including `domains: []`, are preserved. Databases and Compose services receive no automatic route. The UUID makes the saved test hostname independent of project/service renames. Editing or clearing the IP, or changing the base domain, affects future creations only; existing routes are not rewritten. Existing state without the setting defaults to empty. Selecting a primary exact hostname still controls Open.

The administrator supplies the IP once, but does not manually create per-service DNS records for this provider. The proxy must still be running and reachable on port 80, and the target application must listen on the selected internal port. The Settings preview and enabled state do not perform DNS or HTTP probes. The generated route is HTTP for testing; HTTPS must be configured separately before transmitting sensitive data.

`compose.yaml` defines a Traefik Let's Encrypt resolver using `ACME_EMAIL`, persistent certificate storage and the HTTP challenge on the web entrypoint. TLS labels select that resolver. The API's saved `letsEncryptEmail` setting does not currently reconfigure the deployed proxy. Existing tests establish HTTP routing and redirect responses, not public issuance, certificate trust or renewal.

The required outcome is that an operator can create an HTTP application and open its test URL **without buying a domain or manually creating DNS records**. The URL must identify the correct service and target port, survive panel restart, and make its actual reachability and certificate state clear.

## Address allocation and deployment modes

The implemented slice uses sslip.io's IP-encoding DNS service. A FullPanel-controlled domain with automated DNS provisioning is a separate future strategy. Provider availability and the client's DNS resolver remain external dependencies. A provider change must preserve existing saved routes until an operator deliberately migrates them.

Surge can host a separately built static interface demonstration at a `surge.sh` name. Its documented publishing service serves static files, and its custom-domain setup directs traffic to Surge's infrastructure. Therefore it does not satisfy this requirement to route a generated test hostname to the user's Docker server or run the FullPanel API and workloads. This is an architectural choice inferred from [Surge's publishing model](https://surge.sh/) and [domain documentation](https://surge.sh/docs/platform/custom-domains); no Surge deployment or integration is implemented or claimed.

The current slice requires an explicitly supplied public IPv4 and never derives it from request Host or forwarded headers. A future address-discovery or IPv6 extension needs its own validation and evidence. Stable identifiers and the existing project/domain ownership checks apply to the generated routes.

Public DNS resolution alone does not establish service reachability: NAT, ingress ports, the proxy, application port and application response must also work. Separate diagnostics remain future work. A local-only/offline endpoint is also future work; this setting refuses loopback/private addresses. Do not present a localhost link as remotely reachable or rely on external DNS for the local-only verification fixture. A local HTTP success is not public HTTPS evidence.

Do not automatically expose database ports or infer an HTTP route for arbitrary Compose children. Initially, default test URLs cover single-container HTTP applications and templates with an explicit HTTP target port. Retain custom domains and an explicitly chosen primary domain. Deleting a service removes its route and any provider-owned record where applicable; allocation must not reuse an old identifier in a way that directs an old URL to a different service.

## HTTPS behavior and external dependencies

The nip.io/sslip.io operator documents names containing an IP address, including prefixes and IPv6 encoding. On the consultation date, sslip.io redirected to nip.io; these names must not be presented as independent redundant providers. Certificate issuance for an externally accessible hostname is a separate CA operation. [Provider documentation](https://nip.io/)

The bundled HTTP-01 strategy requires validation reachability on public port 80 and does not issue wildcard certificates. DNS-01 is a separate future integration requiring control of challenge records. Local-only service access does not satisfy the public HTTP challenge. [Let's Encrypt challenge documentation](https://letsencrypt.org/docs/challenge-types/)

The implementation must connect its effective ACME identity/configuration to the actual proxy, distinguish pending issuance from a certificate verified by a normal TLS client, and retain persistent account/certificate data across restarts. Failed resolution, blocked validation ports or CA failures must leave an actionable state with bounded retries. Do not represent a configured `https` field or a redirect response as an issued certificate. Do not test by disabling TLS verification or silently weakening a route configured to require HTTPS.

Provider and CA rate limits/availability remain external constraints; the product must not promise unlimited certificates or uninterrupted third-party DNS. Do not silently switch names or retry issuance without bounds. Certificate renewal must have its own recorded result; a first successful issue does not prove renewal.

## Recorded evidence for this slice

The production build/typecheck and **19 demo-runtime browser workflows** passed, including the new Settings flow: private IPv4 rejection, public IPv4 save/reload, exact UUID-based HTTP route with app port 80, a Dozzle template route with port 8080, custom-base-domain precedence, and disabling allocation while preserving existing routes. Desktop and 390px mobile captures were visually inspected: [Settings desktop](../images/r08-test-urls-desktop.png), [Settings mobile](../images/r08-test-urls-mobile.png). This browser evidence exercises the actual API and simulated workload adapter; it does not establish external routing. Additional API/runtime evidence is tracked in [VERIFICATION.md](../VERIFICATION.md).

## Acceptance and non-regression scenarios

| ID | Scenario | Required evidence |
| --- | --- | --- |
| R08-01 | Fresh public installation with no base domain; create an HTTP application. | A persisted, unique test URL resolves and serves the expected body through the proxy, with no user DNS record or purchased domain. Record the actual provider and public address used. |
| R08-02 | Two projects use the same service name; rename one and restart the panel. | Distinct stable URLs still reach the intended services; primary/custom domains and ownership reservations remain correct. |
| R08-03 | Long names, IPv4/IPv6 addresses and invalid or spoofed address inputs. | Canonical valid hostnames or explicit validation failures; no trust in unapproved Host/forwarded headers and no cross-project capture. |
| R08-04 | Provider DNS fails, resolves to an unexpected address, or the ingress port is blocked. | The UI distinguishes resolution/reachability failure, does not claim success, preserves saved configuration and avoids unbounded allocation/issuance retries. |
| R08-05 | Local-only installation without external DNS access. | A documented local HTTP endpoint serves the expected app from the intended client; UI labels it local and makes no public TLS claim. This is a separate fixture from R08-01. |
| R08-06 | Existing custom primary domain, default-provider change, service deletion or duplicate allocation. | No silent primary replacement or destructive migration; exact-owned route/record cleanup, persistent reservations and no old-URL reassignment to another service. |
| R07-01 | Public generated hostname with correctly configured proxy and ACME identity. | Complete a staging issuance fixture, then record an authorized public certificate proof with ordinary trust/hostname validation; include certificate issuer, validity and hostname. No TLS verification bypass. |
| R07-02 | Invalid ACME identity, blocked port 80, provider/CA failure and panel restart. | Honest issuance state, useful error, bounded retries and retained account/certificate storage. HTTP routing or redirects alone cannot satisfy the test. |
| R07-03 | Renewal path and HTTPS-only access policy. | Separately record renewal with controlled CA/testing infrastructure and continued routing after proxy restart; failures never silently relax HTTPS requirements. Real elapsed production renewal remains a distinct longer-term proof. |

These complete scenarios remain acceptance targets, not a completion claim. The implemented slice covers allocation, precedence and saved-state behavior; its current test results are recorded in [VERIFICATION.md](../VERIFICATION.md). A Traefik fixture reached on loopback with an explicitly supplied Host header establishes local routing only. One generated hostname containing the official provider mirror's IPv4 `64.176.22.9` was resolved externally to exactly that IPv4 on 2026-11-08, without an HTTP/TLS request: this establishes the tested name's provider DNS resolution only. Neither establishes public HTTP access to the FullPanel server, public TLS, IPv6 support, offline local URLs, bounded diagnostics or ACME issuance/renewal.

The complete unit/API suite passes 135 tests, including six focused test-domain cases. The real `npm run test:test-domains` fixture passes API allocation through Traefik to two distinct Whoami containers on loopback, with unknown-host 404 and exact-owned cleanup. This is separate from the external DNS-only observation above.
