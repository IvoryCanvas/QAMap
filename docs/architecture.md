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
  -> evidence-ranked scenario routing
  -> stable QA reasoning trace
  -> Playwright / Maestro / manual adapter
  -> scenario automation receipts
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

## Base And Net Change Resolution

The analysis range is evidence too. QAMap resolves a base from an explicit option, pull-request CI environment, repo-local Git configuration, or the nearest long-lived branch in Git history. The chosen source and explanation are carried through test-plan, review, E2E, QA, and compact agent output. Local history cannot always prove the hosting platform's PR target, so equivalent refs at the same commit are disclosed instead of being treated as distinct answers.

Committed analysis uses the base/head merge-base range. Working-tree analysis compares that merge base directly with the final tracked worktree and then adds untracked files. This avoids preserving a stale intermediate change that was committed earlier in the branch but removed before review.

## Change Source Roles

Before changed text can become behavior evidence, `src/source-role.ts` classifies its source as `product`, `command`, `analysis-rule`, `configuration`, `test`, `documentation`, or `generated`. The role is an evidence boundary, not a domain guess: vocabulary inside an analyzer regex, benchmark contract, CLI parser, or documentation example must not silently become product behavior.

Product sources can contribute user actions, state, effects, and outcomes. Command sources contribute arguments, stdout, stderr, exit status, and generated-file contracts. Analysis-rule sources contribute positive and negative controls for the changed rule. Test, documentation, and generated sources remain verification evidence, while configuration stays on build/runtime verification unless another source proves a product journey.

The same boundary applies downstream. E2E setup and fixture discovery only inspect runtime-relevant product, command, and configuration evidence. Analyzer rules and benchmark vocabulary may explain why a QA scenario exists, but `/api`, `fixture`, payment, scheduling, or routing words inside those files cannot create product setup requirements by themselves.

## Scenario Routing and Compilation Receipts

Scenario generation and test generation are separate decisions. QAMap first routes every proposed scenario from its evidence:

- `required`: a critical scenario has at least one direct or supporting diff hunk with a concrete file and line;
- `recommended`: a non-critical scenario has the same located diff support;
- `review-only`: the scenario is supported only by commit wording or contextual evidence and cannot become policy by itself.

The route keeps required diff evidence separate from reference evidence. This lets a reviewer reject a false positive without reverse-engineering the heuristic that produced it.

Runner adapters then emit a second receipt for each routed scenario:

- `compiled`: every selected step and assertion was mapped to executable runner commands and observable assertions;
- `partial`: some, but not all, selected behavior was mapped;
- `not-compiled`: the scenario was selected but no deterministic compiler had enough entrypoint, action, fixture, and outcome evidence;
- `review-only`: the scenario or repository has no executable adapter contract.

Lifecycle stages are not copied blindly into runner steps. Trigger and action stages may become interactions. State changes and side effects remain reasoning and proof requirements unless the repository exposes concrete observation evidence. For example, clicking Save and seeing a success message can map the immediate outcome, but it cannot prove persistence after reload or re-entry. That draft stays `partial` until a deterministic adapter can express the missing proof.

A compilation receipt is static evidence, not a test result. Human output therefore calls these states `fully mapped`, `partially mapped`, and `not mapped`; the machine values remain stable for compatibility. Every `qa` result also carries an invocation-level `execution` receipt with `status: not-run` and `scope: static-analysis-and-draft-mapping`. Only explicit execution may produce pass or fail evidence. A required scenario that is partial or not compiled remains an execution blocker and prevents the draft from being described as runnable.

Human output groups the same decision into three layers: the complete QA and risk map, executable evidence available now, and manual or agent contracts for the remaining scenarios. Runner absence affects only the latter two layers; it never deletes a risk-backed QA scenario. A draft may be called `static-runnable` only when its structural self-check finds an entrypoint, observable assertion, and no skipped placeholder. The label always includes `not executed` until a separate execution boundary returns evidence.

The additive `route` object is the canonical machine decision above those compatibility values. It separates optional draft preparation from repository validation and names the next action directly: complete or review a draft, run an existing command, or define a missing command. Agent payload compaction preserves this object before lower-priority detail, so a repository-verification result cannot be misread as blocked product E2E work.

## QA Reasoning Trace

`src/qa-trace.ts` assembles the existing evidence and receipts into one causal path for each scenario:

```txt
diff file + line -> linked lifecycle stage -> risk -> routing decision -> optional draft -> not run
```

Trace IDs are derived from stable scenario IDs. The same ID appears in human QA output, the additive agent v1 payload, and generated Playwright, Maestro, or manual artifacts. A reviewer can therefore move from a draft back to the exact reason it exists without reconstructing that relationship from separate report sections.

A trace is `traceable` only when a located diff source and an evidence-linked lifecycle stage support a routed scenario. `partial` means the source and lifecycle could not be joined exactly. `review-only` means contextual or commit evidence was not strong enough to make the scenario policy. These states describe reasoning provenance, never product execution or pass/fail status. Automation remains optional: the reasoning path can be traceable even when no deterministic runner adapter can compile it yet.

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
4. Route scenarios from exact evidence and compile selected graph paths through Playwright, Maestro, or manual adapters.
5. Add explicit, temporary execution and normalized evidence.
6. Add manifest accept, reject, and repair commands so reviewed outcomes improve later analysis.

Version `0.4.0` establishes the commit-to-intent-to-scenario slice for synthetic web and mobile lifecycle changes. The next minor is unscheduled and reserved for a policy-controlled scenario execution and normalized evidence slice that has been proven across unrelated repositories; compatible analyzer and adapter improvements remain `0.4.x` patch releases until that bar is met.
