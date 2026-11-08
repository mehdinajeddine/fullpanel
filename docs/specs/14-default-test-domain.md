# Default test URL and certificate state

Status: proposed requirement, **not implemented or verified** on 2026-11-08. Tracks R08 (default and primary domains), R07 (HTTPS) and R06 (routing). This supplements the current backlog; the approved DOCX and historical corpus remain dated snapshots.

## Current behavior and missing outcome

`server/app.ts` generates `<service>-<project>.<baseDomain>` for a new application only when an administrator has already configured `settings.baseDomain` and the create request omits domains. Templates can supply the correct target port. The resulting hostname is saved rather than silently rewritten when settings later change. Selecting a primary exact hostname controls Open. This does not provide a usable domain on an unconfigured installation and does not create DNS records.

`compose.yaml` defines a Traefik Let's Encrypt resolver using `ACME_EMAIL`, persistent certificate storage and the HTTP challenge on the web entrypoint. TLS labels select that resolver. The API's saved `letsEncryptEmail` setting does not currently reconfigure the deployed proxy. Existing tests establish HTTP routing and redirect responses, not public issuance, certificate trust or renewal.

The required outcome is that an operator can create an HTTP application and open its test URL **without buying a domain or manually creating DNS records**. The URL must identify the correct service and target port, survive panel restart, and make its actual reachability and certificate state clear.

## Address allocation and deployment modes

For a publicly reachable installation, select one explicit allocation strategy: an IP-encoding DNS service such as nip.io/sslip.io, or a FullPanel-controlled domain whose DNS is provisioned automatically. Neither strategy is implemented yet. The chosen provider and availability dependency must be documented. A provider change must preserve existing saved routes until an operator deliberately migrates them.

Surge can host a separately built static interface demonstration at a `surge.sh` name. Its documented publishing service serves static files, and its custom-domain setup directs traffic to Surge's infrastructure. Therefore it does not satisfy this requirement to route a generated test hostname to the user's Docker server or run the FullPanel API and workloads. This is an architectural choice inferred from [Surge's publishing model](https://surge.sh/) and [domain documentation](https://surge.sh/docs/platform/custom-domains); no Surge deployment or integration is implemented or claimed.

IP-based names require a validated server address. If automatic discovery is inconclusive, the administrator may supply the public address once; this is distinct from editing DNS. Do not derive it from arbitrary request Host or forwarded headers. Use a stable service identifier in generated names so collisions, renames and long project names cannot redirect another service's traffic. Validate DNS label lengths, IPv4/IPv6 encoding and ownership with the same project isolation rules as custom domains.

Public DNS resolution alone does not establish service reachability: NAT, ingress ports, the proxy, application port and application response must also work. Surface these checks separately. An installation restricted to loopback or a private LAN must instead show a clearly labeled local HTTP endpoint whose reachability is tested from the intended client. Do not present a localhost link as remotely reachable or rely on external DNS for the local-only verification fixture. A local HTTP success is not public HTTPS evidence.

Do not automatically expose database ports or infer an HTTP route for arbitrary Compose children. Initially, default test URLs cover single-container HTTP applications and templates with an explicit HTTP target port. Retain custom domains and an explicitly chosen primary domain. Deleting a service removes its route and any provider-owned record where applicable; allocation must not reuse an old identifier in a way that directs an old URL to a different service.

## HTTPS behavior and external dependencies

The nip.io/sslip.io operator documents names containing an IP address, including prefixes and IPv6 encoding. On the consultation date, sslip.io redirected to nip.io; these names must not be presented as independent redundant providers. Certificate issuance for an externally accessible hostname is a separate CA operation. [Provider documentation](https://nip.io/)

The bundled HTTP-01 strategy requires validation reachability on public port 80 and does not issue wildcard certificates. DNS-01 is a separate future integration requiring control of challenge records. Local-only service access does not satisfy the public HTTP challenge. [Let's Encrypt challenge documentation](https://letsencrypt.org/docs/challenge-types/)

The implementation must connect its effective ACME identity/configuration to the actual proxy, distinguish pending issuance from a certificate verified by a normal TLS client, and retain persistent account/certificate data across restarts. Failed resolution, blocked validation ports or CA failures must leave an actionable state with bounded retries. Do not represent a configured `https` field or a redirect response as an issued certificate. Do not test by disabling TLS verification or silently weakening a route configured to require HTTPS.

Provider and CA rate limits/availability remain external constraints; the product must not promise unlimited certificates or uninterrupted third-party DNS. Do not silently switch names or retry issuance without bounds. Certificate renewal must have its own recorded result; a first successful issue does not prove renewal.

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

All scenarios above are pending. Unit fixtures can establish allocation and state handling; only the named network/CA fixtures can establish public DNS, TLS issuance and renewal behavior.
