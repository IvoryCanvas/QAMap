# External Review Benchmark Results

These results follow [the registered protocol](PROTOCOL.md). The protocol and
the selected cases were committed before any host run. Per-run records are in
`results.json`.

On public pull requests, QAMap 0.5.1 cut host tokens by about half. The review
quality did not keep up with the standalone host: the grader preferred the
standalone review more often, and the QAMap arm found one fewer later-fixed
defect. The internal suite's result, fewer tokens with equal or better quality,
does not carry over to these cases.

## Setup

- Twelve repositories, all eligible under the registered rule. Eight are
  TypeScript or JavaScript, two Python and two Go.
- Study 1 needed its registered fallback. Only six pairs were kept, from
  `twentyhq/twenty`, `go-gitea/gitea` and `outline/outline`. Both `twenty`
  cases were introduced in June 2026, before the main window. The other eight
  repositories had no qualifying pair.
- Study 2 has 24 cases, two per repository.
- Host: Claude Code CLI 2.1.283 in print mode, one fixed model for both arms.
  The QAMap arm used the published `@ivorycanvas/qamap@0.5.1`. Grading used a
  different fixed model.
- All 72 host runs completed. None stopped at the turn or time limit.

## Tokens

| Study | Cases | Standalone | QAMap | Change | Cases where QAMap used fewer |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1, later-fixed regressions (median of 2 runs) | 6 | 16,706,014 | 7,724,259 | -53.8% | 6/6 |
| 2, seeded random pull requests (1 run) | 24 | 53,726,488 | 27,580,146 | -48.7% | 21/24 |

- Study 2 by pool:
  - TypeScript: -45.2%, fewer in 14 of 16 cases.
  - Python: -64.3%, fewer in 4 of 4.
  - Go: -48.5%, fewer in 3 of 4.
- The median per-case ratio was 0.470 in Study 1 and 0.492 in Study 2.
- QAMap used more tokens in three Study 2 cases:
  - `caddy-8003`: +31.0%
  - `excalidraw-11872`: +10.1%
  - `twenty-24938`: +6.2%
- The host's list-price estimate was $13.10 standalone against $7.40 with QAMap
  in Study 1, and $23.07 against $13.70 in Study 2. This is not billing.

## Quality

Study 1 asked whether each review stated the defect that the project fixed
later. There were 12 runs per arm.

| Verdict | Standalone | QAMap |
| --- | ---: | ---: |
| Found | 3 | 2 |
| Partial | 4 | 5 |
| Missed | 5 | 5 |

Both arms found the `outline-13597` shell-quoting defect in both runs. Only one
standalone run found `gitea-38517`.

Study 2 grading was pairwise, in the repository, with read-only tools.

| Measure | Standalone | QAMap |
| --- | ---: | ---: |
| Preferred review | 15 | 9 |
| Valid findings | 15 | 12 |
| Minor findings | 80 | 82 |
| Incorrect findings | 6 | 9 |
| Unverifiable findings | 2 | 2 |

There were no ties. With 24 cases, a 15-to-9 split is not statistically
conclusive: a two-sided sign test gives p = 0.31. It does not show that QAMap
keeps quality, either.

By the grader's reasons, only the standalone review found a real problem in
five cases, and the QAMap review missed it or judged the code safe:
`documenso-3159`, `outline-13272`, `twenty-24299`, `gitea-39001` and
`pydantic-13523`. In `formbricks-9253`, the QAMap review raised the defect only
as an open question. Only the QAMap review found a real problem in three cases:
`formbricks-9141`, `immich-31424` and `excalidraw-11838`.

## Other Observations

- The standalone arm started a test runner or installed packages in 3 of 36
  runs, despite the static-review prompt. The QAMap arm did so in none.
- In `twenty`, the largest repository, `qamap qa brief` took longer than the
  30-second limit the host set for the command in 5 QAMap runs. The host moved
  the command to the background and waited. In one of them,
  `twenty-21684` run 1, the session ended while waiting and produced no review.
  It is counted as missed.
- Every QAMap arm run ran QAMap. No standalone run did.

## Deviations From The Protocol

- **Answer capture.** When a background task finished after the review, the host
  ended a second turn with a short acknowledgement. The harness first stored
  only the last turn, so one QAMap review was graded on the acknowledgement. The
  harness now stores every ended turn in order. The stored answers were rebuilt
  from the transcripts, and the one changed run was graded again (`missed` to
  `partial`).
- **Host tools.** The protocol lists Bash, Read, Grep, Glob and Skill. This host
  version also exposed background-task tools, including Monitor, ScheduleWakeup
  and TaskStop. The harness did not disable them, in either arm.
- **Environment fault.** During the Study 2 `gitea` runs, the container's
  `/dev/null` stopped being a device. Its cause was not established. Two
  standalone `gitea` runs had Git failures, and the `caddy-8003` fixture could
  not be built. All eight runs of the four `gitea` and `caddy` Study 2 cases
  were set aside and repeated. The harness was changed so that Git
  configuration and standard input no longer depend on `/dev/null`. The set-aside
  runs are not in `results.json`. Earlier runs finished before the fault, and
  their transcripts show no Git failure.
- **Detection rules.** Test execution and QAMap use are now counted from the
  command word. The first version also counted `test -f`, a `|` inside a quoted
  grep pattern, and temporary directory names containing `qamap`.

## Limits

- One host and one model were measured.
- Pull request descriptions and human review comments were not available.
- Study 1 has six cases from three repositories.
- A language model graded both studies. The answers were redacted, but the
  QAMap arm's wording may still be recognizable.

## Re-Measurement With The Changed QAMap

This follows the [re-measurement protocol](PROTOCOL.md#re-measurement-registered-2026-10-06).
The changes targeted two problems the first run found:
- the brief cut removed lines and hid unchanged lines between hunks, and its
  wording was over-trusted;
- the brief was slow on the largest repository and was run with a 30-second
  host timeout.

The changed package was packed from commit `76c8152` of
`fix/review-brief-checks`. All three arms ran in rotation on Claude Code CLI
2.1.291 with the same fixed model. Every one of the 144 runs finished, and
every run was graded. Per-run records are in `results-v2.json`.

Two runs stopped at the 30-minute limit, one standalone and one with the
changed QAMap. Both are counted as empty reviews:
- `s2-immich-30612`, standalone: 78 requests.
- `s2-astro-17812`, changed QAMap: the brief printed in seconds, then the host
  searched the whole file system.

A stopped run has no final usage receipt. Its main-loop request usage is
counted as a lower bound.

### Tokens

| Study | Cases | Standalone | QAMap 0.5.1 | Changed QAMap |
| --- | ---: | ---: | ---: | ---: |
| 1, later-fixed regressions (median of 2 runs) | 6 | 20,803,791 | 9,084,342 (-56.3%) | 9,552,306 (-54.1%) |
| 2, seeded random pull requests | 24 | 56,784,259 | 27,376,632 (-51.8%) | 31,187,159 (-45.1%) |
| 3, held out | 12 | 22,226,994 | 11,663,137 (-47.5%) | 13,242,861 (-40.4%) |

The changed QAMap used fewer tokens than standalone in 6 of 6, 23 of 24 and 10 of
12 cases. It used 5-14% more than 0.5.1, because it reads more before
concluding. That was the intended trade.

### Quality

Study 1 counts runs that stated the defect the project fixed later, out of 12
per arm:

| Verdict | Standalone | QAMap 0.5.1 | Changed QAMap |
| --- | ---: | ---: | ---: |
| Found | 5 | 2 | 2 |
| Partial | 2 | 3 | 3 |
| Missed | 5 | 7 | 7 |

Studies 2 and 3 are pairwise blind grades. Each cell gives wins for the first
arm, wins for the second, and ties.

| Pair | Study 2 | Study 3 (held out) | Both |
| --- | ---: | ---: | ---: |
| Changed QAMap vs standalone | 10 : 11 : 3 | 6 : 4 : 2 | 16 : 15 : 5 |
| QAMap 0.5.1 vs standalone | 13 : 11 : 0 | 4 : 7 : 1 | 17 : 18 : 1 |
| Changed QAMap vs QAMap 0.5.1 | 10 : 10 : 4 | 6 : 3 : 3 | 16 : 13 : 7 |

Incorrect findings within each pair (first arm, second arm), Studies 2 and 3
together:

| Pair | Incorrect findings |
| --- | ---: |
| Changed QAMap vs standalone | 6 vs 15 |
| QAMap 0.5.1 vs standalone | 9 vs 8 |
| Changed QAMap vs QAMap 0.5.1 | 4 vs 6 |

Valid findings were 19 against 21 for changed QAMap against standalone.

None of the preference splits is statistically conclusive. Two-sided sign
tests give p from 0.51 to 1.00. On the held-out study, the changed QAMap was
preferred over standalone (6 to 4) and over 0.5.1 (6 to 3), and it made no
incorrect finding.

The same comparison of 0.5.1 against standalone came out 9 to 15 in the first
run and 13 to 11 here. Single-run quality comparisons of this size move by
several cases between runs. Study 1 did not improve: standalone found more
later-fixed defects than either QAMap arm.

### Speed

- **Host waits.** Across its 48 runs, the changed QAMap was never moved to the
  background. QAMap 0.5.1 was moved 5 times, standalone 2 times.
- **Brief time.** On the profiled fixtures, briefs on the largest repository
  went from 47-106 s to 31-67 s. Smaller repositories went from 10-14 s to
  8-10 s. Output was byte-identical except where the repository index reaches
  its file cap.

### Limits

- One host and one model.
- One run per arm in Studies 2 and 3, and an LLM grader.
- Six Study 1 cases from three repositories.
- The changed QAMap was designed after reading the Study 1 and 2 failures, so
  only Study 3 is independent of that design.
