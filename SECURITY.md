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

QAMap is a guardrail, not a sandbox. It does not execute scanned project code, install dependencies from scanned repositories, or validate that generated code is safe to run.
