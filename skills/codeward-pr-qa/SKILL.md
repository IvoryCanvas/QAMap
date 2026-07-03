---
name: codeward-pr-qa
description: Local-first PR QA workflow for AI-assisted code changes. Use when an agent is preparing, updating, or reviewing a pull request and needs to run CodeWard to identify affected flows, recommended E2E or manual QA work, missing fixture/selector/assertion/runner evidence, PR checklist items, and optional manifest repair guidance without calling a cloud service or LLM.
---

# CodeWard PR QA

Use CodeWard as a final local QA pass before presenting a pull request for human review.

## Workflow

1. Detect the comparison base.
   - Prefer the target PR base branch when known.
   - Otherwise use `origin/main`, then `origin/master`, then the repository default branch.
2. Run CodeWard from the repository root:

   ```sh
   pnpm dlx @ivorycanvas/codeward qa . --base <base> --head HEAD
   ```

   For an installed project, prefer:

   ```sh
   pnpm exec codeward qa . --base <base> --head HEAD
   ```

3. If the repository is a monorepo and the changed files are clearly inside one package, run a scoped pass too:

   ```sh
   pnpm dlx @ivorycanvas/codeward qa <package-path> --workspace-root . --base <base> --head HEAD
   ```

4. Read the `PR Comment Draft`, `Missing Evidence Before Trusting This PR`, and `PR Checklist` sections.
5. Include the useful parts in the PR body, review note, or handoff summary.

## Output Rules

- Treat CodeWard output as QA planning evidence, not proof that browser, device, API, or manual QA passed.
- Preserve the affected flow, suggested E2E/checklist path, missing evidence, and validation command in the handoff.
- If CodeWard recommends Playwright, Maestro, or manual QA, do not force a different runner unless the repository already has stronger runner evidence.
- If the output is `review only` or `near runnable`, explain what blocks it from becoming trusted regression evidence.
- If `codeward qa` says no manifest was found, do not stop. The first run is allowed to be manifest-free.

## Manifest Repair

When the recommendation is wrong or too broad, do not repeatedly re-prompt for the same QA context. Ask the maintainer which domain, flow, anchor, or check should be corrected.

If the team accepts CodeWard for ongoing use, suggest this follow-up:

```sh
pnpm exec codeward manifest init .
```

Then humans should review `.codeward/manifest.yaml` and keep only durable team QA language.

## Handoff Template

```txt
CodeWard QA
- Affected flow:
- Suggested E2E/checklist:
- Missing evidence:
- Validation command:
- Manifest repair needed:
```
