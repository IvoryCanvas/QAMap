# External Review Benchmark Protocol

This protocol measures QAMap on pull requests that QAMap's authors did not write,
select by hand or grade against their own oracle. It is committed before any case
is selected or any host run starts. Selection is mechanical, from
`protocol.json` and `scripts/agent-bench/external-review.mjs select`, and every
selected case is reported, including cases where QAMap does worse.

## Repositories

Twelve public repositories are fixed in `protocol.json`: eight TypeScript or
JavaScript projects and four Python or Go projects. The two pools are reported
separately. A repository takes part only if its default branch has at least 20
commits in the eligibility window and at least 80% of them have one parent and a
subject ending in `(#N)`, so that one commit is one merged pull request. A
repository that cannot be cloned or fails this rule is reported as excluded.

The windows start on 2026-07-01 to reduce the chance that the host model saw the
change or its later fix in training. They do not remove that chance.

## Study 1: Regressions Fixed Later By The Project

The ground truth is a later commit by the project's own maintainers.

1. A fix commit `F` has a subject matching `fix`, `fixes`, `fixed` or `fix(`, and
   its message names a pull request `#N` as the cause, using `regress*`,
   `introduced`, `caused`, `broke*` or `broken` within 60 characters of `#N`.
   Reverts are excluded.
2. The introducing commit `C` is the default-branch commit whose subject ends in
   `(#N)`. It has one parent, was committed between 2026-07-01 and 2026-09-20,
   is older than `F`, is not a revert or a bot commit, and does not match the
   excluded subjects in `protocol.json`.
3. `F` changes at least one non-test file that `C` also changed.
4. `C` changes at most 40 files and at most 2,000 lines, not counting lockfiles,
   snapshots, minified, vendored, built or locale files, and at least one of
   them is a non-test source file.
5. Order qualifying pairs by `sha256(seed:repository:N)`. Keep at most two per
   repository, then at most twelve in total, in that order.
6. If fewer than eight pairs qualify, the introducing window starts on
   2026-04-01 instead, and every case is marked as earlier than the main window.

Each case runs twice per arm.

## Study 2: Seeded Random Pull Requests

1. Candidates are default-branch commits from 2026-08-01 to 2026-09-20 with one
   parent and a subject ending in `(#N)`. Reverts, bot commits and excluded
   subjects are removed. Pull requests already chosen for Study 1 are removed.
2. A candidate changes 1 to 30 files and 20 to 1,500 lines, counted as in
   Study 1, and at least one non-test source file.
3. Order candidates by `sha256(seed:repository:N)` and take the first two per
   repository.

Each case runs once per arm. The comparison is paired by case.

## Fixtures

A fixture holds only the reviewed commit's parent and its history for the
previous 90 days. It has no remote, tags, later commits or fetch records. The
fixture's `main` is the parent. `feature/change` holds the reviewed commit,
cherry-picked with its original message and author. Both arms use the same
cherry-pick. The QAMap arm first commits the output of
`qamap init --agent --review-mode report` on `main`. The repository's own
agent instruction files stay as they are in both arms.

## Arms And Host

- Host: Claude Code CLI in print mode, one fixed model for both arms, a fresh
  home directory and session per run, no MCP servers. The tools are Bash, Read,
  Grep, Glob and Skill. Editing, web and subagent tools are disabled.
- Limits: 100 turns and 30 minutes per run, four runs at a time. Arm order
  alternates by case and run.
- Prompt (both arms): "Review the changes on this branch (base: main, head:
  HEAD) as a QA reviewer. Find likely bugs, regressions or broken contracts,
  and list what must be verified. Cite file:line evidence. Static review only:
  do not run tests, install anything, or modify files."
- QAMap arm: the published `@ivorycanvas/qamap@0.5.1` package, project setup as
  above, and the prompt prefixed with "Use QAMap for this review."
- Tokens are input, cache creation, cache read and output from the host's
  per-model usage receipt.

A run that stops at the turn or time limit keeps its tokens in the totals and
counts as `missed` in Study 1 and as an empty review in Study 2. A case is
dropped only if its fixture cannot be built, and it is reported as dropped.

## Grading

The grader is a separate session on a different fixed model. Tool and report
names are redacted from answers with the same rule as `review-judge.mjs`.

Study 1 grading has no tools. The prompt is:

```text
You are grading whether a code review of a pull request identified a defect that
the project fixed later. Grade substance only; ignore style, length and which
tools were used.

REVIEWED PULL REQUEST: <subject of C>

LATER FIX, merged afterwards in the same repository. Its message names the
reviewed pull request as the cause:
<message of F>
<diff of F, first 40,000 characters>

Verdicts:
- "found": the review states the failure that the later fix corrects, in the
  code the fix changes or an unambiguous equivalent. It may be a definite defect
  or a specific risk that names the triggering condition and the wrong behavior.
- "partial": the review points at the same code and condition, but does not
  state the wrong behavior.
- "missed": anything else, including generic "verify X works" items.

Return ONLY JSON: {"verdict": "found"|"partial"|"missed", "quote": "shortest
supporting excerpt from the review, or empty", "notes": "one short sentence"}

REVIEW:
<<<
<redacted answer>
>>>
```

Study 2 grading is pairwise. The grader runs inside a fixture built as for the
standalone arm. It can use Read, Grep and Glob, plus Bash limited to `git diff`,
`git show` and `git log`. Which answer is labelled A is set by the parity of
`sha256(seed:case)`. The prompt is:

```text
Two code reviews, A and B, were written for the change on this branch (base:
main, head: HEAD) in the current repository. Read the change yourself, for
example with `git diff main...HEAD`, and check each review against the code.
Grade substance only; ignore style, length and which tools were used. Do not
modify files or run tests.

For each review, list every distinct finding (a claimed defect, regression or
specific risk) and classify it:
- "valid": the code supports it as a real defect or a real, specific risk a
  maintainer should act on before merging;
- "minor": true but low impact, such as style, naming, comments or speculative
  hardening;
- "incorrect": contradicted by the code, or a defect that does not exist;
- "unverifiable": cannot be confirmed or refuted from this repository.
Then say which review better helps a maintainer decide whether this change is
safe to merge.

Return ONLY JSON: {"A": [{"finding": "short", "class": "valid"|"minor"|
"incorrect"|"unverifiable"}], "B": [...], "preferred": "A"|"B"|"tie",
"reason": "one short sentence"}

REVIEW A:
<<<
<redacted answer>
>>>

REVIEW B:
<<<
<redacted answer>
>>>
```

## Reported Measures

- Tokens: the sum of per-case medians. For Study 2, one run per arm, this is the
  sum of paired runs. Also the median per-case ratio, and the number of cases
  where QAMap used fewer tokens.
- Study 1: `found`, `partial` and `missed` counts per arm.
- Study 2: `valid`, `minor`, `incorrect` and `unverifiable` counts per arm, and
  the grader's preferences.
- Per arm: runs that started a test runner or install command, runs that stopped
  at a limit, and QAMap arm runs that did not run QAMap.

## Known Limits

- Pull request descriptions and human review comments are not used. This
  environment cannot reach the GitHub website or API, only Git.
- One host and one model are measured.
- The grader is a language model, and study 2 has no fixed ground truth.
- A later fix shows that a defect existed. It does not show that the defect
  could be found from the diff alone, so Study 1 recall can be low for both
  arms.
