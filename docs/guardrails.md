# Repository Guardrails

The QA draft loop is QAMap's core product. This optional second layer statically scans a repository for the settings that make AI-assisted work risky.

## Running the scanner

The scanner checks agent instructions, MCP configs, committed env files, risky package scripts, workflow permissions, and validation signals before agent work becomes review churn.

For a repository baseline before broad agent use, run:

```sh
qamap scan .
```

```txt
Findings: 6 (high: 3, medium: 2, low: 1, info: 0)

HIGH
- QM003 Suspicious agent instruction text (AGENTS.md)
  Fix: Remove untrusted instruction text or move examples into clearly fenced documentation.
```

See the rule table below and [docs/rules.md](rules.md) for what the scanner checks.

When developing QAMap from source:

```sh
git clone https://github.com/IvoryCanvas/qamap.git
cd qamap
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

QAMap is a local-first PR verification planner with a repository-level verification manifest loop, not a finished automatic QA bot. A good result is a clear answer to "what should this branch prove before merge?", plus manifest-backed E2E, fixture, selector, and validation work that a developer can turn into real regression coverage. Many first drafts will correctly report `review-only` or `near-runnable` until the project adds runner config, stable selectors, deterministic fixtures, or team-owned manifest entries.


## What It Checks

The first release focuses on high-signal checks that are useful across many repositories.

| Rule | Severity | What it catches |
| --- | --- | --- |
| `QM001` | medium | Missing agent instruction files. |
| `QM002` | medium | Conflicting agent guidance. |
| `QM003` | high | Suspicious instruction text that can misdirect agents. |
| `QM004` | medium/high | Risky MCP command configuration. |
| `QM005` | high | Secret-like values embedded in MCP config. |
| `QM006` | medium | Missing or placeholder test scripts. |
| `QM007` | low | Missing GitHub Actions workflows. |
| `QM008` | high | Committed local environment files. |
| `QM009` | high | Package scripts that can publish, push, merge, or run unsafe shell pipelines. |
| `QM010` | medium | Broad workflow permissions or risky workflow triggers. |
| `QM011` | low | Missing community health files. |
| `QM012` | medium/high | Risky committed agent settings, hooks, or broad shell permissions. |
| `QM013` | low | API endpoints documented only in prose without a contract source. |

See [docs/rules.md](rules.md) for the rule catalog.
See [docs/ecosystem.md](ecosystem.md) for the agent ecosystem surfaces QAMap tracks.
See [docs/api-contracts.md](api-contracts.md) for the API contract source-of-truth check.
See [docs/verify.md](verify.md) for the combined PR verification report.
See [docs/eval.md](eval.md) for the change readiness evaluation.
See [docs/releasing.md](releasing.md) for the npm release runbook.

