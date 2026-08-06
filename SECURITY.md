# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the IvoryCanvas maintainers. If GitHub private vulnerability reporting is enabled for this repository, use that channel first.

If private reporting is not available, contact the maintainers directly and avoid posting exploit details in a public issue.

## Scope

Security-sensitive areas include:

- MCP configuration parsing
- secret detection behavior
- workflow permission checks
- command and script risk detection
- generated agent instruction content

## Expectations

QAMap is a guardrail, not a sandbox.

- `qamap qa` performs static analysis only. It does not execute project code, install dependencies, or write an automation draft.
- `qamap qa run` is an explicit execution command. It runs only the existing repository validation command selected in the current QA route, applies a timeout, and reports bounded output and Git-state evidence.
- `qamap e2e draft` can write generated files only when the user omits `--dry-run`; generated code still requires review before execution.
- QAMap never guarantees that a selected repository command or generated test is safe. Run untrusted repositories inside an appropriate sandbox.
