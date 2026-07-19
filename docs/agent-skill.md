# QAMap As A Local QA Skill

QAMap can be used as a small local tool that an AI coding agent runs before opening, updating, or finalizing a pull request.

The goal is not to replace a reviewer or claim QA passed. The goal is to remove the repeated setup question:

```txt
What user flow did this PR touch, what should be tested, and what evidence is missing?
```

## One-Command Setup

The fastest way to make a repository agent-ready is:

```sh
npx @ivorycanvas/qamap init --agent .
```

It performs three idempotent steps:

- adds a marked `Pre-PR QA (QAMap)` section to `AGENTS.md` (created if missing, appended if present; re-runs refresh only the marked section and never touch your own content)
- installs the packaged skill to `.claude/skills/qamap-pr-qa/SKILL.md` so Claude Code discovers it as a project skill (a locally modified copy is left alone unless you pass `--force`)
- creates a starter `qamap.config.json` when the repository has none

After that, agents that read `AGENTS.md` or project skills will run the QA pass below on their own. The rest of this document explains what that pass does and how to wire it manually on other agent surfaces.

## Recommended Agent Step

Run this before writing a PR body or asking for review. Agents should prefer the compact agent format — one minified JSON object (about 2 KB for a typical small PR) instead of a long report:

```sh
npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap qa . --base origin/main --head HEAD --format agent
```

The result carries a canonical `route` decision, `intents[]` with scenario-level structured diff `sources`, `flows[]` (affected behavior, entry route, steps, selectors), `requiredEvidence[]`, optional `automation`, `prChecklist[]`, and `commands[]` under `schema: qamap.qa`. Read `route.status`, `route.nextAction`, and its optional exact repository command before compatibility readiness scores. The one-off command uses npm directly so an agent does not trigger Corepack or rewrite the target repository's `packageManager` metadata.

For a human-readable report, drop the flag; for installed projects write it to a file:

```sh
pnpm exec qamap qa . --base origin/main --head HEAD --output QAMAP_QA.md
```

The command writes no test files. It only previews the QA work that should be attached to the PR.

## Packaged Skill Template

QAMap ships a portable skill template at:

```txt
skills/qamap-pr-qa/SKILL.md
```

Install it as a project skill with the `skills` CLI:

```sh
npx --yes skills add IvoryCanvas/qamap --skill qamap-pr-qa
```

This path is useful when a team already manages reusable agent skills through `skills-lock.json`. QAMap also keeps `qamap init --agent` for repositories that want the `AGENTS.md`, config, and packaged-skill setup in one idempotent command.

Use it when an agent surface supports local skill folders, instruction folders, or reusable workflow prompts. The template is intentionally vendor-neutral: it tells an agent when to run `qamap qa`, how to pick a base branch, what sections to copy into the PR, and when to suggest manifest repair.

After installing QAMap as a dev dependency, inspect the template:

```sh
cat node_modules/@ivorycanvas/qamap/skills/qamap-pr-qa/SKILL.md
```

Or from a cloned QAMap repository:

```sh
cat skills/qamap-pr-qa/SKILL.md
```

If your agent supports symlinked skills, point its skill directory at `skills/qamap-pr-qa`. If it only supports instruction text, copy the contents of `SKILL.md` into that system's reusable instruction format.

## What The Agent Should Do With The Output

Use `Change Intent Evidence` and the `PR Comment Draft` as review context:

- canonical route: complete an optional draft, run an existing repository command, or define one
- commit-backed intent, confidence, and whether human review is required
- ordered behavior lifecycle
- primary, failure, boundary, and state-transition QA scenarios
- the strongest commit or `file:line` source for every proposed scenario
- affected flow
- missing fixture, selector, or assertion evidence
- optional automation adapter selected only after QA design
- PR checklist items

If the command says a generated recommendation is wrong, do not keep re-prompting the agent with the same context. Update the repo-local manifest after human review:

```sh
pnpm exec qamap manifest init .
```

Then edit `.qamap/manifest.yaml` so future branches can reuse the corrected team QA language.

## Minimal Agent Instruction

```txt
Before finalizing a PR, run:
npm exec --yes --registry=https://registry.npmjs.org --package=@ivorycanvas/qamap@latest -- qamap qa . --base origin/main --head HEAD --format agent

Paste the affected flow, suggested E2E/checklist, missing evidence, and PR checklist into the PR body or review note.
If the recommendation is wrong, ask the maintainer which manifest domain, flow, anchor, or check should be corrected.
Do not treat QAMap output as proof that browser, device, API, or manual QA already passed.
```

## Manifest Is An Upgrade, Not A Gate

First use should work without manifest setup. QAMap starts from PR diff and repo signals.

Add `.qamap/manifest.yaml` when the team wants higher precision:

- team-owned domain names
- critical user flows
- routes, files, components, APIs, or tests that anchor those flows
- success, failure, edge, contract, or visual checks
- preferred runner per flow

That makes QAMap closer to a repo-local QA memory layer instead of a one-off prompt.
