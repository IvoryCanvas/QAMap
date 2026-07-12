# Public benchmark fixtures

Each directory represents one reduced pull request:

- `base/` is committed on a temporary `main` branch.
- `head/` is copied over the baseline and committed on `benchmark/change`; intent fixtures provide a neutral synthetic `commitMessage`.
- `bench.config.json` declares the human expectation for the resulting QA draft.

Fixtures must stay small, synthetic, and safe to publish. The benchmark runner only reads the materialized repositories. It does not install dependencies, start services, run package scripts, or execute generated tests.

Fixture manifests exist only to exercise static framework and runner detection. They are excluded from Dependabot updates because their packages are never installed; changing a fixture version does not remediate a runtime dependency in QAMap.

The committed matrix includes React/Next.js, Vue, SvelteKit, Expo/React Native, API, artifact, shared-component, configuration-only, and test-only changes. Dedicated web preferences and mobile reminder fixtures protect commit intent, lifecycle ordering, failure and boundary QA, generic-title suppression, and commit-backed Behavior Graph evidence. Framework fixtures also protect route discovery, changed selectors, success signals, and draft paths rather than framework branding alone.

Add a fixture when a real failure can be reduced to a reusable project shape. Prefer one clear regression per fixture over a large imitation of a production repository.
