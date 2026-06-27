# Roadmap

CodeWard starts as a local CLI for repo-level AI agent readiness. The project can grow in layers without becoming heavy.

## Now

- Keep the scanner fast, static, and easy to understand.
- Make the first public npm release.
- Improve README, adoption docs, and sample output so new maintainers can try CodeWard quickly.
- Make `verify` the best first-run experience for AI-assisted PRs.
- Keep `eval` explainable enough that maintainers trust the score and know what to fix.
- Keep expanding the fixture matrix beyond JavaScript so validation advice works for Python, Go, Rust, and JVM repositories.

## Next

- Publish a versioned GitHub Action release tag.
- Improve `doctor` output with clearer scoring and remediation grouping.
- Improve `review` output for changed-line locations.
- Expand `eval` with repository-specific verification manifests and configurable taste rubrics.
- Add language-specific domain patterns for backend services, CLIs, libraries, mobile apps, and infrastructure repositories.
- Continue expanding agent surface detection across Codex, Claude Code, Cursor, GitHub Copilot, Gemini, and related tools.
- Generate rule documentation from scanner metadata.

## Later

- Policy packs for open source, startup teams, and security-sensitive repositories.
- A memory or lessons workflow that captures repeated review feedback into durable agent instructions.
- VS Code and Cursor extension surfaces.
- Maintainer dashboard for repeated AI-assisted PR risks.

## Non-Goals

- CodeWard will not execute untrusted project code.
- CodeWard will not replace tests, review, branch protection, threat modeling, or security review.
- CodeWard will not become a general-purpose code style linter.
- CodeWard will not become a deep MCP server analysis engine.
