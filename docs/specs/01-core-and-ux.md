# Core product and interaction specification

These are original Harborlight requirements. References and scope are recorded in [the analysis](../REFERENCE-ANALYSIS.md) and [parity ledger](../FEATURE-PARITY.md).

## Product objective

An operator should be able to create a project, deploy an application and its data service, inspect the outcome, and maintain the workload without memorizing Docker commands. Harborlight uses its own terminology, layout, components and REST contract. Retain the useful progression from project to service configuration to deployment and operation.

The first release must be useful with real Docker. A demo adapter is acceptable for isolated evaluation only when the page visibly identifies the mode. A backend disconnection, missing Docker socket or failed job must never be converted into a successful simulated result.

## Information architecture

- The workspace overview summarizes actual projects, workload states, recent actions and current system health.
- A project contains its own services and shared settings. Internal service names and navigation should remain stable across display-name edits.
- A service view keeps its identity, state and main lifecycle actions visible while the operator changes Source, Environment, Domains, Storage, Resources, Deployments or Logs.
- Templates start the same service-creation journey as manual configuration; their defaults remain editable.
- Server settings distinguish host-wide configuration from project and service settings.

Use direct URLs for important screens. Refresh, browser back and a copied service link must not reset selection to the dashboard. A search control should navigate to real projects and services. Empty screens should offer a relevant creation action, without invented sample statistics in live mode.

## Visual and accessibility contract

Use an original visual system with deliberate hierarchy, clear spacing, restrained color and distinctive typography. State must be conveyed through text as well as color. Dense operational data should stay readable on a laptop. Mobile layouts should preserve access to critical actions without horizontal page overflow.

Forms need visible labels, field-specific errors and stable values after failed saves. Destructive actions must identify their target. Dialogs trap focus, support Escape when idle, restore focus to the trigger and provide accessible names. All actions must work from a keyboard. Reduced-motion preference disables decorative transitions.

Long operations show pending state immediately and remain inspectable after navigation. Success appears only after the corresponding operation succeeds. A disabled control explains the missing prerequisite. Unsupported features belong in the roadmap rather than a clickable action that returns fabricated success.

## State and authentication

The first administrator bootstrap is single-use and race-safe. Passwords use a password-specific hash with independent salts. Sessions are server-validated, expire and become unusable on logout. Cookie sessions use HttpOnly and appropriate SameSite/Secure settings for the deployment. State-changing browser requests enforce an origin/CSRF boundary. Login endpoints have request-size and attempt limits.

Persist configuration atomically. Separate identifiers from user-facing names. Do not derive filesystem paths directly from arbitrary names. Each API mutation validates input, applies authorization, performs the mutation, and records bounded nonsecret activity. Unknown objects return clear errors rather than a successful empty result.

Secrets must not appear in list responses, activity descriptions, exception traces or Git. A reveal action may return the selected secret to an authenticated administrator. Exporting configuration must clearly state whether secrets are included. Data directory ownership and permissions are part of deployment setup.

## Acceptance scenarios

1. Start with an empty state directory. Create an administrator, reload, sign out, then verify that protected API requests fail.
2. Create two projects with similarly named services. Search and open each, reload the direct URL, and verify the selected resource is unambiguous.
3. Save invalid form input and confirm the error identifies the field without losing other entered values.
4. Stop Docker or supply an unavailable socket. The dashboard reports unavailability and deployment fails visibly; no success record is added.
5. Delete an empty project and a service with persistent storage. Confirm the exact data retention policy before either destructive path runs.
6. Complete the creation and service-inspection flow with keyboard-only input and at a narrow viewport.
