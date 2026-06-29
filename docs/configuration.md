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

## Core Flows

Create a starter core flow manifest:

```sh
codeward flows init .
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
