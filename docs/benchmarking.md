# Benchmarking QAMap

QAMap's unit tests prove that the implementation behaves as coded. The benchmark contract checks a different question: does a representative PR receive a useful QA answer?

`bench.config.json` is committed and runs in CI. Each target under `test/benchmarks/` contains a `base/` repository snapshot and a `head/` overlay. The runner materializes them as a temporary Git repository with a `main` baseline and one feature commit. Intent fixtures set a synthetic `commitMessage` so commit-to-lifecycle behavior is part of the contract. QAMap reads those repositories but never installs dependencies or executes their code.

## Run the public contract

```sh
pnpm bench:ci
```

The command fails when any target violates its declared expectations. The corpus covers:

- a provenance-pinned reduction of Cal.com PR #27765 that changes signup validation timing and adds regression tests for typing, blur, correction, and submission;
- a web app with no tests;
- a web app with Playwright and an existing mock handler;
- Vue and SvelteKit web changes with framework-native route files;
- equivalent React and Vue conditional-state changes that must recover a changed action and observable outcome despite different syntax;
- a nested React item action that must create the required item through same-entity controls before exercising the changed action;
- a React change spanning two user surfaces that must produce two independent primary scenario receipts, actions, assertions, and compiled drafts;
- a presentation-only React condition that must not create behavioral state-transition QA;
- a web preferences change that must execute the submit action once, map the immediate visible outcome, and keep unproven persistence, request-failure, and re-entry QA explicit instead of manufacturing passing coverage;
- a repository-backed web persistence change that must connect one changed storage write to the matching read key, editable field, save action, route, and reload assertion before its primary draft can be fully mapped;
- a mobile reminder change that must become scheduling, calendar, duplicate, resynchronization, and entry-routing QA;
- a CLI plus static-analysis-rule change that must verify command I/O and positive/negative controls without turning rule vocabulary into product scheduling, routing, API, or fixture QA;
- an Expo app with Maestro;
- an API service that should produce a contract checklist instead of a browser journey;
- a Python API change whose exact changed regression test must become the repository-validation route while settings files remain configuration evidence;
- a design-token repository that should stay on artifact verification;
- a shared component change that must reach its consuming page through reverse imports;
- an Expo native configuration-only change that must stay out of product journeys and prefer existing build commands;
- a Maestro test-only change that must run existing evidence instead of generating a duplicate journey.

## Expectations

Each target can declare:

| Field | Meaning |
| --- | --- |
| `commitMessage` | Commit message used when materializing a fixture. Public PR reductions preserve the behavior-bearing source message; synthetic fixtures use neutral vocabulary. |
| `provenanceKind` | Expected fixture provenance. `public-pull-request` requires a pinned repository, PR URL, base/head commits, license, and matching `PROVENANCE.md`. |
| `runner` | Expected `playwright`, `maestro`, or `manual` output adapter. Runner correctness alone is not a useful intent benchmark. |
| `routeStatus`, `routeNextAction` | Expected canonical machine route and next action. Repository-verification fixtures use these instead of treating optional automation readiness as applicable. |
| `mustRouteCommands` | Terms that must appear in the exact command attached to a repository-validation route. |
| `minFlows` | Minimum number of affected flows. |
| `minChangeIntents` | Minimum evidence-backed Change Intents. |
| `minHighConfidenceIntents` | Minimum intents supported strongly enough by commit and diff evidence to avoid mandatory review. |
| `minCommitBehaviorNodes` | Minimum Behavior Graph nodes carrying commit provenance. |
| `minImportPropagatedFlows` | Minimum flows discovered through reverse imports. |
| `minDiffAnchoredFlows` | Minimum flows using selector evidence introduced by the diff. |
| `minManifestMatches` | Minimum domain, flow, and check matches from an external base manifest. |
| `minManifestFlowMatches` | Minimum flow-level matches from the external base manifest. |
| `minManifestBackedFlows` | Minimum QA flows that preserve manifest provenance. |
| `minManifestBehaviorNodes` | Minimum Behavior Graph nodes carrying verification-manifest evidence. |
| `mustHaveBehaviorKinds` | Behavior Graph node kinds that must be present, such as `flow`, `surface`, `source`, `assertion`, or `locator`. |
| `mustNameIntents` | Concrete terms that must appear in the inferred intent title. |
| `mustNotNameIntents` | Misleading terms that must not appear in inferred intent titles. |
| `mustIncludeLifecycle` | Trigger, condition, action, state, effect, or outcome terms that must survive in the ordered lifecycle. |
| `mustIncludeQaScenarios` | Failure, boundary, state-transition, or primary QA terms that must be proposed before runner compilation. |
| `mustNotIncludeQaScenarios` | QA scenario terms that would be false positives for the fixture and must not be proposed. |
| `mustCompileQaScenarios` | QA scenario terms that must be fully mapped into generated test commands and assertions. |
| `mustNotCompileQaScenarios` | QA scenario terms that must remain uncompiled when the repository does not prove a safe automation path. |
| `mustFindIntentEvidence` | Commit or diff terms that must remain attached to intent provenance. |
| `mustTraceScenarioFiles` | Changed files that must appear in at least one scenario's exact direct/supporting base- or head-side diff source. |
| `maxUntracedCriticalScenarios` | Maximum critical scenarios without a direct/supporting diff source carrying a file and line number. Contextual commit evidence cannot satisfy this contract; lifecycle fixtures keep it at zero. |
| `minReasoningTraces` | Minimum stable causal paths from scenario evidence through affected behavior and QA routing. |
| `maxMissingReasoningTraces` | Maximum routed scenarios with no corresponding QA reasoning trace. Public trace fixtures keep this at zero. |
| `maxUntraceableRequiredScenarios` | Maximum required scenarios whose diff evidence cannot be joined to an evidence-linked lifecycle stage. Public trace fixtures keep this at zero. |
| `minScenarioReceipts` | Minimum routed scenario receipts emitted by the E2E adapter. |
| `minCompiledScenarioReceipts` | Minimum scenarios fully mapped into generated test commands and assertions. |
| `maxCompiledScenarioReceipts` | Maximum scenarios allowed to be fully mapped, useful for false-positive controls. |
| `maxMissingScenarioReceipts` | Maximum selected QA scenarios with no corresponding automation receipt. Public lifecycle fixtures keep this at zero. |
| `minPrimaryFlowReceipts` | Minimum affected flows with their own primary scenario automation receipt. Unlike intent-level receipt counts, this cannot be satisfied twice by one strong flow. |
| `maxMissingPrimaryFlowReceipts` | Maximum affected flows whose primary scenario has no automation receipt. |
| `minCompiledPrimaryFlows` | Minimum affected flows whose primary scenario is fully mapped into its own draft. |
| `minPartialPrimaryFlows` | Minimum affected flows whose draft maps some behavior but keeps at least one unproven requirement explicit. |
| `maxReviewOnlyPrimaryFlows` | Maximum affected flows whose primary scenario lost located evidence and remained review-only. |
| `minPrimaryFlowsWithMappedSteps` | Minimum affected flows whose primary receipt maps at least one behavior step to generated commands. |
| `minPrimaryFlowsWithMappedAssertions` | Minimum affected flows whose primary receipt maps at least one observable assertion. |
| `minRoutedRequiredScenarios` | Minimum critical scenarios promoted to required by located direct or supporting diff evidence. |
| `maxRequiredScenarioGaps` | Maximum required scenarios that remain partial or not compiled. Use only for fixtures whose adapter coverage is expected to be complete. |
| `minMappedScenarioAssertions` | Minimum selected assertions mapped to observable runner assertions across scenario receipts. |
| `mustReachFiles` | Files that the selected flows must reach. |
| `mustNameFlows` | Product terms that must appear in a user-facing flow title. |
| `mustNotNameFlows` | Misleading flow-title terms that must not be emitted. |
| `mustDraftFiles` | Expected generated draft path fragments. |
| `mustIncludeSteps` | Behavior terms that must appear in draft steps. |
| `mustFindSelectors` | Stable selector evidence that must be recovered from the repository. |
| `mustFindSuccessSignals` | Observable outcome text that must appear in the flow's success criteria. |
| `mustFindEntrypoints` | Route, screen, or command entrypoints that affected flows must recover. |
| `mustFindEvidence` | Required evidence or fixture terms that must be reported. |
| `mustFindExistingEvidence` | Existing test paths that must be linked to the affected flow. |
| `mustNotFindEvidence` | Evidence terms that would be false positives for this change. |
| `mustRecommendCommands` | Commands the setup or validation path must expose. |
| `maxBlankActions` | Maximum malformed or empty draft steps; public fixtures keep this at zero. |
| `maxGenericTitles` | Maximum titles ending in generic `primary journey` or `smoke flow` wording. |
| `maxAgentBytes` | Maximum UTF-8 payload size for `qa --format agent`. Production output has a global 4KB ceiling and preserves the highest-priority intent, a detailed primary flow, a compact second flow for multi-surface changes, and omitted counts. |
| `minReadinessScore` | Minimum aggregate draft-readiness score after self-check, TODO, required-action, and execution-blocker penalties. |
| `allowedReadinessLevels` | Accepted aggregate levels: `ready`, `near-runnable`, `needs-work`, or `blocked`. Use this to prevent a semantically plausible but unusable draft from satisfying the contract. |
| `minTryableDrafts` | Minimum files classified as `runnable-candidate` or `near-runnable`. |
| `minRunnableCandidates` | Minimum files classified as `runnable-candidate` with no known execution blockers. |
| `minSelfCheckPass` | Minimum generated files whose static draft self-check passes. This does not claim that the target application was executed. |
| `maxSelfCheckFail` | Maximum generated files whose static draft self-check fails. Warnings may remain for honest setup or domain-assertion gaps. |
| `maxReviewOnlyFiles` | Maximum generated files that remain reference-only instead of tryable automation. |
| `maxTodos` | Maximum unresolved TODO markers across generated drafts. |
| `maxExecutionBlockers` | Maximum unresolved execution blockers across generated drafts. Contract failures name the most common blocker. |

Set `manifestBaseline: true` on a committed fixture to generate its manifest from the base snapshot into the benchmark temp directory, then pass that external manifest to analysis of the head commit. The fixture repository is never modified by this step. This protects the feedback loop itself: a baseline must affect the next PR, not merely serialize valid YAML.

## Local repositories

Private or large repositories remain useful as a local smoke layer. Copy `bench.config.example.json` to `bench.config.local.json`, pin base/head SHAs, and run:

```sh
pnpm bench
node scripts/bench.mjs --save
node scripts/bench.mjs --baseline bench-results/<file>.json
```

When both files exist, `pnpm bench` prefers the gitignored local config. CI always passes `--config bench.config.json --assert`, so private paths cannot affect the public quality gate.

Saved results include intent titles, lifecycle and scenario terms, located-source coverage (`trace`), complete QA reasoning paths (`path`), scenario receipt coverage, per-flow primary receipt coverage, flow titles, draft paths, recall gaps, raw readiness counts, self-check outcomes, TODOs, execution blockers, agent payload size, and timing. The table reports draft status as `runnable/near-runnable/review-only`, logical-scenario compilation as `compiled/partial/not-compiled`, and primary flow compilation as `compiled/partial/not-compiled/review-only`. Use a saved baseline to see heuristic movement, but treat the committed expectation contract as the merge gate.

Every benchmark target also enforces the Behavior Graph base contract: graph schema version 1, at least one graph flow for every planned flow, at least one impacted node for a non-empty diff, and no edge whose endpoint is missing. The table reports `graph n/i` as total nodes versus impacted nodes. These checks keep the graph connected to real PR analysis while framework-specific adapters are introduced incrementally.

## Adding a regression

When a real repository produces a poor recommendation:

1. Reduce it to the smallest reproducible `base/` and `head/` fixture.
2. Write the human expectation in `bench.config.json` before changing heuristics.
3. Confirm `pnpm bench:ci` fails for the intended reason.
4. Fix the inference and keep the fixture as permanent regression evidence.

Any new production heuristic must be exercised by at least two unrelated positive domains and one negative or false-positive control. Domain vocabulary belongs in fixture expectations or optional manifests, not in shared inference rules.

The nested-action rule follows that contract. Independent note and record fixtures provide positive same-entity evidence for `input -> create -> changed action -> observable result`, while an unrelated member-creation control is a negative control and must not be borrowed as setup. The rule is based on source ownership, selector role, and shared entity terms rather than any product domain name.

Cross-framework fixtures are semantic controls, not a claim that QAMap has separate product logic for each UI library. The same user-visible change is expressed through different syntax so a shared inference rule must survive both, while the negative control proves that merely seeing a condition is not enough to invent QA. Because every fixture is small, public, and deterministic, a regression can be reproduced without private source, network services, or a working application environment.

The persistence compiler follows the same rule. React and Vue controls prove that one shared storage-to-field relationship can produce save, stored-value, reload, and restored-value commands. A mismatched read/write-key control must remain partial. Framework names and product vocabulary do not authorize the proof; the connected repository evidence does.

Agent-focus regressions use the same evidence standard. Independent nested-action and persistence fixtures must preserve the changed action and observable proof under the 4KB handoff limit. A flow whose title and success signal are replaced with unrelated language must not receive a `focus` capsule, even when its old ordered steps remain present.

Repository-boundary regressions use nested working copies containing deliberately stale tests and fixtures. Those files must not change suite detection, existing-evidence paths, fixture guidance, or the PR checklist. The directory name is not the trust signal: any nested `.git` root is excluded, with common worktree directories skipped early for bounded scans.

Private repository names, proprietary code, file paths, credentials, production data, and raw smoke output must never enter a public fixture. For a public PR regression, first confirm a compatible license, record the canonical URL and exact base/head commits in `PROVENANCE.md`, and keep only a behavior-preserving minimum. The shared inference rule must remain domain-neutral and pass unrelated positive and negative controls.
