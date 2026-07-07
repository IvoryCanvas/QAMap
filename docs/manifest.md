# Verification Manifest

`.qamap/manifest.yaml` is QAMap's repo-local verification memory. It lets a team capture the product domains, flows, anchors, and checks that static analysis cannot reliably infer from code alone.

> **Important:** create the shared team baseline from the repository's default branch, after pulling the latest changes. QAMap reads the current checkout and does not silently switch branches, so a manifest generated on a feature branch represents that feature branch rather than the team's default QA map.

The intended workflow for the first shared baseline is:

```sh
git switch main
git pull
qamap manifest context .
qamap manifest init .
qamap manifest validate .
```

Then use the committed manifest from feature branches or PR branches:

```sh
qamap manifest explain . --base origin/main --head HEAD
qamap e2e draft . --base origin/main --head HEAD --dry-run
```

Or preview adoption without writing `.qamap/manifest.yaml` into the target repository:

```sh
qamap manifest init . --write /tmp/qamap-manifest.yaml
qamap manifest validate . --manifest /tmp/qamap-manifest.yaml
qamap manifest explain . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD
qamap e2e draft . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD --dry-run
```

`manifest init` reads the current checkout on disk. It does not silently switch to the default branch, because changing a developer's branch or working tree would be surprising and unsafe. If the team wants the manifest to represent the default product baseline, run it from the default branch after pulling the latest changes.

`manifest context` is the read-only preview step. It shows which repo-local documents QAMap sees, how each source is classified, which validation commands were collected (from project configuration such as `package.json` scripts and pytest setup, plus instruction docs), which safety rules were extracted, and which manifest path should be reviewed if the context is missing or stale. Use it before `manifest init` when you want to understand the bootstrap input without writing `.qamap/manifest.yaml`.

During baseline generation, QAMap also looks for repo-local context documents that often contain verification knowledge not visible in source files:

- `CONTEXT.md` and `CONTEXT-MAP.md`
- ADRs such as `docs/adr/*.md`
- goal documents such as `goals/*.md`
- agent instruction, harness, and skill files such as `AGENTS.md` and project-local instruction folders
- QA, test, release, and runbook documents under `docs/`

These files are used as advisory bootstrap context. They can improve initial naming, validation command hints, and safety rules, but they are not treated as product truth until a human reviews the manifest.

## What It Solves

QAMap cannot know every team's product priorities from file paths alone. The manifest turns repeated human review knowledge into durable repository context:

- which file paths belong to a product domain
- which routes, components, APIs, or tests anchor an important flow
- which success, failure, edge, contract, or visual checks matter for that flow
- which runner usually verifies the flow
- whether the entry came from QAMap inference or human review

When a recommendation is wrong, edit the manifest path shown in QAMap output. The next branch should get better recommendations without another explanation.

## Concrete Bootstrap Example

A first baseline can be useful before a human writes YAML by hand. Suppose the default branch has:

```txt
CONTEXT.md
docs/adr/checkout-purchase.md
AGENTS.md
src/pages/checkout/index.tsx
playwright.config.ts
```

If the ADR and context docs use the team phrase `Checkout purchase`, and the route file exposes `/checkout`, `qamap manifest init .` can create a manifest flow close to:

```yaml
flows:
  - id: checkout-checkout-purchase
    domain: checkout
    name: Checkout Purchase
    entry:
      route: /checkout
      source: inferred
    runner: playwright
    source:
      kind: inferred
      confidence: medium
      from:
        - route-file
        - adr-context
```

When a later PR changes `src/pages/checkout/index.tsx`, `qamap manifest explain . --base origin/main --head HEAD` should name the same flow, show the manifest evidence, and print the repair path:

```txt
Flow: Checkout Purchase
Evidence sources: route-file, adr-context
If this is wrong: update `.qamap/manifest.yaml > flows.checkout-checkout-purchase.anchors`
```

Then `qamap e2e draft . --base origin/main --head HEAD --dry-run` can preview a concrete draft such as `tests/e2e/checkout-purchase.spec.ts`, using the manifest route, detected selectors, and manifest checks before falling back to generic smoke-test heuristics.

## Schema

Generated manifests include:

```yaml
$schema: https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap-manifest.schema.json
version: 1
```

The JSON Schema is shipped in the package at:

```txt
schema/qamap-manifest.schema.json
```

Editors that understand YAML schema comments or `$schema` fields can use this file for validation and completion.

## Context Sources

When context documents are present, generated manifests may include a `context` section:

```yaml
context:
  instructionFiles:
    - path: CONTEXT.md
      kind: context
      confidence: medium
      roles:
        - domain-context
      signals:
        - role:domain-context
        - domain-language
    - path: docs/adr/checkout-flow.md
      kind: adr
      confidence: medium
      roles:
        - domain-context
        - workflow-lifecycle
      signals:
        - role:domain-context
        - role:workflow-lifecycle
        - architecture-decision
    - path: AGENTS.md
      kind: agent-instruction
      confidence: medium
      roles:
        - verification-rubric
        - test-runner
        - safety-policy
      signals:
        - validation-command
        - safety-rule
        - role:verification-rubric
    - path: .agent-core/skills/verification-layer.md
      kind: agent-instruction
      confidence: medium
      roles:
        - agent-skill
        - harness-config
        - workflow-lifecycle
        - verification-rubric
      signals:
        - role:agent-skill
        - role:workflow-lifecycle
  validationCommands:
    - pnpm test
  safetyRules:
    - Never write generated E2E drafts into target repos during smoke tests; use /tmp outputs.
  source:
    kind: inferred
    confidence: medium
    from:
      - context-document-context
      - adr-context
      - agent-instruction-context
      - verification-rubric-context
      - agent-skill-context
```

Use this section to understand which repo-local documents influenced the baseline. Keep the trust boundary clear:

- `CONTEXT.md`, ADRs, and goals can carry product language and intent.
- agent instructions, harness files, skills, and runbooks usually carry workflow, safety, and validation rules.
- `roles` explain how QAMap classified a context source: product domain context, workflow lifecycle, verification rubric, test runner, safety policy, release policy, agent skill, or harness config.
- instruction-derived context should start as `inferred` and should not override human-reviewed domains, flows, and checks.
- if a recommendation is wrong because a context document is stale, update the document or remove the stale context source from the manifest.

## Context Report

Run `qamap manifest context .` to see the context layer without writing files:

```sh
qamap manifest context . --format markdown
```

The report includes:

- role summary by source file, such as `verification-rubric`, `test-runner`, `agent-skill`, or `harness-config`
- captured context sources with kind, confidence, roles, and signals
- validation commands (project configuration first, then local docs) and safety rules extracted from prose
- diagnostics that point to the manifest path to edit when context is missing, stale, too broad, or not connected to checks

This command is useful when an E2E recommendation feels too vague. Instead of asking an LLM to re-read the repository, inspect the report, correct the repo-local context or `.qamap/manifest.yaml`, then rerun `qamap e2e draft`.

## Minimal Example

```yaml
$schema: https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap-manifest.schema.json
version: 1

domains:
  - id: bundle
    name: Bundle
    paths:
      - src/pages/bundle/**
    criticality: medium
    source:
      kind: declared
      confidence: high
      from:
        - product-qa

flows:
  - id: bundle-submission-complete
    domain: bundle
    name: Bundle Submission Complete
    entry:
      route: /bundle/official/submissionComplete
      source: declared
    runner: playwright
    anchors:
      - kind: route
        path: src/pages/bundle/official/submissionComplete.tsx
        route: /bundle/official/submissionComplete
        source: declared
        confidence: high
    checks:
      - id: happy-path
        title: Submit media link successfully
        type: success
        selector: "[data-testid=media-link-submit]"
      - id: invalid-input
        title: Show validation error for invalid media link
        type: failure
        selector: "[data-testid=media-link-error]"
    source:
      kind: declared
      confidence: high
      from:
        - product-qa
```

## Fields

| Field | Purpose |
| --- | --- |
| `domains[].id` | Stable machine-readable product area id. |
| `domains[].name` | Human-facing product term used in reports and draft titles. |
| `domains[].paths` | Glob-like path patterns relative to the manifest root. |
| `domains[].criticality` | `low`, `medium`, or `high` attention signal. |
| `flows[].id` | Stable machine-readable flow id. |
| `flows[].domain` | Optional domain id that owns the flow. |
| `flows[].entry.route` | Route hint used by Playwright drafts when available. |
| `flows[].runner` | Preferred verification runner: `playwright`, `maestro`, or `manual`. |
| `flows[].anchors` | Matchable route, component, file, API, or test anchors. |
| `flows[].checks` | Required verification points that should shape E2E drafts. |
| `flows[].checks[].selector` | Optional stable selector hint for this check, such as `[data-testid=coupon-input]`. |
| `flows[].checks[].value` | Optional input value for this check, such as `WELCOME10` or `qa@example.com`. |
| `flows[].checks[].steps` | Optional concrete steps for this check. These are used before the title parser. |
| `context.instructionFiles` | Advisory repo-local context sources used while bootstrapping the manifest. |
| `context.instructionFiles[].roles` | Advisory role classification for a context source, such as `verification-rubric`, `workflow-lifecycle`, `agent-skill`, or `harness-config`. |
| `context.validationCommands` | Validation commands from project configuration (verification-shaped `package.json` scripts, detected pytest setup) and context documents, ground truth first. |
| `context.safetyRules` | Workflow or safety rules inferred from context documents, with token-like values redacted. |
| `source.kind` | `inferred` for QAMap-generated entries or `declared` after human review. |
| `source.confidence` | `low`, `medium`, or `high` confidence in the entry. |
| `source.from` | Evidence sources such as `route-file`, `component-file`, `product-qa`, or `human-reviewed`. |

## Validate

Run:

```sh
qamap manifest validate .
```

The validator checks for:

- missing or unparsable manifests
- duplicate domain, flow, or check ids
- missing domain path patterns
- flow references to unknown domains
- flows without anchors or checks
- anchor paths that no longer exist
- duplicate anchors
- route hints that do not start with `/`
- missing or unusual `$schema` values
- low-confidence inferred entries that need human review
- stale context source paths and advisory instruction-derived context

`invalid` and `missing` exit with code `1`. `valid` and `needs-work` exit with code `0` so teams can adopt the manifest gradually before making it a hard CI gate.

## Explain

Run:

```sh
qamap manifest explain . --base origin/main --head HEAD
```

This command answers:

- which changed files matched manifest domains
- which flow anchors matched the branch
- which checks are now relevant
- why the match happened
- which next verification actions are worth spending time on
- which repair hints can improve future recommendations
- which manifest path to edit when the recommendation is wrong

## Draft Impact

When a matched manifest flow has an entry route and checks, `qamap e2e draft` promotes that flow ahead of heuristic candidates. The generated draft includes:

- `source: verification-manifest` in JSON output
- the manifest route as a Playwright entrypoint when supported
- manifest checks as draft steps and coverage notes
- check-level selector/value/steps hints as concrete draft actions when available
- manifest evidence comments inside generated files
- promotion guidance that treats strong manifest matches as commit candidates

This keeps generated tests explainable. A draft is not promoted because QAMap guessed well once; it is promoted because the repo has durable verification context.

Manifest-backed output should reduce repeat reviewer labor. A recommendation is useful only when it answers three questions:

- why did this PR touch this product flow?
- what should a developer verify now?
- what repo-local manifest or context entry should be repaired if the recommendation is noisy?

## Adoption Guidance

Start with `manifest init`, but do not expect the first baseline to be perfect. Review the entries that affect your next PR:

- rename domains from file-oriented names to product terms
- mark accepted entries as `declared`
- raise confidence only when the team agrees
- add failure, edge, contract, and visual checks where they are truly required
- keep path patterns narrow enough that recommendations stay explainable
- review context-derived validation commands and safety rules before treating them as team policy
- prefer manifest anchors over inline code comments until symbol-level anchors are intentionally adopted

For private or complex products, the manifest is the place to encode what humans already know but do not want to repeat in every PR review.
