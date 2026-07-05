---
name: qamap-pr-qa
description: Local-first PR QA workflow for AI-assisted code changes. Use when an agent is preparing, updating, or reviewing a pull request and needs to run QAMap to identify affected flows, recommended E2E or manual QA work, missing fixture/selector/assertion/runner evidence, PR checklist items, and optional manifest repair guidance without calling a cloud service or LLM.
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

3. If the repository is a monorepo and the changed files are clearly inside one package, run a scoped pass too:

   ```sh
   pnpm dlx @ivorycanvas/qamap qa <package-path> --workspace-root . --base <base> --head HEAD
   ```

4. If QAMap prints `First E2E Draft Bootstrap`, treat it as an instruction to create the starter draft before writing broad QA notes:

   ```sh
   pnpm exec qamap e2e setup . --runner <runner>
   ```

   Use the exact create command from the output when it differs.
5. Read the output. In agent format (single minified JSON object, `schema.name` = `qamap.qa`):
   - `flows[]` — affected flows with `draft` path, `runnable` status, `entry` route, capped `steps` and `selectors`.
   - `requiredEvidence[]` — evidence that must exist before the PR can be trusted; `recommendedEvidenceCount` for the rest.
   - `requiredBootstrap[]` — setup steps that block trusting generated drafts.
   - `firstDraftCommand` — present only when the repo has no test suite; run it to create the first starter draft.
   - `prChecklist[]` and `commands[]` — checklist lines and validation commands for the handoff.
   In markdown format, start from `At a Glance` (affected flows, the single next command, blocking items), then read the `PR Comment Draft`, `Missing Evidence Before Trusting This PR`, and `PR Checklist` sections.
6. Include the useful parts in the PR body, review note, or handoff summary.

## Output Rules

- Treat QAMap output as QA planning evidence, not proof that browser, device, API, or manual QA passed.
- Preserve the affected flow, suggested E2E/checklist path, missing evidence, and validation command in the handoff.
- Prefer creating the suggested starter E2E draft over only reporting that a draft is needed.
- If QAMap recommends Playwright, Maestro, or manual QA, do not force a different runner unless the repository already has stronger runner evidence.
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
- Affected flow:
- Suggested E2E/checklist:
- Missing evidence:
- Validation command:
- Manifest repair needed:
```
