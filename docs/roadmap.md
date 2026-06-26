# Roadmap

CodeWard starts as a local CLI for repo-level AI agent readiness. The project can grow in layers without becoming heavy.

## Now

- Keep the scanner fast, static, and easy to understand.
- Make the first public npm release.
- Improve README, adoption docs, and sample output so new maintainers can try CodeWard quickly.

## Next

- Publish a versioned GitHub Action release tag.
- Improve `doctor` output with clearer scoring and remediation grouping.
- Improve `review` output for changed-line locations.
- Continue expanding agent surface detection across Codex, Claude Code, Cursor, GitHub Copilot, Gemini, and related tools.
- Generate rule documentation from scanner metadata.

## Later

- Policy packs for open source, startup teams, and security-sensitive repositories.
- VS Code and Cursor extension surfaces.
- Maintainer dashboard for repeated AI-assisted PR risks.

## Non-Goals

- CodeWard will not execute untrusted project code.
- CodeWard will not replace tests, review, branch protection, threat modeling, or security review.
- CodeWard will not become a general-purpose code style linter.
- CodeWard will not become a deep MCP server analysis engine.
