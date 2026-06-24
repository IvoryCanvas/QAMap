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

## Notes

- Prefer severity overrides over ignores when a finding is still useful but too noisy for CI.
- Keep ignores small and documented in pull requests.
- CodeWard does not execute scanned project code while reading config.
