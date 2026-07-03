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

## Releases

Releases are prepared by maintainers. Before publishing a package, maintainers should run:

```sh
pnpm test
pnpm scan
```

## Security

Security reports should follow [SECURITY.md](SECURITY.md). Please do not open public issues for unresolved vulnerabilities.
