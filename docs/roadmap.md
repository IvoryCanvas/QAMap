# Roadmap

QAMap is a local CLI for evidence-backed PR QA design. The project can grow in layers without becoming a hosted platform or token-dependent agent.

## North Star

QAMap should become a local, zero-LLM, change-aware QA engine. It should map any PR change to affected behavior, select the smallest relevant QA set, and eventually execute that QA with local evidence. A repository-level verification manifest supplies reviewed product intent that static code evidence cannot prove. The goal is not to replace reviewers or QA. The goal is to remove the repeated blank-page and manual verification work that makes developers skip good QA.

The sharp product position is:

```txt
Read the change, find the affected behavior, and produce local QA evidence.
No source upload. No LLM token. Let reviewed repository memory improve every later PR.
```

This means QAMap should be judged by whether it identifies the right behavior and catches a seeded regression, not only whether it writes plausible test code. Playwright, Maestro, and other runners are implementation details behind that product contract.

## Release Bar

Before treating the next public release as ready, the golden demo must satisfy these conditions:

- First-run output is concrete, not broad: it names the affected feature, flow, draft file, and checks.
- Commit evidence becomes an explicit change intent and ordered behavior lifecycle before any runner is recommended.
- Generic `primary journey` and `smoke flow` names fail the benchmark when commit and diff evidence can support a concrete lifecycle.
- Manifest authoring burden stays low: `manifest context` and `manifest init` provide a useful baseline before a human edits YAML.
- Generated E2E draft is a usable starting point: it has route/screen entry, meaningful actions, assertions, and clear TODOs only where repo data is missing.
- The public benchmark distinguishes a tryable file from complete PR evidence: golden automation fixtures contract on self-checks, TODOs, execution blockers, and runnable status instead of passing on flow naming alone.
- Recommendation evidence is explainable: output shows the changed file, manifest flow/check, and manifest path to repair when wrong.
- Every required scenario has one inspectable path from diff line to affected behavior, risk, routing decision, optional artifact, and explicit execution status.
- README demo shows the full loop: manifest-free PR QA draft, optional repo context baseline, PR mapping, E2E draft, and remaining validation gaps.
- One manifest correction should improve future PR recommendations without another LLM prompt.

## Now: 0.4.x

There is no fixed end date or patch count for `0.4.x`. QAMap will remain on compatible patch releases while real repositories still expose material gaps in change intent, affected-flow selection, scenario evidence, or automation-draft quality. `0.5.x` is not the next scheduled milestone; it is a release bar that must be earned by a stable, explicitly approved execution contract and evidence from repeated use outside the maintainer's repositories.

- Stabilize commit-range Change Intent analysis: related behavior commits, diff symbols, confidence, review requirements, lifecycle stages, and runner-independent QA scenarios.
- Preserve a conservative diff-only intent when commit messages are not descriptive, while keeping low-confidence scenarios recommended and review-required until stronger evidence exists.
- Classify changed sources before interpreting vocabulary: product, command, analysis-rule, configuration, test, documentation, and generated evidence must produce role-appropriate QA instead of borrowing one another's domain signals.
- Keep `qamap.change-intent` as a direct Behavior Graph adapter while moving more source observations out of the compatibility adapter.
- Preserve `qa` as the static, read-only product surface while designing explicit execution behind `verify`; never turn a scan into implicit project-code execution.
- Treat the committed [benchmark contract](benchmarking.md) as the quality gate for recommendations, not only implementation correctness. Reduce real failures into public fixtures and require `pnpm bench:ci` on every PR.
- Keep provenance-pinned public PR reductions beside synthetic controls. A real case must record repository, PR URL, base/head commits, license, and the human QA expectation it is meant to protect.
- Keep execution readiness separate from validation completeness. A draft may be locally runnable while still requiring failure coverage, fixture confirmation, or reviewer approval before it becomes trusted PR evidence.
- Keep optional automation readiness separate from repository verification readiness. Analyzer rules, configuration, documentation, generated output, and existing tests must point to repository validation without being mislabeled as blocked product E2E work.
- Expose one canonical machine route that survives payload compaction and tells agents whether to complete a draft, run an existing command, or define missing repository validation. Compatibility scores must never be the only applicable decision.
- Make `qa` the primary product surface. Its first screen and `--format agent` payload must agree on change intent, lifecycle, QA scenarios, affected behavior, repository evidence, draft path, and missing trust requirements.
- Keep `qa --format agent` below 4KB without dropping the highest-priority intent, routed scenarios, primary affected flow, a compact second flow for multi-surface changes, and omitted counts needed for an agent handoff.
- Improve changed-file impact mapping from shared symbols and components to consuming routes, screens, API contracts, and manifest flows.
- Keep long-PR intent clustering conservative: package scopes and one-word keyword bridges must not collapse unrelated commits into one high-confidence QA lifecycle.
- Keep the [release validation checklist](release-validation.md), [manifest guide](manifest.md), public [E2E output examples](e2e-output-examples.md), and README examples aligned with captured output from the public fixtures.
- Stabilize the manifest feedback loop with `.qamap/manifest.yaml`, `manifest init`, `manifest validate`, `manifest explain`, JSON Schema, and manifest-driven E2E draft shaping.
- Regression-test the complete manifest correction lifecycle: manifest-free first judgment, human correction, same-PR improvement, committed repo memory, and reuse on a later PR.
- Keep `manifest context` useful as a pre-init sanity check for repo-local QA memory, harness docs, agent instructions, and runbooks.
- Improve Playwright and Maestro compilation from intent scenarios while keeping runner choice behind the runner-independent QA contract.
- Keep scenario selection and static draft mapping independently measurable: exact diff evidence routes each scenario as required, recommended, or review-only, then runner receipts report compatible `compiled`, `partial`, or `not-compiled` machine states while human output says mapped and not executed. Required mapping gaps must lower readiness instead of hiding behind a green smoke assertion.
- Measure multi-surface compilation per affected flow, not only per logical intent scenario. One compiled artifact must never hide a sibling flow with missing action, assertion, or located evidence.
- Keep stable QA trace IDs across human, JSON, agent, and generated artifact output. Benchmark fixtures must reject missing scenario traces and required scenarios whose diff evidence cannot be joined to an affected lifecycle stage.
- Classify trace provenance as confirmed, source-gap, or mapping-gap, deduplicate repeated evidence references, and route incorrect judgments back to an exact manifest target without changing shared QA memory until a human approves it.
- Require every new shared heuristic to pass unrelated web/mobile or UI/service fixtures plus a negative control. Product-specific vocabulary stays in fixtures and optional manifests, never in global rules.
- Keep `verify`, `e2e`, and `manifest` as deeper layers behind `qa`; freeze new scanner, doctor, eval, domains, flows, and history features until the core QA contract is consistently useful.

## Longer-Term Release Bar (No Scheduled 0.5.x Date)

- Move route, screen, endpoint, selector, fixture, test, and contract discovery into analyzer adapters, starting with TypeScript web stacks and reusing one web behavior model across Next.js, React Router, Vue/Nuxt, and SvelteKit.
- Compare base and head Behavior Graphs, then select impacted graph paths before refining deterministic success, validation, failure, empty, loading, auth, and contract scenarios.
- Add policy-controlled temporary execution so selected scenarios can produce normalized pass, fail, blocked, and not-verifiable evidence without modifying the target repository.
- Add an execution benchmark that injects known regressions and requires QAMap to select and fail the relevant scenario without changing the fixture repository.
- Compile critical success and failure scenarios into concrete runner actions before execution, so a green smoke assertion cannot satisfy a lifecycle or coverage contract by itself.
- Add symbol-level anchors for exported components, hooks, API clients, handlers, schemas, and queries after the public import-impact fixture stays stable.
- Add a manifest correction command that proposes the exact flow/anchor patch and applies it only after human approval, avoiding routine hand-edits to YAML.
- Add stronger deterministic draft adapters for Playwright and Maestro while keeping `manual` output for API, CLI, token, and catalog repositories; runner detection itself is not a product success metric.
- Expand the public benchmark corpus with package-scoped monorepos, auth/session changes, dynamic routes, API failure fixtures, and non-JavaScript services.
- Keep the `--format agent` output a stable, versioned contract that skills and MCP wrappers can rely on.
- Continue expanding agent surface detection across popular coding-agent tools without making the public workflow depend on a single vendor.

These items do not imply that the next completed item triggers a minor release. Analyzer improvements, new deterministic scenarios, stronger adapters, and additional benchmark fixtures continue as `0.4.x` patches when they preserve the public CLI, schema, and safety contracts. A `0.5.0` candidate should be considered only when policy-controlled execution is useful across unrelated repositories, the target repository remains unmodified by default, and normalized evidence is stable enough to document as a new public capability.

## Later

- Policy packs for open source, startup teams, and security-sensitive repositories.
- A memory or lessons workflow that captures repeated review feedback into durable agent instructions.
- VS Code and Cursor extension surfaces.
- Maintainer dashboard for repeated AI-assisted PR risks.

## Non-Goals

- Static commands such as `qa`, `scan`, and planning modes will not execute scanned project code. Future execution requires an explicit command and a visible, policy-controlled execution plan.
- QAMap will not implement its own browser or device automation engine; it will orchestrate proven local executors behind a framework-neutral QA contract.
- QAMap will not replace tests, review, branch protection, threat modeling, or security review.
- QAMap will not become a general-purpose code style linter.
- QAMap will not become a deep MCP server analysis engine.
