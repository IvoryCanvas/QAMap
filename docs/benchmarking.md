# Benchmarking QAMap

QAMap's unit tests prove that the implementation behaves as coded. The benchmark contract checks a different question: does a representative PR receive a useful QA answer?

`bench.config.json` is committed and runs in CI. Each target under `test/benchmarks/` contains a `base/` repository snapshot and a `head/` overlay. The runner materializes them as a temporary Git repository with a `main` baseline and one feature commit. QAMap reads those repositories but never installs dependencies or executes their code.

## Run the public contract

```sh
pnpm bench:ci
```

The command fails when any target violates its declared expectations. The initial corpus covers:

- a web app with no tests;
- a web app with Playwright and an existing mock handler;
- an Expo app with Maestro;
- an API service that should produce a contract checklist instead of a browser journey;
- a design-token repository that should stay on artifact verification;
- a shared component change that must reach its consuming page through reverse imports;
- an Expo native configuration-only change that must stay out of product journeys and prefer existing build commands;
- a Maestro test-only change that must run existing evidence instead of generating a duplicate journey.

## Expectations

Each target can declare:

| Field | Meaning |
| --- | --- |
| `runner` | Expected `playwright`, `maestro`, or `manual` recommendation. |
| `minFlows` | Minimum number of affected flows. |
| `minImportPropagatedFlows` | Minimum flows discovered through reverse imports. |
| `minDiffAnchoredFlows` | Minimum flows using selector evidence introduced by the diff. |
| `minManifestMatches` | Minimum domain, flow, and check matches from an external base manifest. |
| `minManifestFlowMatches` | Minimum flow-level matches from the external base manifest. |
| `minManifestBackedFlows` | Minimum QA flows that preserve manifest provenance. |
| `mustReachFiles` | Files that the selected flows must reach. |
| `mustNameFlows` | Product terms that must appear in a user-facing flow title. |
| `mustNotNameFlows` | Misleading flow-title terms that must not be emitted. |
| `mustDraftFiles` | Expected generated draft path fragments. |
| `mustIncludeSteps` | Behavior terms that must appear in draft steps. |
| `mustFindSelectors` | Stable selector evidence that must be recovered from the repository. |
| `mustFindSuccessSignals` | Observable outcome text that must appear in the flow's success criteria. |
| `mustFindEvidence` | Required evidence or fixture terms that must be reported. |
| `mustNotFindEvidence` | Evidence terms that would be false positives for this change. |
| `mustRecommendCommands` | Commands the setup or validation path must expose. |
| `maxBlankActions` | Maximum malformed or empty draft steps; public fixtures keep this at zero. |
| `maxGenericTitles` | Maximum titles ending in generic `primary journey` or `smoke flow` wording. |
| `maxAgentBytes` | Maximum UTF-8 payload size for `qa --format agent`. |

Set `manifestBaseline: true` on a committed fixture to generate its manifest from the base snapshot into the benchmark temp directory, then pass that external manifest to analysis of the head commit. The fixture repository is never modified by this step. This protects the feedback loop itself: a baseline must affect the next PR, not merely serialize valid YAML.

## Local repositories

Private or large repositories remain useful as a local smoke layer. Copy `bench.config.example.json` to `bench.config.local.json`, pin base/head SHAs, and run:

```sh
pnpm bench
node scripts/bench.mjs --save
node scripts/bench.mjs --baseline bench-results/<file>.json
```

When both files exist, `pnpm bench` prefers the gitignored local config. CI always passes `--config bench.config.json --assert`, so private paths cannot affect the public quality gate.

Saved results include flow titles, draft paths, recall gaps, readiness, agent payload size, and timing. Use a saved baseline to see heuristic movement, but treat the committed expectation contract as the merge gate.

## Adding a regression

When a real repository produces a poor recommendation:

1. Reduce it to the smallest reproducible `base/` and `head/` fixture.
2. Write the human expectation in `bench.config.json` before changing heuristics.
3. Confirm `pnpm bench:ci` fails for the intended reason.
4. Fix the inference and keep the fixture as permanent regression evidence.

Do not copy repository names, proprietary code, domain language, file paths, credentials, production data, or raw smoke output into a public fixture. Reduce the behavior to neutral synthetic vocabulary and keep private diagnostics outside the repository.
