# CodeWard Verify

`codeward verify` is the PR-facing entry point for CodeWard.

It combines:

- `review`: new CodeWard findings and changed risky files introduced by a branch
- `eval`: verification-readiness gates for intent, risk, tests, and review size
- `test-plan`: domain-oriented scenarios inferred from changed files

Suggested commands are discovered statically from common project files:

- JavaScript/TypeScript: usable `package.json` scripts for test, typecheck, lint, build, and e2e
- Python: pytest, tox, Ruff, and mypy signals from `pyproject.toml`, pytest config, `tox.ini`, `uv.lock`, or Poetry files
- Go: `go test`, `go vet`, and `golangci-lint` when `go.mod` or golangci config exists
- Rust: `cargo test`, `cargo clippy`, and `cargo build` when `Cargo.toml` exists
- JVM: Gradle wrapper, Gradle build files, or Maven `pom.xml`

## Usage

```sh
codeward verify . --base origin/main --head HEAD --format markdown
codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md
codeward verify services/offer --workspace-root . --base origin/main --head HEAD --include-working-tree
```

Use `--fail-on high` or `--fail-on medium` to fail on CodeWard review findings at or above a severity threshold. Readiness scoring stays advisory in the first release.

## Output

The report answers the questions reviewers usually ask after an AI-assisted PR appears:

- Did this branch introduce new repo-level AI risks?
- Did it touch files that already had risky findings?
- Does the PR explain its intent, risk, rollback, or validation evidence?
- Which domain scenarios should be tested?
- Which commands should the author or reviewer run?
- Is the diff small enough to review without excessive verification tax?

`verify` is intentionally static and no-token by default. It does not execute project code and does not send source code to an LLM service.
