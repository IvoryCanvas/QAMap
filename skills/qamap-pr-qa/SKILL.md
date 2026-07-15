---
name: qamap-pr-qa
description: Local zero-LLM PR QA workflow. Use when an agent is preparing, updating, or reviewing a pull request and needs to derive commit-backed change intent, behavior lifecycle, runner-independent QA scenarios, affected flows, automation drafts, missing evidence, and optional manifest repair guidance without calling a cloud service or LLM.
---

# QAMap PR QA

Use QAMap as a final local QA pass before presenting a pull request for human review.

## Workflow

1. Detect the comparison base.
   - Prefer the target PR base branch when known.
   - Otherwise use `origin/main`, then `origin/master`, then the repository default branch.
2. Run QAMap from the repository root. Prefer the compact agent format — it carries the same decision content as the markdown report in a fraction of the tokens:

   ```sh
   npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap qa . --base <base> --head HEAD --format agent
   ```

   This one-off form runs outside the target repository's package-manager contract, so it does not invoke Corepack or add a `packageManager` field. For a project that already installs QAMap, prefer its local binary, for example:

   ```sh
   pnpm exec qamap qa . --base <base> --head HEAD --format agent
   ```

   Drop `--format agent` when a human will read the output directly; the default markdown report is written for people.
   The agent JSON is a versioned contract (`schema: qamap.qa` v1, additive-only): see docs/agent-format.md in the QAMap repository.

3. If the repository is a monorepo and the changed files are clearly inside one package, run a scoped pass too:

   ```sh
   npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap qa <package-path> --workspace-root . --base <base> --head HEAD
   ```

4. Read and verify intent before generating code. In agent format:
   - `intents[]` — commit/diff evidence, confidence, `reviewRequired`, ordered lifecycle, and primary/failure/boundary/state-transition scenarios. Read each scenario's structured `sources` before accepting it; a diff source carries `file`, head-side line numbers, symbol, and hunk.
   - If `reviewRequired` is true or the lifecycle conflicts with the PR, ask a human to confirm the intended behavior before promoting a draft.
   - `flows[]` — affected flows with `draft` path, `runnable` status, entry route, capped steps, and selectors.
   - `requiredEvidence[]` — evidence that must exist before the PR can be trusted; `recommendedEvidenceCount` for the rest.
   - `requiredBootstrap[]` — non-runner repository context that still needs clarification.
   - `automation` — an optional adapter handoff. It is not required to use the QA judgment.
   - `prChecklist[]` and `commands[]` — checklist lines and validation commands for the handoff.

5. Only after a human or team accepts the scenario and automation adapter, create or preview executable coverage:

   ```sh
   npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap e2e draft . --base <base> --head HEAD
   ```

   If the selected adapter is absent, inspect and explicitly accept the `automation.setupCommand` proposal. Never install a runner merely because QAMap detected a web or mobile surface.
6. Include the useful parts in the PR body, review note, or handoff summary.

## Output Rules

- Treat QAMap output as QA planning evidence, not proof that browser, device, API, or manual QA passed.
- Preserve change intent, confidence, lifecycle, QA scenarios, their strongest file/line sources, affected flow, missing evidence, and validation command in the handoff.
- Keep automation optional until the scenario and its evidence have been reviewed.
- Treat Playwright, Maestro, and manual output as adapters after QA design. Do not let runner selection replace review of the inferred intent and scenarios.
- If the output is `review only` or `near runnable`, explain what blocks it from becoming trusted regression evidence.
- If `qamap qa` says no manifest was found, do not stop. The first run is allowed to be manifest-free.

## Manifest Repair

When the recommendation is wrong or too broad, do not repeatedly re-prompt for the same QA context. Ask the maintainer which domain, flow, anchor, or check should be corrected.

If the team accepts QAMap for ongoing use, suggest this follow-up:

```sh
npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap manifest init .
```

Then humans should review `.qamap/manifest.yaml` and keep only durable team QA language.

## Handoff Template

```txt
QAMap QA
- Change intent and confidence:
- Behavior lifecycle:
- Required QA scenarios:
- Scenario source files/lines:
- Affected flow:
- Suggested E2E/checklist:
- Missing evidence:
- Validation command:
- Manifest repair needed:
```
