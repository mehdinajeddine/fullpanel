# Project environment and applied configuration

Project environment values are private defaults for services in that project. They are available only to operators and administrators. Project inventories never include them, and viewers cannot read either inherited or effective values.

## Precedence and application

For an ordinary service, a service value overrides the project value with the same name. An explicit empty string is an override. Removing the service entry restores inheritance. For Compose children the order is service overrides, then the child's YAML environment, then project defaults. Values are literal: the panel does not expand `$NAME`, `${NAME}`, or shell expressions.

Saving a project environment does not restart or redeploy workloads. Only services whose effective configuration changes receive an unapplied-change timestamp. Deploy captures an immutable private applied-service snapshot, including its effective environment. Backups, runtime actions and log redaction use that applied snapshot while configuration edits await deployment. Old applied secrets remain redacted after a new project value is saved.

Project variables are passed as workload configuration. Variables such as `DOCKER_HOST` must never configure the panel's own Docker transport. Concurrent service operations or unresolved restore reconciliation prevent project environment changes with HTTP 409.

## Editing and import

The editor masks values by default. Service editors show inherited entries separately, with explicit override and remove-override actions. The `.env` import runs locally: paste, preview, choose merge or replace, apply to the draft, then explicitly save. Importing or closing the preview performs no API mutation.

The parser accepts blank lines, `#` comments, optional `export`, unquoted values, and single-line quoted values. Inline unquoted comments require whitespace before `#`. Double-quoted values support escaped quotes, backslashes, dollars and tabs. Imports with any malformed line or duplicate name cannot be applied. Errors identify the line without echoing its secret value.

Limits: 200 variables, 16,000 characters per value and 262,144 characters per imported text. Names use letters, digits and underscores and cannot start with a digit. `__proto__` and `constructor` are reserved by the JSON API and rejected consistently in the editor, importer and schema. Multiline values, escaped newlines and null bytes are unsupported; encode multiline secrets before use.

## API

- GET/PUT `/api/projects/:id/environment`; PUT accepts `{env: Record<string,string>}`, both return `{env}`.
- GET `/api/services/:id/environment` returns `{inherited, overrides, effective}`.
- Service-local values remain part of the ordinary service edit endpoint. Inheritance does not copy them into the stored local map.

## Evidence

The parser and authorization/state tests live in `server/tests/environment.test.ts` and `server/tests/restore.test.ts`. `scripts/smoke-environment.ts` tests real Docker and Compose precedence, explicit empty values, literal syntax, project isolation, save-versus-deploy behavior and old-secret redaction. The browser workflow covers invalid import, masked preview, the draft/save boundary and adding/removing a service override.
