# Governance

QAMap is maintained by IvoryCanvas.

## Roles

- **Maintainers**: IvoryCanvas members with repository write access. Maintainers can review, approve, merge, release, and manage issues.
- **Contributors**: Community members who participate through issues, discussions, and pull requests.

## Merge Policy

- `main` is protected.
- Direct pushes to `main` are not part of the normal workflow.
- Pull requests should pass CI before merge.
- Merge rights are limited to IvoryCanvas maintainers or organization members with explicit repository access.
- Maintainers own assignment and labels. Each PR receives one `type:` label and only the relevant `area:` labels.
- Maintainers squash-merge with a lowercase Conventional Commit subject after required checks pass.

## Releases

Releases are prepared by maintainers. Before publishing a package, maintainers should run:

```sh
pnpm release:check
```

The npm package is published before the canonical annotated tag and GitHub Release are created. See [docs/releasing.md](docs/releasing.md).

## Security

Security reports should follow [SECURITY.md](SECURITY.md). Please do not open public issues for unresolved vulnerabilities.
