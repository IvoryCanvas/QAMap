# Release Runbook

This runbook defines the release process for `qamap`. It is intentionally conservative: the package should be published only when the local release gate, documentation, and representative repository validation all agree.

## Pre-1.0 Version Policy

QAMap keeps major and minor changes deliberately rare during `0.x` development.

- Patch is the default for bug fixes, inference quality, performance, internal architecture, benchmarks, documentation, and additional adapters that preserve the existing CLI, schema, and safety contracts.
- Minor is reserved for a new product-level capability, an incompatible CLI or manifest contract, or a meaningful change to default execution and safety behavior.
- Risky minor work should ship through `alpha`, `beta`, and `rc` prereleases before the final minor.
- Do not pre-allocate a minor version to every roadmap phase. Define the next minor release bar and continue compatible work as patches until that bar is met.
- Do not schedule `0.5.x` by date or implementation count. Continue `0.4.x` patches until external repository evidence shows that static QA design and automation drafts are dependable enough to support a new execution contract.

Version `0.4.0` is earned by the first commit-to-intent-to-scenario vertical slice: behavior-bearing commits and diff symbols become an evidence-backed lifecycle and concrete runner-independent QA, then existing Playwright, Maestro, or manual adapters compile the result. The next minor remains unscheduled and is reserved for explicit temporary execution and normalized evidence without modifying the target repository. That capability must be proven across unrelated repositories before a `0.5.0` candidate is cut.

Version `1.0.0` requires a stable public contract and external adoption, not implementation volume alone. CLI commands, exit codes, machine output, manifest migration, adapter compatibility, no-LLM/no-upload guarantees, and release operations must be dependable. Repository stars are useful social proof, but repeated use in unrelated repositories and reported QA value are stronger release evidence.

## Release Owner Checklist

Before publishing, confirm:

- `package.json` version matches the intended npm version.
- The canonical release identifier is `vX.Y.Z` (for example, `v0.4.0`). The Git tag and GitHub Release title must match this identifier exactly.
- `CHANGELOG.md` has a dated section for the version being published.
- `README.md`, [adoption](adoption.md), [E2E examples](e2e-output-examples.md), and [release validation](release-validation.md) describe the current CLI behavior.
- npm, GitHub Releases, and the OpenAI Plugin Directory are described as independent release channels; no document hard-codes an older directory version as current.
- If public branding changed, the README covers, skill icon, dedicated plugin upload images, GitHub social preview, and general social card have been reviewed at their intended sizes. Use the [brand asset guide](../brand/README.md) as the inventory.
- `pnpm run release:check` passes from a clean checkout.
- Representative repository smoke notes in [release validation](release-validation.md) do not hit any stop condition.
- npm login is available for a maintainer with publish permission for the `@ivorycanvas/qamap` package.

## Local Release Gate

Run the full local gate:

```sh
pnpm install
pnpm run release:check
```

The gate must pass:

- `pnpm test`
- `pnpm scan`
- `pnpm plugin:check`
- `pnpm plugin:smoke`
- `pnpm bench:ci`
- `pnpm bench:agent --dry-run --assert` (scripted harness smoke, not measured task quality)
- `pnpm bench:context`
- `pnpm bench:execution`
- `git diff --check`
- coverage thresholds for lines, branches, and functions
- `pnpm pack --dry-run`

`bench:execution` may install a local browser runtime, but it executes only committed public fixtures in temporary repositories. It must never discover or run private local benchmark targets.

If the gate fails, fix the product or documentation issue before publishing. Do not publish with a known failing gate.

## Package Preview

Inspect the package contents before publishing:

```sh
pnpm pack --dry-run
npm publish --dry-run --access public
```

The tarball must include runtime output, public documentation, schemas, and package metadata:

- `dist`
- `docs`
- `skills`
- `.codex-plugin`
- `.claude-plugin`
- `plugin`
- `schema`
- `README.md`
- `CHANGELOG.md`
- `PRIVACY.md`
- `SUPPORT.md`
- `TERMS.md`
- `LICENSE`
- `package.json`

The package version, CLI version constant, and both native plugin manifest versions must match before publication.

The tarball should not include local run history, generated temporary output, private smoke artifacts, or dependency folders.

## npm Publish

Publish only after the release gate passes and the maintainer confirms npm auth:

```sh
npm whoami
npm publish --access public
```

After publish, verify the public package can be executed without a source checkout:

```sh
VERSION="$(node -p "require('./package.json').version")"
node scripts/release-smoke.mjs --version "$VERSION"
```

The smoke installs that exact public npm version with lifecycle scripts disabled, creates a temporary generic Git fixture, initializes its own `.qamap/manifest.yaml`, and checks version, static QA, manifest validation/explanation, and draft dry-run without fixture writes. The checkout root does not need a manifest. The fixture, installed package, caches, and temporary reports are removed on success or failure.

To reproduce the published `0.4.17` smoke specifically (not the current checkout build):

```sh
node scripts/release-smoke.mjs --version 0.4.17
```

This downloads the public package and dependencies. It does not call a model, execute repository validation, or run browser/device QA. `execution.status: not-run` and a passing static smoke are compatible; a dry-run preview is not an executed E2E test. A generated fixture manifest is not reviewed production QA policy: a schema-valid `needs-work` manifest is reported as such, not promoted to reviewed coverage.

For offline harness regression checks against an already compiled local CLI:

```sh
node --test test/release-smoke.test.mjs
```

This reports `source: local-cli`, not published-package verification. It does not build or install dependencies.

If the release is the version pinned by the OpenAI skill package, also run the published-package form of the smoke before submitting the plugin. The directory submission must refer to a package version that already resolves from the public registry. Follow [the plugin submission runbook](plugin-submission.md); npm publication does not imply directory approval.

GitHub does not read a social preview image from Markdown automatically. After a
brand update, upload
`docs/assets/qamap-github-social-preview-1280x640.png` under the repository's
social preview setting and verify the resulting card separately. Keep
`docs/assets/qamap-social-card.png` for general Open Graph and social sharing.

## GitHub Release

After npm publish succeeds:

```sh
TAG="v$VERSION"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
```

Create a GitHub Release whose display title is exactly the tag:

```sh
gh release create "$TAG" --title "$TAG" --notes-file <release-notes.md>
```

Do not prefix the title with `QAMap` or `CodeWard`, and do not add a descriptive subtitle. Product positioning and highlights belong in the release notes body so the release list remains consistently sortable as `vX.Y.Z`.

The release notes body should contain:

- a concise release summary
- the current `CHANGELOG.md` section
- the latest local release gate numbers
- a note that the GitHub Action can be pinned to the version tag

## Post-Release Verification

After the tag and GitHub Release are visible, run:

```sh
node scripts/release-smoke.mjs --version "$VERSION"
```

Then update any public setup examples that should pin to the new `v$VERSION` tag.

## Repository-First Benchmark

After compilation, run the offline structural benchmark without rebuilding:

```sh
node scripts/bench-repository-index.mjs --assert
node scripts/bench-repository-index.mjs --files 2105 --format json --assert
node --test test/repository-index-bench.test.mjs
```

The deterministic synthetic fixture compares four exhaustive generic discovery/read passes with repository-first cold, warm, one-file-edit, and one-package-file-edit passes. Structural precision/recall, real impact-path precision/recall, and complete primary-fixture coverage gate read-reduction claims. Seven required quality cases cover relative imports, package exports/reexports, compiler-path aliases, ambiguous conditional exports, dynamic and unresolved module boundaries, and mixed product/maintenance changes. Incomplete metadata coverage must be disclosed in the boundary controls; it is not silently promoted to complete coverage. Missing, failed, blocked, or not-run quality cases prevent a passing summary and suppress read-reduction claims. Impact paths remain draft/not-run; the generic baseline measures structural discovery, not agent product-path quality.

Counts describe observed file I/O, not physical disk I/O or model tokens. Warm syntax reuse still reads content to validate hashes. Cache reads are reported separately and included in total read-byte differences, which may be negative. Actual compact UTF-8 JSON byte counts cover blocks, impact arrays, and the repository index used for a recovery round-trip. Persisted cache snapshot sizes are separate. These are not full CLI output or full recovery-report sizes.

Wall-clock samples use `performance.now()` and are diagnostic only: fixed order, one instrumented process, shared-machine contention, no timing threshold or speedup claim. Deterministic comparisons exclude only diagnostic timing. Actual provider usage remains unmeasured; no token or cost reduction may be inferred. A provider comparison separately needs an approved provider, pinned model, budget, and quality-passing paired runs.

### Provider Comparison

Before the 0.4.18 release decision, use the
[six-task measurement runbook](../scripts/agent-bench/README.md) to compare
generic, cold and warm arms. Offline assertions verify the harness only.
An actual measurement needs an explicitly chosen provider, exact model, locally
configured key and approved spending limit. Start with one task, then repeat
the full suite at least three times per arm if the pilot is valid.

Save the report with its implementation, fixture and prompt digests. Report
failed or incomplete tasks alongside successes. Require evidence precision,
recall, contract completeness, uncertainty and execution-state checks to pass
before interpreting token differences. Missing usage is unknown, not zero;
partial receipts from failed requests cannot establish savings. The shared
request ceiling is not a monetary cap. Do not replace these measurements with
offline byte counts or publish a fixed savings claim without the paired results.

## Rollback Notes

If a broken package is published:

- publish a patch version with the fix as soon as possible
- mark the broken npm version deprecated with a short reason
- update the GitHub Release notes to point users to the fixed version

Do not delete public release history unless there is a legal, credential, or severe security reason.
