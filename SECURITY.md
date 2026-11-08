# Security model

Harborlight is an administrator control plane. Access to the Docker socket gives the panel authority comparable to root on the Docker host. Run it on a host dedicated to workloads you trust. The owner account can deploy arbitrary application code; application builds are not a sandbox for untrusted tenants.

## Exposure

The default Compose configuration binds the panel to `127.0.0.1`. Complete first-owner setup through localhost or an SSH tunnel before enabling the public HTTPS override. Set `PUBLIC_URL` to the exact HTTPS origin and use secure cookies for public deployment. Keep the Docker API socket private; a read-only socket mount does not make Docker API requests read-only.

The service API requires authentication. Cookies are HttpOnly and SameSite strict; mutation requests from untrusted origins are rejected. Login is rate limited. Credentials are hashed using scrypt. Persisted panel state is encrypted with AES-256-GCM and stored with restrictive filesystem permissions. The local encryption key protects against accidentally exposing the state file; it does not protect against a compromised host with access to both files.

## Workloads and recovery

The runtime scopes its operations to Harborlight-owned resources. It does not initialize or leave a Docker Swarm. Database ports are private unless the owner explicitly publishes them. Review image provenance, repository code, volume mounts, and exposed ports before deploying.

Local backups remain on the same server and are not disaster recovery. Copy verified backups off-host and rehearse recovery. Backup files contain application data and are not encrypted by the panel-state encryption mechanism. Protect backup downloads and the host data directory accordingly.

## Reporting

Do not post live credentials, exploit-ready details, or private application data in public issues. Use the repository's private vulnerability reporting facility when available. This early development release has not undergone an independent penetration test or production hardening review.
