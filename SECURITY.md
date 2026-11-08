# Security model

Harborlight is an administrator control plane. Access to the Docker socket gives the panel authority comparable to root on the Docker host. Run it on a host dedicated to workloads you trust. Owners, administrators and project operators can deploy arbitrary application code; project permissions and application builds are not a sandbox for untrusted tenants.

## Exposure

The default Compose configuration binds the panel to `127.0.0.1`. Complete first-owner setup through localhost or an SSH tunnel before enabling the public HTTPS override. Set `PUBLIC_URL` to the exact HTTPS origin and use secure cookies for public deployment. Keep the Docker API socket private; a read-only socket mount does not make Docker API requests read-only.

The service API requires authentication. Cookies are HttpOnly and SameSite strict; mutation requests from untrusted origins are rejected. Login is rate limited. Credentials are hashed using scrypt. Persisted panel state is encrypted with AES-256-GCM and stored with restrictive filesystem permissions. The local encryption key protects against accidentally exposing the state file; it does not protect against a compromised host with access to both files.

## Accounts and credentials

The owner account is protected from deletion and privilege removal. Administrators manage all projects and accounts. Members receive explicit viewer or operator access to projects. Cross-project reads return 404; restricted operations return 403. Inventories omit environment values even for administrators; operators can deliberately open service details to access configuration. Viewer responses also omit inline build sources, notes, deployment output and runtime error details.

API keys are stored as hashes, expire after a chosen period, and are bounded by both their selected projects and the issuing account's current privileges. They do not authorize account, authentication, server-setting or key-management operations. Password resets, account changes that affect privileges, disabling an account and deleting it revoke sessions, API keys and deployment triggers issued by that account. Use HTTPS when transmitting credentials and pass API tokens in the Authorization header, never query strings.

Private source credentials live only in encrypted state. They are scoped to a service and exact Git repository or image repository; changing that scope removes the saved credential. Git uses an ephemeral askpass program and isolated configuration, verifies TLS and refuses redirects. Registry login uses stdin and a temporary private Docker configuration. Credentials are removed before repository builds execute. Private registry authentication currently applies to image pulls, not private Dockerfile base images or Compose images. Deployments currently require a local Docker Unix socket context.

Proxy passwords use bcrypt and are never returned after saving. Their hashes necessarily appear in Docker labels used by Traefik and remain visible to Docker administrators. Successful Basic authentication removes the Authorization header before forwarding to the app. Save then deploy to activate a proxy password change. Wildcard TLS needs DNS certificate validation and is not supported by the bundled HTTP-challenge configuration; exact-host HTTPS remains available.

## Workloads and recovery

The runtime scopes its operations to Harborlight-owned resources. It does not initialize or leave a Docker Swarm. Database ports are private unless an operator explicitly publishes them. Review image provenance, repository code, volume mounts, and exposed ports before deploying.

Domain namespaces are reserved by project: another project cannot claim the same hostname with a different path, or an overlapping wildcard. The configured panel hostname is reserved for the control plane. Applications with public domains share the proxy Docker network; HTTP authentication protects requests arriving through Traefik, not direct connections from workloads on that network. Do not treat this shared-host topology as hostile-tenant network isolation.

Local backups remain on the same server and are not disaster recovery. Copy verified backups off-host and rehearse recovery. Backup files contain application data and are not encrypted by the panel-state encryption mechanism. Protect backup downloads and the host data directory accordingly.

## Reporting

Do not post live credentials, exploit-ready details, or private application data in public issues. Use the repository's private vulnerability reporting facility when available. This early development release has not undergone an independent penetration test or production hardening review.
