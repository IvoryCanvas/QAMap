# CodeWard Configuration

CodeWard reads `codeward.config.json` or `.codeward.json` from the scanned repository root.

Create a starter config:

```sh
codeward init .
```

Use an explicit config path:

```sh
codeward scan . --config ./codeward.config.json
```

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/IvoryCanvas/codeward/main/schema/codeward.schema.json",
  "failOn": "high",
  "ignoreRules": ["CW011"],
  "maxFiles": 2000,
  "validationCommands": ["make test", "make lint"],
  "severity": {
    "CW007": "info"
  }
}
```

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `failOn` | `info` `low` `medium` `high` | Exits with code `1` when findings at this severity or higher are present. CLI `--fail-on` takes precedence. |
| `ignoreRules` | `string[]` | Suppresses rule ids for this repository. |
| `maxFiles` | `number` | Maximum number of files CodeWard inspects. CLI `--max-files` takes precedence. |
| `severity` | `Record<string, Severity>` | Overrides severity for specific rule ids. |
| `validationCommands` | `string[]` | Adds project-specific validation commands to `test-plan`, `eval`, `verify`, and GitHub Action reports. |

## Notes

- Prefer severity overrides over ignores when a finding is still useful but too noisy for CI.
- Keep ignores small and documented in pull requests.
- Use `validationCommands` for custom stacks, Makefile-based projects, or monorepos where the right validation command is not discoverable from standard project files.
- CodeWard does not execute scanned project code while reading config.

## Local History

CodeWard separates shared project policy from generated local history.

Commit-friendly files:

- `codeward.config.json`
- `.codeward/flows.yml` when a project chooses to define durable core flows
- `.codeward/domains.yml` when a project chooses to define durable domain mappings

Ignored local artifacts:

- `.codeward/runs/`
- `.codeward/cache/`
- `.codeward/tmp/`
- `.codeward/*.local.json`

Run this once to create the local directories and add those ignore patterns idempotently:

```sh
codeward history init .
```

Use `--record-history` when an analysis should leave a compact local snapshot for comparison or debugging:

```sh
codeward e2e plan . --base origin/main --head HEAD --record-history
```

## Domain Manifest

Create a starter domain manifest:

```sh
codeward domains init .
codeward domains suggest . --base origin/main --head HEAD
```

`.codeward/domains.yml` is meant to be committed when the team wants CodeWard to use shared product language during E2E planning.

```yaml
domains:
  - id: billing
    name: Billing
    aliases:
      - checkout
      - subscription
    files:
      - src/features/billing/**
    routes:
      - /billing
    tags:
      - payment
    scenarios:
      - title: Billing primary journey
        checks:
          - Start from the normal billing entry point.
          - Complete the primary billing action with realistic data.
          - Confirm the visible result or saved state.
```

Supported domain fields:

| Field | Description |
| --- | --- |
| `id` | Stable machine-readable id for the domain. |
| `name` | Human-facing product term used in E2E plan language. |
| `aliases` | Extra words that can match changed file path segments. |
| `files` | Glob-like path patterns relative to the repository or workspace root. |
| `routes` | Route hints used for matching and Playwright draft entrypoints. |
| `tags` | Additional tokens that can match file path segments. |
| `scenarios` | Optional suggested scenario names and checks for generated drafts. |

Use `.codeward/domains.yml` for naming and route hints. Use `.codeward/flows.yml` when the team wants to define a higher-confidence verification journey with priority and required checks.

## Core Flows

Create a starter core flow manifest:

```sh
codeward flows init .
codeward flows suggest . --base origin/main --head HEAD
```

`.codeward/flows.yml` is meant to be committed when the team wants CodeWard to understand project-specific flows during E2E planning.

```yaml
flows:
  - id: checkout-purchase
    name: Checkout purchase
    priority: critical
    domains:
      - checkout
    files:
      - src/pages/checkout/**
      - src/features/checkout/**
    routes:
      - /checkout
    tags:
      - payment
    checks:
      - Complete checkout with a valid payment method.
      - Verify declined payment recovery.
```

Supported match fields:

| Field | Description |
| --- | --- |
| `files` | Glob-like path patterns relative to the repository or workspace root. |
| `domains` | Domain tokens matched against changed file path segments. |
| `routes` | Route-like strings matched against changed file paths. |
| `tags` | Additional tokens that can match file path segments. |
| `checks` | Human-approved verification points shown in the E2E plan. |

`priority` can be `critical`, `recommended`, or `optional`.

## Domain Language Suggestions

`codeward e2e plan` includes a bootstrap section and a domain language section before the lower-level E2E candidates. The bootstrap section separates required setup, recommended policy capture, and ready evidence, which is especially useful when a project has no existing tests yet. CodeWard derives domain language suggestions from:

- team-approved `.codeward/flows.yml` names
- shared `.codeward/domains.yml` names, aliases, routes, and scenarios
- changed file path terms such as `features/in-app-purchase`
- selected UI copy such as accessibility labels, placeholders, and text labels

The goal is to help reviewers and test authors use the product words the team already understands. For example, a service or component path can become `In App Purchase primary journey` instead of a generic implementation phrase such as "API smoke flow".

High-confidence terms usually come from committed core flows or domain manifests. Medium-confidence terms usually come from changed paths. Low-confidence terms can come from UI copy and should be treated as naming hints, not final policy.

## Fixture And Mock Readiness

`codeward e2e plan` checks whether a candidate flow appears to depend on API, network, payment, or external response data. When it does, CodeWard looks for changed backend/API evidence and mock or fixture evidence such as:

- MSW or Mirage handlers
- `__mocks__`, `fixtures`, `factories`, `seeds`, or `test-data` directories
- Playwright route fulfillment helpers
- mock data files that match the changed domain

If a client flow calls an API but the branch does not include backend, mock, or fixture evidence, the E2E plan marks fixture readiness as `missing` and the generated draft includes next actions for deterministic success and failure responses. This lets teams validate UI and flow behavior before the real server implementation is complete.
