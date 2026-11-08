# Private source credentials

Implemented independently for Harborlight. Evidence recorded on 2026-11-08. This specifies the implemented subset; it does not claim feature parity with every Easypanel source provider.

## Supported workflows

An operator saves the service source, then supplies a username and a write-only credential. Git sources accept an HTTPS repository and token. Image sources accept a registry username and password or access token. Updating an existing credential rotates it; deleting it revokes its use in future deployments. An in-progress service operation prevents credential changes through the same service lock.

Credentials belong to one service and one normalized repository. Git branch changes and image tag/digest changes within that repository retain the credential. Changing source type, registry, repository path, or service identity removes it. Deploy also validates the scope before executing any authentication command. Moving a credential between services is not supported.

The current subset excludes Git SSH keys, OAuth/GitHub App installations, private submodules, private Git LFS, private Dockerfile base images, private Compose images and remote Docker TLS/SSH contexts. Docker operations use the selected local Unix socket context. Private registry configuration is available only for image sources; Git and Dockerfile builds deliberately receive no registry credential.

## API and authorization

The module is registered by `registerSourceCredentials` with store, authorization and service-lock dependencies. The encrypted store contains `sourceCredentials[serviceId]`; the public `Service` and `Source` types never contain credentials. Service deletion also deletes its credential record. Project viewers may read status. Operators may update/revoke credentials for their authorized projects. The central access control and the module authorization callback both apply.

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/services/:id/source-credentials` | None | Metadata only |
| `PUT /api/services/:id/source-credentials/git` | `{ "username": "x-access-token", "token": "…" }` | Metadata only |
| `PUT /api/services/:id/source-credentials/registry` | `{ "username": "account", "password": "…" }` | Metadata only |
| `DELETE /api/services/:id/source-credentials/git` | None | Metadata only |
| `DELETE /api/services/:id/source-credentials/registry` | None | Metadata only |

The body cannot select an arbitrary scope: repository/registry come from the already-saved service source. Bodies reject unknown fields. Credentials must be nonempty single-line strings, at most 16,000 characters; username has an explicit account-name character allowlist. Neither PUT nor GET returns the secret, including immediately after creation.

Example metadata response:

```json
{
  "git": { "configured": false },
  "registry": {
    "configured": true,
    "registry": "ghcr.io",
    "imageRepository": "ghcr.io/team/application",
    "username": "account",
    "updatedAt": "2026-11-08T12:00:00.000Z"
  },
  "capabilities": { "gitHttps": true, "registryImages": true, "registryBuilds": false }
}
```

## Git execution boundary

`withGitSourceCredentials` normalizes an HTTPS URL, rejects embedded authentication, query strings and fragments, and checks exact normalized origin and repository path. It creates a temporary directory with mode `0700`, an askpass program with mode `0700`, and an empty Git template directory. The program contains no credential. Its username/token arrive only through that Git child process's environment.

The askpass program matches both origin and full repository path in Git's prompt before answering. Git receives `credential.useHttpPath=true` and an empty credential helper, ignores global/system config, disables terminal prompting, disables hooks, allows only HTTPS and requires TLS verification. HTTP redirects are disabled, including same-host redirects. Ambient Git configuration/tracing variables are removed. The transient clone URL contains the username but no token; the cloned origin is then reset to the credential-free saved URL. The helper directory is removed in `finally`, before the build begins. Git credentials are never included in Docker build arguments, environment or context files.

These choices follow Git's documented credential lookup and path matching, and its redirect controls. See [Git credential configuration](https://git-scm.com/docs/gitcredentials) and [Git HTTP configuration](https://git-scm.com/docs/git-config).

Private clone output is not streamed. Error text is redacted before reaching the deployment queue; the queue also redacts raw, URI-encoded and Basic-auth base64 forms across output chunks. This covers the handled command/output paths, not arbitrary transformations a hostile third-party program could invent. Server-process and host administrators remain trusted: they can inspect process memory or child environments.

## Docker execution boundary

Registry parsing normalizes Docker Hub aliases and implicit `library/`, validates host/port and repository components, and ignores tag/digest only for credential scope. The deployment still uses the requested full image reference. IPv6 registry literals are not supported by this parser.

`withDockerSourceCredentials` creates a `0700` temporary directory and `0600` Docker configuration. It resolves the selected local context to an explicit `DOCKER_HOST=unix://…`, then removes context overrides and ambient Docker authentication variables. Login uses `--password-stdin`; the secret is absent from arguments and streamed output. Pull runs with this same isolated configuration. Cleanup removes the whole directory on success or failure.

The initial configuration has a nonempty auth map and no credential-helper settings. Docker CLI's automatic native helper detection occurs only when its config has no authentication information; the nonempty map prevents accidental reads/writes to the host keychain. Public pulls, builds and Compose deployment use the same isolated mechanism with no credential. See [Docker login documentation](https://docs.docker.com/reference/cli/docker/login/), [Docker CLI config loading](https://github.com/docker/cli/blob/master/cli/config/config.go) and [Docker CLI auth detection](https://github.com/docker/cli/blob/master/cli/config/configfile/file.go). Docker's temporary config may contain base64 authentication after login; base64 is not encryption, hence its permissions and guaranteed ordinary-exit cleanup matter.

Buildx and Compose discovery retains the original Docker config directory's `cli-plugins` path and valid absolute `cliPluginsExtraDirs`. Only these path settings are copied. Host auths, credential stores/helpers, headers and proxies are not copied. This also supports local desktop Docker installations whose plugins are linked under the user's config directory.

The backend supplies a private credential snapshot through `DeployOptions.sourceCredentials`. Private pull output is suppressed until success, and failures are redacted. Authentication and pull happen before replacing the previous container. A failed login or pull preserves the running instance. Revocation does not stop an already-running workload; a later deploy attempts a fresh pull even when that image is cached locally.

This is application-level credential scoping. It does not make a broad provider token narrower at the provider. Use a read-only token scoped to the intended repository where the provider supports it. The host's registry/daemon transport configuration still applies; Harborlight does not disable TLS verification or configure insecure registries. The integration fixture uses Docker's localhost registry exception only.

## Verification and limitations

`node --import tsx --test server/source-credentials.test.ts` passed 10 tests on 2026-11-08. They cover scope normalization, source-change pruning, write-only routes and roles, actual Git credential filling through the askpass executable, refusal of another host/path, temporary file modes/removal, Docker login arguments/stdin, native-helper suppression, plugin discovery without copying ambient secrets, redaction and cleanup after failures. No remote service is required for these module tests.

`node --import tsx scripts/smoke-credentials.ts` passed on the local Docker daemon on 2026-11-08. A uniquely named `registry:2` container used bcrypt htpasswd authentication and a generated temporary password. The test pushed a tagged `nginx:1.28-alpine`, removed that local tag, proved anonymous pull fails, deployed with the credential and checked actual application HTTP. Wrong password, absent/revoked credential and a different repository were rejected while preserving the same running container ID. Deployment output contained none of the tested secret forms. The script also verified an actual public GitHub HTTPS `ls-remote` with TLS verification and redirects disabled. Only its UUID-owned test resources and temporary files were cleaned up.

`node --import tsx scripts/smoke-git.ts` also passed on 2026-11-08 using the real API, encrypted store and Docker driver. It cloned Docker's official [awesome-compose repository](https://github.com/docker/awesome-compose/tree/30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562/nginx-golang/backend), branch `master`, commit `30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562`, and built its `nginx-golang/backend` context from the original Dockerfile on arm64. The resulting Go application served its expected HTTP response. Remote HEAD, `Deployment.commit`, deployment output and the image's `org.opencontainers.image.revision` label matched. A second deploy with `forceRebuild: true` executed both Go dependency and compile RUN instructions (BuildKit `DONE`, not `CACHED`), replaced the container and served HTTP again. Both commit records survived encrypted-store reopen. Temporary clone workdirs were empty and the test cleaned its exact service images, containers, client and project network. The test follows the public branch at run time, so subsequent successful runs may record a newer commit.

This is not an integration test against a private hosted Git provider or every registry implementation. The real Git askpass test verifies Git's credential protocol without a remote provider; the public HTTPS check verifies transport and configuration. Exact-path HTTPS providers that redirect repository URLs may require users to save their final canonical URL. The fixture does not establish private build-base support, private Compose support, remote Docker support, or automatic token expiry/refresh. An abrupt host or process crash can leave a temporary credential file until the operating system's temporary-file cleanup; ordinary success/error paths remove it. No claim of immediate memory erasure is made.

API integration tests in `server/tests/access.test.ts` additionally exercise project isolation, viewer write refusal, encrypted persistence, private driver options, credential redaction across split output, source-change pruning and service-scoped authorization. Run the full suite for the current combined feature state.
