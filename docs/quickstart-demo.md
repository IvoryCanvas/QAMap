# First-Run Walkthrough

QAMap should answer one question before it asks you to adopt a runner, manifest, or workflow:

> What does this branch need to prove before merge?

## 1. Run One Read-Only Command

From the branch you want to review:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

QAMap infers the base branch in standard repositories. Use explicit refs only when needed:

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

The command performs static analysis. It does not run product code, install a test tool, or write files.

## 2. Read The Five Sections

The default text output is intentionally short:

1. **Change**: inferred intent, behavior lifecycle, and affected flow.
2. **Verify before merge**: selected QA scenarios and expected proof.
3. **Evidence**: the changed file, line, symbol, and trace coverage behind those decisions.
4. **Execution boundary**: whether an existing command or optional E2E draft was selected, and whether it ran.
5. **Next**: one explicit action plus links to deeper output.

Example from the committed subscription-renewal fixture:

```txt
QAMap QA
Local static analysis. No cloud or LLM token. Product QA was not run.
Inferred behavior is a draft, not a product specification; intended versus broken remains a human decision.

Change
  Prevent duplicate subscription renewal requests (medium confidence; review required)
  Flow:
    action: Prevent duplicate subscription renewal requests.
    -> observable-outcome: Subscription status becomes active.
  Affected behavior: Prevent duplicate subscription renewal requests

Verify before merge
  REQUIRED  Prevent duplicate subscription renewal requests
    Proof: Verify visible text "Subscription active" appears.
    Evidence: src/pages/renewal.tsx:11 (RenewalPage)
  RECOMMENDED  Failure, timeout, and retry handling
    Proof: Verify each response produces the intended visible or persisted state.
    Evidence: src/pages/renewal.tsx:11 (RenewalPage)
  RECOMMENDED  Duplicate renewal request
    Proof: Verify duplicate renewal request is prevented or handled explicitly.
    Evidence: src/pages/renewal.tsx:11 (RenewalPage)

Evidence
  3/3 scenarios connect to 5 unique diff source(s).
  Routing: 1 required, 2 recommended, 0 review-only.
  Optional E2E mapping: 0 mapped, 1 partial, 2 unmapped; not executed.
  Supplemental validation: npm run test:e2e (available, not selected for this QA route)

Next
  Review the selected scenarios before choosing an execution step.
  Preview an optional automation or checklist draft: qamap e2e draft . --dry-run
  Open the full reasoning trace: qamap qa --format markdown
```

The wording matters:

- **selected, not run** means QAMap found an existing repository command but did not execute it.
- **mapped, not executed** means QAMap can express an optional test draft; the application was not launched.
- **review required** means deterministic inference found evidence, but a human has not promoted it into team policy.

## 3. Open The Full Reasoning Only When Needed

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

The Markdown report retains:

- every change intent and lifecycle stage
- required, recommended, and review-only scenarios
- stable trace IDs
- exact diff and repository evidence
- scenario authority and approval requirements
- missing source or mapping gaps
- PR checklist and optional automation receipts

Use `--output QAMAP_QA.md` when you want a review artifact:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown --output QAMAP_QA.md
```

## 4. Execute Only By Explicit Choice

If the result selects an existing repository validation command:

```sh
npx --yes @ivorycanvas/qamap@latest qa run
```

QAMap re-analyzes the same change, runs only that selected command, applies a timeout, and returns:

- pass, fail, timeout, or blocked status
- exit code and duration
- bounded output sizes and hashes
- whether HEAD, branch, index, or Git-observable worktree state changed

This command does not install a runner or execute a proposed product E2E draft.

## 5. Preview Optional E2E

After accepting the selected QA scenarios:

```sh
npx --yes @ivorycanvas/qamap@latest e2e draft . --dry-run
```

QAMap chooses a Playwright, Maestro, CLI, or manual adapter only after QA routing. A scenario stays visible even when its selector, fixture, entrypoint, or assertion is not yet strong enough for deterministic compilation.

## Include Local Changes

To analyze staged, unstaged, and untracked work:

```sh
npx --yes @ivorycanvas/qamap@latest qa --include-working-tree
```

For repeat use in a JavaScript repository:

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap init --scripts
pnpm qa:local
```

## Agent Handoff

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

The compact payload carries the same decisions, evidence boundary, next action, and execution receipt in a versioned contract. See [agent-format.md](agent-format.md).

## Manifest Is Optional

Start without one. If a durable flow is repeatedly misunderstood:

```sh
npx --yes @ivorycanvas/qamap@latest manifest init
```

Review `.qamap/manifest.yaml` before committing it. Human-approved corrections can sharpen later branches without another prompt.

## Demo Provenance

The README GIF is generated from the current default output against:

```txt
test/benchmarks/web-symbol-annotated-renewal
```

The fixture is synthetic and committed. The GIF shows static analysis only. Separate execution benchmarks generate browser artifacts once, require the same artifact to fail on a seeded defect, and require it to pass on the fixed source.

For those contracts, see [benchmarking.md](benchmarking.md).
