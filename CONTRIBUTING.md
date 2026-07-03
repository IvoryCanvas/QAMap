# Contributing to QAMap

Thanks for helping improve QAMap.

## Development

```sh
pnpm install
pnpm test
```

Useful commands:

```sh
pnpm build
pnpm scan
pnpm report
```

## Pull Requests

- Keep pull requests focused and easy to review.
- Add or update tests when scanner behavior changes.
- Update README or rule documentation when user-facing behavior changes.
- Use one of these branch prefixes: `feat/`, `fix/`, `refactor/`, `style/`, `hotfix/`, `chore/`, or `docs/`.
- Do not use a `codex/` branch prefix.

## Good First Contributions

- Add detection for another agent instruction surface.
- Improve SARIF locations for a rule.
- Add focused scanner fixtures for a risky repo pattern.
- Improve rule recommendations so maintainers can fix findings faster.
- Add documentation for real-world rollout patterns.

## Maintainer Permissions

External contributors can open issues and pull requests. Push and merge permissions are reserved for IvoryCanvas maintainers and organization members with explicit repository access.

The `main` branch is expected to require pull requests and passing CI before merge.
