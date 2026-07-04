# QAMap Verify

`qamap verify` is the PR-facing entry point for QAMap.

It combines:

- `review`: new QAMap findings and changed risky files introduced by a branch
- `eval`: verification-readiness gates for intent, risk, tests, and review size
- `test-plan`: domain-oriented scenarios inferred from changed files
- verification manifest matches from `.qamap/manifest.yaml` when the repository has team-owned domains, flows, anchors, and checks

Suggested commands are discovered statically from common project files:

- JavaScript/TypeScript: usable `package.json` scripts for test, typecheck, lint, build, and e2e
- Python: pytest, tox, Ruff, and mypy signals from `pyproject.toml`, pytest config, `tox.ini`, `uv.lock`, or Poetry files
- Go: `go test`, `go vet`, and `golangci-lint` when `go.mod` or golangci config exists
- Rust: `cargo test`, `cargo clippy`, and `cargo build` when `Cargo.toml` exists
- JVM: Gradle wrapper, Gradle build files, or Maven `pom.xml`

For custom stacks or team-specific flows, add `validationCommands` to `qamap.config.json`. Configured commands are shown before automatically discovered commands.

## Usage

```sh
qamap verify . --base origin/main --head HEAD --format markdown
qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md
qamap verify services/listing --workspace-root . --base origin/main --head HEAD --include-working-tree
```

Use `--fail-on high` or `--fail-on medium` to fail on QAMap review findings at or above a severity threshold. Readiness and manifest recommendations stay advisory until the team decides to make them required PR evidence.

## Output

The report answers the questions reviewers usually ask after an AI-assisted PR appears:

- Did this branch introduce new repo-level AI risks?
- Did it touch files that already had risky findings?
- Does the PR explain its intent, risk, rollback, or validation evidence?
- Which domain scenarios should be tested?
- Which manifest flows or checks explain the recommended verification work?
- Which commands should the author or reviewer run?
- Is the diff small enough to review without excessive verification tax?

`verify` is intentionally static and no-token by default. It does not execute project code and does not send source code to an LLM service.
