# QAMap Configuration

QAMap reads `qamap.config.json` or `.qamap.json` from the scanned repository root.

Create a starter config:

```sh
qamap init .
```

Use an explicit config path:

```sh
qamap scan . --config ./qamap.config.json
```

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap.schema.json",
  "failOn": "high",
  "ignoreRules": ["QM011"],
  "maxFiles": 2000,
  "validationCommands": ["make test", "make lint"],
  "severity": {
    "QM007": "info"
  }
}
```

## Fields

| Field | Type | Description |
| --- | --- | --- |
| `failOn` | `info` `low` `medium` `high` | Exits with code `1` when findings at this severity or higher are present. CLI `--fail-on` takes precedence. |
| `ignoreRules` | `string[]` | Suppresses rule ids for this repository. |
| `maxFiles` | `number` | Maximum number of files QAMap inspects. CLI `--max-files` takes precedence. |
| `severity` | `Record<string, Severity>` | Overrides severity for specific rule ids. |
| `validationCommands` | `string[]` | Adds project-specific validation commands to `test-plan`, `eval`, `verify`, and GitHub Action reports. |

## Notes

- Prefer severity overrides over ignores when a finding is still useful but too noisy for CI.
- Keep ignores small and documented in pull requests.
- Use `validationCommands` for custom stacks, Makefile-based projects, or monorepos where the right validation command is not discoverable from standard project files.
- QAMap does not execute scanned project code while reading config.

## Local History

QAMap separates shared project policy from generated local history.

Commit-friendly files:

- `qamap.config.json`
- `.qamap/manifest.yaml` when a project wants one repo-level verification baseline
- `.qamap/flows.yml` when a project chooses to define durable core flows
- `.qamap/domains.yml` when a project chooses to define durable domain mappings

Ignored local artifacts:

- `.qamap/runs/`
- `.qamap/cache/`
- `.qamap/tmp/`
- `.qamap/*.local.json`

Run this once to create the local directories and add those ignore patterns idempotently:

```sh
qamap history init .
```

Use `--record-history` when an analysis should leave a compact local snapshot for comparison or debugging:

```sh
qamap e2e plan . --base origin/main --head HEAD --record-history
```

## Verification Manifest

Create a baseline repo-level verification manifest from the checkout you want to treat as the shared team baseline. For most projects, that means the latest default branch:

> **Important:** run the first shared `manifest init` from the default branch. QAMap reads the current checkout and does not silently switch branches, so a feature-branch run creates a feature-branch snapshot rather than the team's default QA map.

```sh
git switch main
git pull
qamap manifest context .
qamap manifest init .
qamap manifest init services/listing --workspace-root .
qamap manifest validate .
qamap manifest explain . --base origin/main --head HEAD
```

`.qamap/manifest.yaml` is meant to start the feedback loop. QAMap infers a baseline from routes, pages, components, API calls, package signals, and testable UI surfaces in the current checkout. It does not automatically switch to the default branch. A maintainer can then correct the manifest when recommendations are wrong, and future `verify`, `e2e plan`, and `e2e draft` output will use the corrected context. See [Verification Manifest](manifest.md) for the full schema, field guide, and adoption workflow.

Use the manifest commands in this order when adopting a repository:

1. `qamap manifest context .` previews repo-local docs, role classifications, validation commands, safety rules, and context diagnostics without writing files.
2. `qamap manifest init .` creates a baseline that is useful but intentionally reviewable.
3. `qamap manifest validate .` checks whether the baseline is parseable, anchored to real files, and specific enough to shape PR evidence.
4. `qamap manifest explain . --base origin/main --head HEAD` shows which domains, flows, and checks match the current branch, plus the exact manifest path to edit when a recommendation is wrong.
5. `qamap e2e draft . --base origin/main --head HEAD --dry-run` uses matched manifest flows as higher-confidence draft sources before falling back to domain-language or heuristic candidates.

```yaml
$schema: https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap-manifest.schema.json
version: 1

domains:
  - id: bundle
    name: Bundle
    paths:
      - src/pages/bundle/**
    criticality: medium
    source:
      kind: inferred
      confidence: medium
      from:
        - pages

flows:
  - id: bundle-submission-complete
    domain: bundle
    name: Bundle Submission Complete
    entry:
      route: /bundle/official/submissionComplete
      source: inferred
    runner: playwright
    anchors:
      - kind: route
        path: src/pages/bundle/official/submissionComplete.tsx
        route: /bundle/official/submissionComplete
        source: inferred
        confidence: high
    checks:
      - id: happy-path
        title: Bundle Submission Complete happy path works
        type: success
      - id: api-failure-fixture
        title: Bundle Submission Complete handles failed, empty, or unauthorized responses
        type: failure
    source:
      kind: inferred
      confidence: medium
      from:
        - route-file
```

Supported manifest concepts:

| Field | Description |
| --- | --- |
| `domains[].paths` | Glob-like path patterns that map changed files to product areas. |
| `domains[].criticality` | `low`, `medium`, or `high` signal for reviewer attention. |
| `flows[].entry.route` | User-facing route used as an E2E entry hint. |
| `flows[].anchors` | Route, component, file, API, or test anchors that connect changed code to a flow. |
| `flows[].checks` | Success, failure, edge, contract, or visual checks that should shape generated E2E drafts. |
| `source.kind` | `inferred` for QAMap-generated baseline entries or `declared` after human review. |
| `source.confidence` | `low`, `medium`, or `high` confidence for how strongly QAMap should trust the entry. |

When a recommendation is wrong, update the manifest path printed by QAMap instead of trying to make static analysis perfect. That turns one bad suggestion into durable repo-local knowledge.

When a matched flow has `entry.route` and `checks`, generated E2E drafts will carry the manifest evidence, use the route as the entrypoint when the runner supports it, and turn checks into draft steps plus coverage notes. That lets client teams create useful UI or flow tests even before a backend is complete: the manifest can describe the route, required success/failure checks, and fixture/mock expectations, while the draft keeps TODOs only for the project-specific selector, data, or runner details.

## Domain Manifest

Create a starter domain manifest:

```sh
qamap domains init .
qamap domains suggest . --base origin/main --head HEAD
```

`.qamap/domains.yml` is meant to be committed when the team wants QAMap to use shared product language during E2E planning.
The `suggest` command prints candidate YAML plus a promotion plan that separates `commit-candidate`, `needs-review`, and `low-signal` entries.

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

Use `.qamap/domains.yml` for naming and route hints. Use `.qamap/flows.yml` when the team wants to define a higher-confidence verification journey with priority and required checks.

## Core Flows

Create a starter core flow manifest:

```sh
qamap flows init .
qamap flows suggest . --base origin/main --head HEAD
```

`.qamap/flows.yml` is meant to be committed when the team wants QAMap to understand project-specific flows during E2E planning.
The `suggest` command prints candidate YAML plus a promotion plan that helps teams decide which flows are durable enough to commit.

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

`qamap e2e plan` includes a bootstrap section and a domain language section before the lower-level E2E candidates. The bootstrap section separates required setup, recommended policy capture, and ready evidence, which is especially useful when a project has no existing tests yet. QAMap derives domain language suggestions from:

- team-approved `.qamap/flows.yml` names
- shared `.qamap/domains.yml` names, aliases, routes, and scenarios
- changed file path terms such as `features/in-app-purchase`
- selected UI copy such as accessibility labels, placeholders, and text labels

The goal is to help reviewers and test authors use the product words the team already understands. For example, a service or component path can become `In App Purchase primary journey` instead of a generic implementation phrase such as "API smoke flow".

High-confidence terms usually come from committed core flows or domain manifests. Medium-confidence terms usually come from changed paths. Low-confidence terms can come from UI copy and should be treated as naming hints, not final policy.

## Fixture And Mock Readiness

`qamap e2e plan` checks whether a candidate flow appears to depend on API, network, payment, or external response data. When it does, QAMap looks for changed backend/API evidence and mock or fixture evidence such as:

- MSW or Mirage handlers
- `__mocks__`, `fixtures`, `factories`, `seeds`, or `test-data` directories
- Playwright route fulfillment helpers
- mock data files that match the changed domain

If a client flow calls an API but the branch does not include backend, mock, or fixture evidence, the E2E plan marks fixture readiness as `missing` and the generated draft includes next actions for deterministic success and failure responses. This lets teams validate UI and flow behavior before the real server implementation is complete.
