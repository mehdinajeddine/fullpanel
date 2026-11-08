# Contributing to Harborlight

Harborlight's code and visual identity are original. Functional analysis of reference products belongs in specifications with evidence and attribution. Do not copy proprietary implementations, bundle fragments, graphics, or brand assets.

1. Pick an acceptance criterion from `docs/FEATURE-PARITY.md`.
2. Explain the user-visible behavior and its limitations.
3. Implement the smallest complete workflow, including errors, authorization, persistence, and recovery where applicable.
4. Run type checks, focused tests, and the production build. Test Docker changes against disposable managed resources.
5. Update the feature matrix and verification record with what passed. A demo simulation is not evidence of a real deployment.

Use Node 24 LTS and `npm ci`. Keep dependency versions in `package-lock.json`. Never commit `.data`, `.env`, backups, credentials, or extracted reference binaries. The API contract and shared TypeScript types must stay consistent with the browser.

Pull requests should describe the problem, the resulting behavior, and meaningful verification. Security-sensitive changes should include failure and abuse cases. Apache-2.0 applies to contributions.
