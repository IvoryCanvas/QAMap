# QAMap Rules

QAMap rules are intentionally small and repository-level. The goal is to catch risks that are cheap to fix before an AI coding agent or PR reviewer loses time.

Rule behavior can be tuned in `qamap.config.json`. See [configuration.md](configuration.md) for ignored rules, severity overrides, and CI failure thresholds.

| Rule | Severity | Description |
| --- | --- | --- |
| `QM001` | medium | No agent instruction file was found. |
| `QM002` | medium | Agent instruction files appear to contradict each other. |
| `QM003` | high | Agent instructions contain suspicious override or secret-exposure text. |
| `QM004` | medium/high | MCP config is unreadable or starts risky commands. |
| `QM005` | high | MCP config appears to contain committed secret-like values. |
| `QM006` | medium | `package.json` has no usable test script. |
| `QM007` | low | No GitHub Actions workflow was found. |
| `QM008` | high | A local environment file appears to be committed. |
| `QM009` | high | Package scripts can publish, push, merge, or run unsafe shell pipelines. |
| `QM010` | medium | GitHub Actions workflow grants broad permissions or uses risky triggers. |
| `QM011` | low | Community health files are missing. |
| `QM012` | medium/high | Committed agent settings define risky hooks or broad shell permissions. |
| `QM013` | low | API endpoints are documented only in prose without a machine-readable contract source. |

## Rule Design

- Prefer high-signal checks over noisy style rules.
- Avoid printing secret values in evidence.
- Do not execute project code while scanning.
- Keep rules explainable enough that a maintainer can fix them without reading QAMap internals.
