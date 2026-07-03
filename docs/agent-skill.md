# CodeWard As A Local QA Skill

CodeWard can be used as a small local tool that an AI coding agent runs before opening, updating, or finalizing a pull request.

The goal is not to replace a reviewer or claim QA passed. The goal is to remove the repeated setup question:

```txt
What user flow did this PR touch, what should be tested, and what evidence is missing?
```

## Recommended Agent Step

Run this before writing a PR body or asking for review:

```sh
pnpm dlx @ivorycanvas/codeward qa . --base origin/main --head HEAD
```

For installed projects:

```sh
pnpm exec codeward qa . --base origin/main --head HEAD --output CODEWARD_QA.md
```

The command writes no test files. It only previews the QA work that should be attached to the PR.

## Packaged Skill Template

CodeWard ships a portable skill template at:

```txt
skills/codeward-pr-qa/SKILL.md
```

Use it when an agent surface supports local skill folders, instruction folders, or reusable workflow prompts. The template is intentionally vendor-neutral: it tells an agent when to run `codeward qa`, how to pick a base branch, what sections to copy into the PR, and when to suggest manifest repair.

After installing CodeWard as a dev dependency, inspect the template:

```sh
cat node_modules/@ivorycanvas/codeward/skills/codeward-pr-qa/SKILL.md
```

Or from a cloned CodeWard repository:

```sh
cat skills/codeward-pr-qa/SKILL.md
```

If your agent supports symlinked skills, point its skill directory at `skills/codeward-pr-qa`. If it only supports instruction text, copy the contents of `SKILL.md` into that system's reusable instruction format.

## What The Agent Should Do With The Output

Use the `PR Comment Draft` section as review context:

- affected flow
- recommended runner
- draft E2E or checklist path
- missing fixture, selector, assertion, runner, or validation evidence
- PR checklist items

If the command says a generated recommendation is wrong, do not keep re-prompting the agent with the same context. Update the repo-local manifest after human review:

```sh
pnpm exec codeward manifest init .
```

Then edit `.codeward/manifest.yaml` so future branches can reuse the corrected team QA language.

## Minimal Agent Instruction

```txt
Before finalizing a PR, run:
pnpm dlx @ivorycanvas/codeward qa . --base origin/main --head HEAD

Paste the affected flow, suggested E2E/checklist, missing evidence, and PR checklist into the PR body or review note.
If the recommendation is wrong, ask the maintainer which manifest domain, flow, anchor, or check should be corrected.
Do not treat CodeWard output as proof that browser, device, API, or manual QA already passed.
```

## Manifest Is An Upgrade, Not A Gate

First use should work without manifest setup. CodeWard starts from PR diff and repo signals.

Add `.codeward/manifest.yaml` when the team wants higher precision:

- team-owned domain names
- critical user flows
- routes, files, components, APIs, or tests that anchor those flows
- success, failure, edge, contract, or visual checks
- preferred runner per flow

That makes CodeWard closer to a repo-local QA memory layer instead of a one-off prompt.
