# Roadmap

CodeWard starts as a local CLI for repo-level AI agent readiness. The project can grow in layers without becoming heavy.

## North Star

CodeWard should become a local-first PR verification designer: it understands a repository's domain language, remembers durable core flows, reads the current branch or PR diff, and drafts the E2E, fixture, selector, and validation work needed to prove the changed product behavior. The goal is not to replace reviewers or QA. The goal is to remove the repeated blank-page work that makes developers skip good verification.

## Now

- Keep the scanner fast, static, and easy to understand.
- Keep the [`0.1.0` release validation checklist](release-validation.md) and public [E2E output examples](e2e-output-examples.md) aligned with the current release bar.
- Improve adoption docs and sample output so new maintainers can try CodeWard quickly.
- Make `verify` the best first-run experience for AI-assisted PRs.
- Keep `eval` explainable enough that maintainers trust the score and know what to fix.
- Keep expanding representative validation targets beyond JavaScript so planning advice works for Python, Go, Rust, and JVM repositories.

## Next

- Publish a versioned GitHub Action release tag after the first public package is ready.
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
