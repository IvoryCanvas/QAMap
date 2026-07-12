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
   pnpm dlx @ivorycanvas/qamap qa . --base <base> --head HEAD --format agent
   ```

   For an installed project, prefer:

   ```sh
   pnpm exec qamap qa . --base <base> --head HEAD --format agent
   ```

   Drop `--format agent` when a human will read the output directly; the default markdown report is written for people.
   The agent JSON is a versioned contract (`schema: qamap.qa` v1, additive-only): see docs/agent-format.md in the QAMap repository.

3. If the repository is a monorepo and the changed files are clearly inside one package, run a scoped pass too:

   ```sh
   pnpm dlx @ivorycanvas/qamap qa <package-path> --workspace-root . --base <base> --head HEAD
   ```

4. Read and verify intent before generating code. In agent format:
   - `intents[]` — commit/diff evidence, confidence, `reviewRequired`, ordered lifecycle, and primary/failure/boundary/state-transition scenarios.
   - If `reviewRequired` is true or the lifecycle conflicts with the PR, ask a human to confirm the intended behavior before promoting a draft.
   - `flows[]` — affected flows with `draft` path, `runnable` status, entry route, capped steps, and selectors.
   - `requiredEvidence[]` — evidence that must exist before the PR can be trusted; `recommendedEvidenceCount` for the rest.
   - `requiredBootstrap[]` — setup steps that block trusting generated drafts.
   - `prChecklist[]` and `commands[]` — checklist lines and validation commands for the handoff.

5. If the intent is credible and QAMap prints `First E2E Draft Bootstrap`, create the starter draft instead of stopping at broad QA notes:

   ```sh
   pnpm exec qamap e2e setup . --runner <runner>
   ```

   Use the exact create command from the output when it differs.
   `firstDraftCommand` is present only when the repo has no test suite; run it to create the first starter draft. In markdown format, start from `At a Glance` and `Change Intent Evidence`, then read the PR comment, missing evidence, and checklist sections.
6. Include the useful parts in the PR body, review note, or handoff summary.

## Output Rules

- Treat QAMap output as QA planning evidence, not proof that browser, device, API, or manual QA passed.
- Preserve change intent, confidence, lifecycle, QA scenarios, affected flow, suggested E2E/checklist path, missing evidence, and validation command in the handoff.
- Prefer creating the suggested starter E2E draft over only reporting that a draft is needed.
- Treat Playwright, Maestro, and manual output as adapters after QA design. Do not let runner selection replace review of the inferred intent and scenarios.
- If the output is `review only` or `near runnable`, explain what blocks it from becoming trusted regression evidence.
- If `qamap qa` says no manifest was found, do not stop. The first run is allowed to be manifest-free.

## Manifest Repair

When the recommendation is wrong or too broad, do not repeatedly re-prompt for the same QA context. Ask the maintainer which domain, flow, anchor, or check should be corrected.

If the team accepts QAMap for ongoing use, suggest this follow-up:

```sh
pnpm exec qamap manifest init .
```

Then humans should review `.qamap/manifest.yaml` and keep only durable team QA language.

## Handoff Template

```txt
QAMap QA
- Change intent and confidence:
- Behavior lifecycle:
- Required QA scenarios:
- Affected flow:
- Suggested E2E/checklist:
- Missing evidence:
- Validation command:
- Manifest repair needed:
```
