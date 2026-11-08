# Private source credentials

Implemented independently for FullPanel. Evidence recorded on 2026-11-08. This specifies the implemented subset; it does not claim feature parity with every Easypanel source provider.

## Supported workflows

An operator saves the service source, then supplies a username and a write-only credential. Git sources accept an HTTPS repository and token. Image sources accept a registry username and password or access token. Updating an existing credential rotates it; deleting it revokes its use in future deployments. An in-progress service operation prevents credential changes through the same service lock.

For an SSH Git source, the operator generates a new Ed25519 key, copies only its public key into the repository provider as a read-only deploy key, and saves independently verified SSH server public keys. The native OpenSSH private key is generated on the server, encrypted in private state and never returned by the API. Rotation creates a new key while preserving the exact saved host pins; the provider must authorize the new public key before it can deploy. Deleting the local credential prevents future use by FullPanel but does not remove the provider's deploy-key record. GitHub documents repository-specific, read-only-by-default deploy keys and the need to manage their lifetime separately. [GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)

Credentials belong to one service and one normalized repository. Git branch changes and image tag/digest changes within that repository retain the credential. Changing source type, registry, repository path, or service identity removes it. Deploy also validates the scope before executing any authentication command. Moving a credential between services is not supported.

The current subset excludes imported SSH private keys, encrypted private-key passphrases, SSH agents/certificates/jump hosts, OAuth/GitHub App installations, private submodules, private Git LFS, private Dockerfile base images, private Compose images and remote Docker TLS/SSH contexts. Docker operations use the selected local Unix socket context. Private registry configuration is available only for image sources; Git and Dockerfile builds deliberately receive no registry credential.

## API and authorization

The module is registered by `registerSourceCredentials` with store, authorization and service-lock dependencies. The encrypted store contains `sourceCredentials[serviceId]`; the public `Service` and `Source` types never contain credentials. Service deletion also deletes its credential record. Source-credential status and writes require operator access in the service's project; viewers are refused. The central access control and the module authorization callback both apply. Asynchronous key generation and host-key validation recheck permissions, busy state, saved repository and credential revision before committing, so a competing change invalidates the write.

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/services/:id/source-credentials` | None | Metadata only |
| `PUT /api/services/:id/source-credentials/git` | `{ "username": "x-access-token", "token": "…" }` | Metadata only |
| `POST /api/services/:id/source-credentials/ssh/rotate` | `{}` | Public key, fingerprint and host-trust metadata; never the private key |
| `PUT /api/services/:id/source-credentials/ssh/host-key` | `{ "knownHosts": "host ssh-ed25519 …" }` | Public host keys and fingerprints |
| `PUT /api/services/:id/source-credentials/registry` | `{ "username": "account", "password": "…" }` | Metadata only |
| `DELETE /api/services/:id/source-credentials/git` | None | Metadata only |
| `DELETE /api/services/:id/source-credentials/ssh` | None | Metadata only |
| `DELETE /api/services/:id/source-credentials/registry` | None | Metadata only |

The body cannot select an arbitrary scope: repository/registry come from the already-saved service source. Bodies reject unknown fields. Credentials must be nonempty single-line strings, at most 16,000 characters; username has an explicit account-name character allowlist. Neither PUT nor GET returns the secret, including immediately after creation.

Example metadata response:

```json
{
  "git": { "configured": false },
  "ssh": { "configured": false },
  "registry": {
    "configured": true,
    "registry": "ghcr.io",
    "imageRepository": "ghcr.io/team/application",
    "username": "account",
    "updatedAt": "2026-11-08T12:00:00.000Z"
  },
  "capabilities": { "gitHttps": true, "gitSsh": true, "registryImages": true, "registryBuilds": false }
}
```

## HTTPS Git execution boundary

`withGitSourceCredentials` normalizes an HTTPS URL, rejects embedded authentication, query strings and fragments, and checks exact normalized origin and repository path. It creates a temporary directory with mode `0700`, an askpass program with mode `0700`, and an empty Git template directory. The program contains no credential. Its username/token arrive only through that Git child process's environment.

The askpass program matches both origin and full repository path in Git's prompt before answering. Git receives `credential.useHttpPath=true` and an empty credential helper, ignores global/system config, disables terminal prompting, disables hooks, allows only HTTPS and requires TLS verification. HTTP redirects are disabled, including same-host redirects. Ambient Git configuration/tracing variables are removed. The transient clone URL contains the username but no token; the cloned origin is then reset to the credential-free saved URL. The helper directory is removed in `finally`, before the build begins. Git credentials are never included in Docker build arguments, environment or context files.

These choices follow Git's documented credential lookup and path matching, and its redirect controls. See [Git credential configuration](https://git-scm.com/docs/gitcredentials) and [Git HTTP configuration](https://git-scm.com/docs/git-config).

Private clone output is not streamed. Error text is redacted before reaching the deployment queue; the queue also redacts raw, URI-encoded and Basic-auth base64 forms across output chunks. This covers the handled command/output paths, not arbitrary transformations a hostile third-party program could invent. Server-process and host administrators remain trusted: they can inspect process memory or child environments.

## SSH Git execution boundary

The supported forms are `user@host:owner/repository.git` and `ssh://user@host[:port]/path`. Scope includes the canonical host, port, user and exact repository path. Relative scp-style paths and absolute URI paths remain distinct. Whitespace, shell metacharacters, traversal, URL escaping, queries and fragments are refused. A branch change retains the key; changing the scoped source removes it. The wrapper accepts only the exact upload-pack request for this saved source and launches OpenSSH with an argument array, without shell interpolation.

Trust uses explicit exact-host entries, including `[host]:port` for non-default ports. Wildcards, aliases, hashed hostnames and CA markers are outside this subset. Accepted public-key types are Ed25519, ECDSA and RSA of at least 2048 bits; validation records SHA-256 fingerprints. The server never adopts `ssh-keyscan` output automatically: an unverified scan does not authenticate the server. Use the provider's published keys or an independent administrative channel. [OpenSSH key scanning](https://man.openbsd.org/ssh-keyscan), [GitHub published host keys](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)

Git receives a dedicated executable through `GIT_SSH` and explicit `GIT_SSH_VARIANT=ssh`. The environment removes ambient Git/SSH overrides and agent/askpass variables; a private HOME, empty templates, disabled hooks/helpers and protocol allowlist prevent fallback configuration. OpenSSH ignores user/system config, uses only the generated identity and pinned known_hosts, disables agents/certificates/password prompts/proxies/forwarding/multiplexing and requires strict host verification. `GIT_SSH_COMMAND`, which Git interprets through a shell, is not used. [Git environment variables](https://git-scm.com/docs/git), [OpenSSH client configuration](https://man.openbsd.org/ssh_config)

Product key generation and deployment use `dataDir/ssh-credentials`, with mode `0700` directories and `0600` identity files. After acquiring the state writer lock, startup removes only `key-UUID`/`git-UUID` staging directories; symlink roots and managed symlink entries fail closed, and unknown entries remain untouched. A hard-killed panel may leave a plaintext staging key until this restart cleanup; this is not a claim of instantaneous erasure. The helper's ordinary exit path cleans up before Docker build. Public host-key validation and the short Unix control socket use separate temporary locations containing no private key.

The helper supervises its SSH child through a private control channel, with bounded termination escalation and acknowledgement after the child closes. Tests cover a timed-out Git process and panel SIGKILL while the SSH child ignores SIGTERM. The wrapper owns and bridges the Git-facing pipes, so killing the wrapper itself cannot leave the Git job waiting on descriptors inherited by SSH. An unacknowledged control-channel loss fails the job and removes staging keys before any build. This last case does **not** confirm termination of a potentially orphaned SSH process; production does not kill an unverified host PID. See the current [verification record](../VERIFICATION.md) for the final tested scope.

## Docker execution boundary

Registry parsing normalizes Docker Hub aliases and implicit `library/`, validates host/port and repository components, and ignores tag/digest only for credential scope. The deployment still uses the requested full image reference. IPv6 registry literals are not supported by this parser.

`withDockerSourceCredentials` creates a `0700` temporary directory and `0600` Docker configuration. It resolves the selected local context to an explicit `DOCKER_HOST=unix://…`, then removes context overrides and ambient Docker authentication variables. Login uses `--password-stdin`; the secret is absent from arguments and streamed output. Pull runs with this same isolated configuration. Cleanup removes the whole directory on success or failure.

The initial configuration has a nonempty auth map and no credential-helper settings. Docker CLI's automatic native helper detection occurs only when its config has no authentication information; the nonempty map prevents accidental reads/writes to the host keychain. Public pulls, builds and Compose deployment use the same isolated mechanism with no credential. See [Docker login documentation](https://docs.docker.com/reference/cli/docker/login/), [Docker CLI config loading](https://github.com/docker/cli/blob/master/cli/config/config.go) and [Docker CLI auth detection](https://github.com/docker/cli/blob/master/cli/config/configfile/file.go). Docker's temporary config may contain base64 authentication after login; base64 is not encryption, hence its permissions and guaranteed ordinary-exit cleanup matter.

Buildx and Compose discovery retains the original Docker config directory's `cli-plugins` path and valid absolute `cliPluginsExtraDirs`. Only these path settings are copied. Host auths, credential stores/helpers, headers and proxies are not copied. This also supports local desktop Docker installations whose plugins are linked under the user's config directory.

The backend supplies a private credential snapshot through `DeployOptions.sourceCredentials`. Private pull output is suppressed until success, and failures are redacted. Authentication and pull happen before replacing the previous container. A failed login or pull preserves the running instance. Revocation does not stop an already-running workload; a later deploy attempts a fresh pull even when that image is cached locally.

This is application-level credential scoping. It does not make a broad provider token narrower at the provider. Use a read-only token scoped to the intended repository where the provider supports it. The host's registry/daemon transport configuration still applies; FullPanel does not disable TLS verification or configure insecure registries. The integration fixture uses Docker's localhost registry exception only.

## Verification and limitations

`node --import tsx --test server/source-credentials.test.ts` passed 10 tests on 2026-11-08. They cover scope normalization, source-change pruning, write-only routes and roles, actual Git credential filling through the askpass executable, refusal of another host/path, temporary file modes/removal, Docker login arguments/stdin, native-helper suppression, plugin discovery without copying ambient secrets, redaction and cleanup after failures. No remote service is required for these module tests.

`node --import tsx scripts/smoke-credentials.ts` passed on the local Docker daemon on 2026-11-08. A uniquely named `registry:2` container used bcrypt htpasswd authentication and a generated temporary password. The test pushed a tagged `nginx:1.28-alpine`, removed that local tag, proved anonymous pull fails, deployed with the credential and checked actual application HTTP. Wrong password, absent/revoked credential and a different repository were rejected while preserving the same running container ID. Deployment output contained none of the tested secret forms. The script also verified an actual public GitHub HTTPS `ls-remote` with TLS verification and redirects disabled. Only its UUID-owned test resources and temporary files were cleaned up.

`node --import tsx scripts/smoke-git.ts` also passed on 2026-11-08 using the real API, encrypted store and Docker driver. It cloned Docker's official [awesome-compose repository](https://github.com/docker/awesome-compose/tree/30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562/nginx-golang/backend), branch `master`, commit `30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562`, and built its `nginx-golang/backend` context from the original Dockerfile on arm64. The resulting Go application served its expected HTTP response. Remote HEAD, `Deployment.commit`, deployment output and the image's `org.opencontainers.image.revision` label matched. A second deploy with `forceRebuild: true` executed both Go dependency and compile RUN instructions (BuildKit `DONE`, not `CACHED`), replaced the container and served HTTP again. Both commit records survived encrypted-store reopen. Temporary clone workdirs were empty and the test cleaned its exact service images, containers, client and project network. The test follows the public branch at run time, so subsequent successful runs may record a newer commit.

The HTTPS fixtures do not exercise a private hosted Git provider or every registry implementation. The real Git askpass test verifies Git's credential protocol without a remote provider; the public HTTPS check verifies transport and configuration. Exact-path HTTPS providers that redirect repository URLs may require users to save their final canonical URL. The fixture does not establish private build-base support, private Compose support, remote Docker support, or automatic token expiry/refresh. An abrupt host or process crash can still leave an isolated Docker auth file until the operating system's temporary-file cleanup; ordinary success/error paths remove it. SSH staging uses the restart cleanup described above. No claim of immediate memory erasure is made.

`npm run test:git-ssh` passed against a disposable local OpenSSH server on 2026-11-08. The real API generates a repository key, saves the pinned host identity, reopens encrypted state, clones a private repository, builds its Nginx application and verifies HTTP plus matching commit/OCI revision. Wrong host pins, provider-side key removal and unregistered rotation preserve the exact running container; registering the new public key permits deployment. The fixture also checks ambient-command/agent isolation, scope mismatch, temporary-file removal, source-change revocation and absence of key material from output and the built context. This is a private SSH-server fixture, not a live private GitHub/GitLab account test. The final real rerun after the helper lifecycle fixes checked commit `640af5bf2ac4b9bf27bdf6ede40c701b7f14ae20`; the complete evidence is recorded in VERIFICATION.md.

An independent run of `node --import tsx --test server/git-ssh.test.ts server/tests/ssh-access.test.ts` passed **14 tests** after the helper lifecycle fixes. These use real local Git/OpenSSH tooling and controlled fake SSH processes for failure injection; they do not require Docker or a remote SSH server. They cover exact source/trust validation, generated keys, private-file modes, inherited configuration removal, redaction, authorization/rotation races, encrypted restart, bounded timeout with an uncooperative SSH child, panel SIGKILL before/during the wrapper, restart cleanup with symlink boundaries, and rapid failed-job/key cleanup after wrapper SIGKILL.

API integration tests in `server/tests/access.test.ts` additionally exercise project isolation, viewer write refusal, encrypted persistence, private driver options, credential redaction across split output, source-change pruning and service-scoped authorization. Run the full suite for the current combined feature state.
