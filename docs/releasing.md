# Release Runbook

This runbook defines the release process for `qamap`. It is intentionally conservative: the package should be published only when the local release gate, documentation, and representative repository validation all agree.

## Release Owner Checklist

Before publishing, confirm:

- `package.json` version matches the intended npm version.
- `CHANGELOG.md` has a dated section for the version being published.
- `README.md`, [adoption](adoption.md), [E2E examples](e2e-output-examples.md), and [release validation](release-validation.md) describe the current CLI behavior.
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
- `pnpm bench:ci`
- `git diff --check`
- coverage thresholds for lines, branches, and functions
- `pnpm pack --dry-run`

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
- `schema`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

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
pnpm dlx "@ivorycanvas/qamap@$VERSION" qa . --base origin/main --head HEAD
pnpm dlx "@ivorycanvas/qamap@$VERSION" manifest validate .
pnpm dlx "@ivorycanvas/qamap@$VERSION" e2e draft . --base origin/main --head HEAD --dry-run
```

Use a fresh shell or temporary directory for the smoke check when possible.

## GitHub Release

After npm publish succeeds:

```sh
git tag "v$VERSION"
git push origin "v$VERSION"
```

Create a GitHub Release for the tag with:

- a concise release summary
- the current `CHANGELOG.md` section
- the latest local release gate numbers
- a note that the GitHub Action can be pinned to the version tag

## Post-Release Verification

After the tag and GitHub Release are visible, run:

```sh
pnpm dlx "@ivorycanvas/qamap@$VERSION" --version
pnpm dlx "@ivorycanvas/qamap@$VERSION" qa . --base origin/main --head HEAD --format agent
pnpm dlx "@ivorycanvas/qamap@$VERSION" manifest explain . --base origin/main --head HEAD
pnpm dlx "@ivorycanvas/qamap@$VERSION" verify . --base origin/main --head HEAD
```

Then update any public setup examples that should pin to the new `v$VERSION` tag.

## Rollback Notes

If a broken package is published:

- publish a patch version with the fix as soon as possible
- mark the broken npm version deprecated with a short reason
- update the GitHub Release notes to point users to the fixed version

Do not delete public release history unless there is a legal, credential, or severe security reason.
