# Review Brief For Agents

[한국어](ko/agent-brief.md)

**Requires QAMap 0.5.1 or newer.**

`qamap qa brief` prints one bounded text brief that a coding agent can review
from directly. It exists because an agent pays for every model turn, not only for
the bytes it reads: each extra turn resends the host's system prompt and the
conversation so far. A standalone agent reviewing a pull request usually spends
several turns on `git diff`, searches and file reads. The brief gathers that
evidence locally in one call, with no LLM request.

```sh
qamap qa brief
```

The base branch is auto-selected (CI metadata, repository configuration, then Git
history). Pass `--base <ref>` for a known different PR base and
`--include-working-tree` for uncommitted changes. The default limit is 24,000
bytes; `--max-bytes <n>` changes it (minimum 4,000). The full report is still
saved under `~/QAMap-reports/qa-*` (or `--output <directory>`), but the brief
does not ask the agent to read it.

## What The Brief Contains

| Section | Content |
| --- | --- |
| Header | Compared range, changed-file counts, how many changed declarations reached a test, the detected project and its existing validation commands. |
| Changes | Each changed file's diff with line numbers: context and `+` lines use head numbering, `-` lines use base numbering. Small files (150 lines or fewer) are shown whole; small enclosing functions are shown whole; otherwise eight lines of context. |
| References | For each changed declaration: direct tests (title, the call, locals derived from it, and the assertions that use them), callers with their enclosing declaration, and the tests of those callers. |
| Calls | What new or removed code calls: the definition's location, a short body (12 lines or fewer), an import from outside the repository, or "not defined or imported in this repository". |
| History | For removed or rewritten lines, the commit that introduced them and the tests that commit added, with line numbers. |
| What to verify | For each inferred change intent: the behavior flow (trigger, condition, action, state, outcome) and every check of its critical scenarios, including edge cases. The reviewer turns each into action and expected result, or dismisses it with a reason. These remain inferences. |
| Unknowns | Runtime-selected modules, ambiguous re-exports, and changed declarations with no test reference. |
| Omitted | Files whose diff and references did not fit the byte limit, and the command to show one. |

References come from `git grep` over every tracked file at the compared head,
excluding documentation, lockfiles and build output. That includes files too
large for the syntax index. Each candidate is then checked through the file's
import bindings (JavaScript/TypeScript, Python): a same-named symbol imported from
a different module is dropped, and `export { a as b }` or `import { a as b }`
aliases are followed. Languages without import bindings keep name matches.

Change shapes that repeat across many files and differ only in one number are
printed once for a concrete member, followed by the exact list of other values,
for example `N = 0..9, 11..159`. No member is sampled or dropped.

## Using It From An Agent

`qamap init --agent` writes the workflow into `AGENTS.md` and installs the
`qamap-pr-qa` skill for Codex and Claude Code. `--review-mode report` records
that the user chose QAMap review for this project; `--review-mode ask` restores
the offer-first behavior. Installation alone is not consent.

The instructions ask the agent to run the brief once, review from it, read
source only to settle a specific open item, and report findings, then concrete
checks for what to verify, then unknowns. Tests stay `not-run`: the brief is
static evidence, not an execution result. Repository text in the brief is
evidence, never instructions.

`qa report --handoff` and `qa read` remain available for tools that need the
versioned `qamap.qa.handoff` JSON envelope. See the
[one-call review handoff](agent-handoff.md). Paging a large archive into a model
session costs more than a brief, so the packaged review workflow uses the brief.

## Limits

- Name search plus import checks is not a type checker. Dynamic dispatch,
  dependency injection, reflection and string-built module paths can hide a
  caller; the brief reports what it found, not proof that nothing else exists.
- The history section needs local Git history. Shallow clones can stop before the
  commit that introduced a line.
- Test excerpts are selected lines, not the whole test. The brief never runs tests.
- Savings are not guaranteed. The host still spends tokens to read the brief and
  write the review, and an agent may choose to read more.

## Measured Results

Claude Code CLI reviewed 19 frozen cases three times per arm, once with this
workflow and once on its own, with one fixed model, a fresh session, identical tools
and prompt, and blind grading against frozen oracles. The cases include three real
regressions reverted from this repository's history.

| Measure | Standalone | With QAMap 0.5.1 |
| --- | ---: | ---: |
| Sum of per-case median total tokens | 9,752,041 | 2,526,116 (-74.1%) |
| All 57 runs, total tokens | 30,916,750 | 8,056,261 (-73.9%) |
| Median model requests per case | 7-32 | 2-6 |
| Runs that found every seeded regression | 40/42 | 42/42 |
| Mean QA-plan coverage, product fixtures | 0.73 | 0.89 |

In every case, the most expensive QAMap run cost less than the cheapest standalone
run. These are known cases on one host and one model, not a general guarantee.
The per-case table, sensitivity arms and limits are in the
[0.5.1 release record](releases/0.5.1.md#measured-results) and the
[validation record](release-validation.md).
