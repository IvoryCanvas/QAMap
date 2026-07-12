# Architecture

QAMap is moving from deterministic PR-to-draft heuristics toward a local, change-aware QA engine. The core must remain useful without cloud services, source upload, or LLM calls.

The target pipeline is:

```txt
commit range + base/head diff
  -> change intent analysis
  -> analyzer adapters
  -> behavior graph
  -> behavior lifecycle + impact selection
  -> runner-independent QA scenarios
  -> Playwright / Maestro / manual adapter
  -> explicit local execution
  -> normalized evidence and verdict
```

The repository, not a model session, is the source of truth. Commit subjects and bodies provide author intent, source code supplies observable structure, and `.qamap/manifest.yaml` supplies reviewed product intent that commits and code alone cannot prove.

## Change Intent

`src/change-intent.ts` reads behavior-bearing commits in the selected base/head range and joins related `feat`, `fix`, `hotfix`, `perf`, and supporting `refactor` commits through normalized domain terms. Added diff symbols provide independent evidence for triggers, conditions, state changes, side effects, and observable outcomes.

Each intent contains:

- the original commit evidence and source scope;
- an explicit confidence and `reviewRequired` flag;
- an ordered behavior lifecycle;
- runner-independent primary, failure, boundary, and state-transition QA scenarios.

One richly evidenced squash commit can reach high confidence. A title without connected diff evidence cannot. Working-tree-only inference is always low confidence and review-required. Release, docs, style, CI, and test-only commits do not become product intents.

The analysis is deterministic and local. It does not execute repository code, contact GitHub, upload source, or call an LLM.

## Behavior Graph

`src/behavior.ts` defines the framework-neutral intermediate representation. A graph contains stable nodes, typed edges, confidence, evidence, and direct or propagated change impact.

Generated graphs identify the shipped contract through `schema/qamap-behavior.schema.json` and `schemaVersion: 1`. The schema URL and node, edge, surface, and evidence enums are exported from the package so adapters and consumers can reject unsupported shapes deterministically.

Initial node kinds cover:

- domains and flows;
- routes, screens, endpoints, commands, and artifact surfaces;
- actions, states, effects, contracts, and assertions;
- fixtures, locators, and source files.

Initial edges describe containment, entrypoints, ordering, expected outcomes, fixture use, locators, implementation sources, and diff impact.

Every inferred node must retain provenance. A node without a commit, source, diff, selector, fixture, test, manifest, or named inference reason should not influence a QA verdict.

Node and edge ids are content-derived and stable. Re-running analysis against the same repository state must produce the same graph identity even when report timestamps differ.

## Compatibility Adapter

The first graph integration uses `qamap.inferred-flow-compat`. It translates the existing E2E flow observations into the new graph so the IR can be introduced without changing existing CLI recommendations.

This adapter is a migration bridge, not the final analysis architecture. Framework adapters should gradually emit graph fragments directly, after which draft generation will consume the graph instead of the graph consuming completed drafts.

`qamap.change-intent` is the first direct product adapter. It emits intent contracts, lifecycle actions/states/effects, scenario assertions, source links, and commit provenance before an automation runner is selected.

## Analyzer Adapters

An analyzer adapter has two operations:

```ts
interface BehaviorAnalyzerAdapter {
  id: string;
  version: string;
  detect(context): Detection;
  analyze(context): BehaviorGraphFragment;
}
```

Detection must be evidence-based and may decline a repository. Analysis failures are isolated and reported as diagnostics so one optional adapter cannot erase useful output from the others.

Adapters should be layered:

1. language adapters provide symbols, imports, calls, and schemas;
2. framework adapters provide routes, screens, handlers, and lifecycle conventions;
3. repository adapters provide manifests, tests, fixtures, and local policy;
4. executor adapters compile selected scenarios for an existing runner.

Support is reported by capability rather than a single yes/no framework badge:

| Level | Contract |
| --- | --- |
| Deep | Behavior impact, deterministic scenarios, and local execution are supported. |
| Structural | Routes, contracts, existing tests, and validation commands are understood. |
| Generic | Diff and dependency evidence are available; QAMap does not invent a product journey. |

TypeScript-based web stacks are the first deep-analysis target because the existing import, route, selector, and fixture signals already provide a useful base. Vue, Nuxt, and SvelteKit should reuse the common web behavior model rather than fork the QA pipeline. Mobile, API, Python, Go, and JVM support should enter through the same adapter contract.

## Manifest Boundary

The generated graph is local cache material and should not be committed in full. The verification manifest stores only durable, reviewed knowledge:

- important flows and criticality;
- expected and forbidden outcomes;
- auth, permission, fixture, and environment requirements;
- stable anchors and invariants;
- accepted corrections and suppressions.

This keeps first-run setup light while allowing one human correction to improve later PRs deterministically.

## Execution Boundary

`qamap qa` remains static and read-only. It must not execute scanned project code.

Future execution belongs to an explicit `qamap verify` mode with a visible execution plan. The intended safeguards are:

- generated tests live in an operating-system temporary directory by default;
- target repository files are not modified unless a separate write command is requested;
- commands, environment variables, network access, and time limits are policy controlled;
- existing mocks and fixtures are preferred over fabricated data;
- missing setup becomes `not verifiable`, never a false pass;
- source code and evidence remain local and no LLM is called.

Playwright, Maestro, and other tools are executor implementations. They are not the product-level recommendation shown first to users.

## Migration Order

1. Derive change intent and runner-independent QA scenarios from commit and diff evidence.
2. Move route, screen, endpoint, selector, fixture, and contract discovery into graph-producing adapters.
3. Compare base and head graphs to select affected behavior rather than relying on file categories alone.
4. Compile selected graph paths through Playwright, Maestro, or manual adapters.
5. Add explicit, temporary execution and normalized evidence.
6. Add manifest accept, reject, and repair commands so reviewed outcomes improve later analysis.

Version `0.4.0` establishes the commit-to-intent-to-scenario slice for synthetic web and mobile lifecycle changes. The next minor is reserved for a policy-controlled scenario execution and normalized evidence slice; compatible analyzer and adapter improvements remain patch releases during `0.x` development.
