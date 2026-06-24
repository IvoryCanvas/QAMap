# CodeWard Rules

CodeWard rules are intentionally small and repository-level. The goal is to catch risks that are cheap to fix before an AI coding agent or PR reviewer loses time.

Rule behavior can be tuned in `codeward.config.json`. See [configuration.md](configuration.md) for ignored rules, severity overrides, and CI failure thresholds.

| Rule | Severity | Description |
| --- | --- | --- |
| `CW001` | medium | No agent instruction file was found. |
| `CW002` | medium | Agent instruction files appear to contradict each other. |
| `CW003` | high | Agent instructions contain suspicious override or secret-exposure text. |
| `CW004` | medium/high | MCP config is unreadable or starts risky commands. |
| `CW005` | high | MCP config appears to contain committed secret-like values. |
| `CW006` | medium | `package.json` has no usable test script. |
| `CW007` | low | No GitHub Actions workflow was found. |
| `CW008` | high | A local environment file appears to be committed. |
| `CW009` | high | Package scripts can publish, push, merge, or run unsafe shell pipelines. |
| `CW010` | medium | GitHub Actions workflow grants broad permissions or uses risky triggers. |
| `CW011` | low | Community health files are missing. |

## Rule Design

- Prefer high-signal checks over noisy style rules.
- Avoid printing secret values in evidence.
- Do not execute project code while scanning.
- Keep rules explainable enough that a maintainer can fix them without reading CodeWard internals.
