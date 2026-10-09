# Contributing to referenced-automation-sap

The shared rules (tests with negative controls, no hard waits, no secrets, ADRs, review checklist, deprecation policy) are in
[`referenced-automation-utils/docs/governance/CONTRIBUTING.md`](../referenced-automation-utils/docs/governance/CONTRIBUTING.md).
Release and upgrade steps: [`RELEASING.md`](../referenced-automation-utils/docs/governance/RELEASING.md). Decisions: [`docs/adr`](../referenced-automation-utils/docs/adr/README.md).

## Before you push
```bash
npm run lint && npm run typecheck && npm test && npm run security
```
The tests run against a simulator; try them with `npm run try:simulator`. If you change the PowerShell or Java bridge, say plainly in the merge request that it has **not** been run against a real SAP GUI unless it has.

Update `CHANGELOG.md`. This repo is in the chain `utils` -> `api`/`ui` -> `sap` -> `ui-api`: repackage after a change and re-test `ui-api`.
