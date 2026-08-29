# QAMap Configuration

QAMap reads `qamap.config.json` or `.qamap.json` from the scanned repository root.

> **Configuration is optional.** Run `qamap qa` first. Return here only when you
> need stable defaults, rule severity, ignored paths, validation commands, or
> output limits.

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
  "executors": {
    "web": {
      "runner": "playwright",
      "command": ["pnpm", "exec", "playwright", "test", "{file}", "--grep", "{grep}", "--reporter=json"]
    }
  },
  "fixtures": {
    "geo-photo": { "kind": "file", "path": "fixtures/geo-photo.jpg" }
  },
  "scenarioFixtures": {
    "scenario:1a2b3c4d5e6f": ["geo-photo"]
  },
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
| `executors` | `object` | Repository-owned scenario executors for `qamap e2e run`. Each entry has a `runner` (`playwright` parses the JSON reporter, `command` reads only the exit code), an argument-vector `command` run without a shell that must reference `{file}` and may use `{grep}`, `{scenarioId}`, `{fixtureDir}`, `{artifactDir}`, plus optional `cwd`, `timeoutMs`, `artifactDirectory`, and `env`. |
| `fixtures` | `object` | Declared fixtures keyed by id: `{ "kind": "file", "path": "fixtures/geo-photo.jpg" }` copies a repository file into the run's fixture directory; `{ "kind": "seed", "command": ["node", "scripts/seed.mjs"] }` runs a seed hook without a shell. Paths and working directories must stay inside the repository. |
| `scenarioFixtures` | `object` | Scenario id to the fixture ids it needs. A compiled scenario with a configured executor and declared fixtures is reported as executable by `qamap qa` and can be run with `qamap e2e run`. |

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

File-name conventions are matched as whole name tokens (`demoSeedService.ts`, `mock-users.json`), never as substrings, so ordinary source files such as `useSeedlingCatalog.ts` or `errorHandler.ts` are not misread as fixtures.

If a client flow calls an API but the repository does not provide authoritative response evidence, the E2E plan marks fixture readiness as `missing` and names the endpoint that still needs a contract example or bound repository fixture. QAMap does not create a response body merely to make the draft look runnable.

QAMap also reads the contents of the discovered mock and fixture files (up to 24 per plan, statically, without executing anything) and extracts their exported symbols, the routes their handlers already serve (MSW `rest.*`/`http.*` handlers, Mirage and express-style routes, Playwright `route(...)` patterns), and the response keys they use. That analysis turns generic advice into named instructions:

- when an existing handler file already covers some of the flow's endpoints, the next action says which file to extend and which endpoints are still uncovered (for example `Extend src/mocks/handlers.ts (already handles /api/invoices) to also cover /api/payments/summary`)
- when a mock or seed module exports reusable data, the next action names the export to reuse for the uncovered endpoint
- a matching OpenAPI or Swagger response example may supply an exact Playwright response body when the endpoint and method are unambiguous
- schema fields, fixture keys, UI copy, and endpoint names never authorize invented response values
- the fixture action item title carries the affected endpoints, so the compact `--format agent` output keeps the concrete target

The matched fixture insights are exposed as an optional `mockInsights` array (file, exports, handled endpoints, sample keys) on each flow's `fixtureReadiness` in the JSON output. Contract authority is exposed separately as `contractAuthority`, including its status, source files, and any safe exact examples eligible for generation.
