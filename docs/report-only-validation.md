# Report-Only Review Validation

**Latest status:** literal-policy and large-change evidence are retained in the
strengthened regression cases. The actual paged-reader comparison also preserved
their predefined findings, but the large case used 401,557 tokens versus 76,822
standalone. The efficiency gate failed and stable publication remains blocked.
See [the complete follow-up results](release-validation.md#paged-delivery-follow-up).
Earlier passing samples below do not supersede this failure.

The gate tests whether the returned evidence is sufficient for a predefined
review, before spending model tokens. It does not judge a model or estimate
token savings. A truthful coverage warning is necessary, but cannot compensate
for a missing critical assertion or affected consumer.

## Frozen Cases

Six new synthetic cases cover shared-package consumers, separated edits in one
function, independent changes, async failure recovery, an equivalent refactor,
and runtime-selected modules. Required lines and expected test failures are
defined in `test/benchmarks/report-only-evidence/cases.mjs`, outside the
repositories under review. The cases are new to this measurement, not an
independent external benchmark. Once exposed, do not call them unseen holdouts
when tuning the engine against them.

Run a built checkout without any provider credentials:

```sh
node scripts/report-evidence-bench.mjs --output /tmp/qamap-evidence-results --assert
node scripts/report-evidence-bench.mjs --suite extended --output /tmp/qamap-extended-evidence-results --assert
node scripts/report-evidence-bench.mjs --suite confirmation --output /tmp/qamap-confirmation-evidence-results --assert
```

Use a fresh output directory outside the repository. Before analysis, the runner
saves the cases, criteria, runner, grader and build digests. It executes the
synthetic base/head tests separately to confirm the oracle. These tests are not
QAMap execution: each analysis must still report `not-run`.

Every case must retain all declared implementation, consumer and assertion
lines with exact file references and matching content hashes. Runtime module
choice must retain its explicit gap. Both analysis repetitions must preserve
the same response except generated report paths, stay within 16,384 bytes, and
leave source unchanged. There is no weighted score that can hide a critical
miss. `--assert` fails on insufficient evidence; this candidate gate is not
silently added to the existing CI baseline. Raw reports, test receipts and Git
bundles survive cleanup. The runner also preserves each exact stdout response
with its SHA-256 digest. `durationMs` measures local process elapsed time only;
it is not a token estimate, speed comparison, or general performance guarantee.
The historical runs below used the earlier 8,192-byte limit. The current build
also preserves declaration and binding context; a larger response must be
included in actual usage measurements rather than credited as a saving.

The first run on 2026-09-22 retained every obligation in async recovery, the
equivalent refactor and runtime-module uncertainty. Shared consumers retained
3/6 anchors, separated edits 2/3, and independent changes 4/6. All six responses
were repeat-stable, source-accurate and honest about static execution and limited
coverage. This is a failed evidence-readiness gate, not a measured model failure
rate or a token result. The criteria and original reports remain unchanged.

After the evidence-selection fix on the same date, all six cases passed twice:
27/27 required lines survived within both the 3,072-byte evidence limit and the
8,192-byte response limit. Selection now includes intermediate calls, multiple
changed regions, and fair turns for independent changes. Duplicate excerpts use
backward references within the returned response. The grader validates these
new fields using the same exact line and hash checks; malformed, forward or
orphaned references fail. The criteria digest is unchanged:
`ccc9b925cd0b9d727d2357571747d8128867c6be564fd20ecbc5d2436a25f63e`.

| Case | Before | After |
| --- | --- | --- |
| Shared consumers | 3/6 | 6/6 |
| Separated edits | 2/3 | 3/3 |
| Independent changes | 4/6 | 6/6 |
| Async recovery | 5/5 | 5/5 |
| Equivalent refactor | 3/3 | 3/3 |
| Runtime module choice | 4/4 | 4/4 |

These fractions count required source lines, not detected bugs or model review
accuracy. The fixtures are now regression tests rather than unseen evaluation
data. Their base/head tests independently confirmed all eight seeded failing
test names; the equivalent-refactor and runtime-example tests still passed.
QAMap itself continued to report static `not-run`. No additional model was called.

## Extended Evidence Gate

A second suite froze ten additional synthetic cases before running the same
build. It passed 6/10 cases on 2026-09-22, with stable results across both
repetitions. The original suite's pass is not a release-readiness verdict.

| Case | Tier | Required lines retained | Result |
| --- | --- | --- | --- |
| Aliased import and re-export | Ordinary | 3/3 | Pass |
| Assertion distant from the call | Ordinary | 2/3 | Missing expected value |
| Deletion-only guard removal | Ordinary | 2/3 | Missing surviving side effect |
| Multiline boolean guard | Ordinary | 4/4 | Pass |
| Swallowed exception | Ordinary | 3/3 | Pass |
| Equivalent constant refactor | Ordinary | 3/3 | Pass |
| Runtime-selected policy | Ordinary | 3/3 | Pass, uncertainty retained |
| One change among 1,203 files | Scale | 2/2 | Pass |
| Twelve independent changes | Scale | 8/24 | Eight paths omitted |
| One change with twelve consumers | Scale | 9/25 | Eight paths omitted |

Every base test passed. Head tests failed only the 30 named seeded test cases;
both controls passed. These are separate oracle executions, not tests performed
by QAMap. All responses stayed within 8,192 bytes, cited accurate source text
and hashes, and preserved static `not-run`, unknown coverage and zero analysis
model calls. The two ordinary misses occur without any omitted impact path:
path counts alone do not establish sufficient review evidence.

The distant expectation falls outside the call-site excerpt window. A
deletion-only change has no added line to anchor the excerpt, so selection
falls back to the declaration header instead of the deletion boundary. The
scale cases expose the bounded response's loss of distinct obligations. These
are evidence-selection failures, not measured model failures. The suite's
criteria digest is
`d09664e225e07e13b18d9d93345c658007af611eaeae12ce65d3b12484cc6bc2`.
Keep its initial failures when using these cases for subsequent fixes; they
are no longer unseen evaluation data.

### Evidence Fix Confirmation

The same ten-case criteria subsequently passed twice: **10/10 cases, 73/73
required lines**, still within 8,192 bytes. Deletion sites now preserve surviving
head-side code; a local syntax/binding pass connects distant test expectations.
The response allocates up to 7,168 bytes to evidence and 32 paths while reducing
optional summary detail. Exact repeated file hashes can be represented by one
aggregate SHA-256 digest of sorted `[file, fullFileSha256]` pairs. The grader
independently rebuilds that digest and still checks every exact required line.
Changed file contents, forged lines and malformed references fail; the criteria
digest and original failures above are unchanged. Smaller bytes are not measured
token savings.

Three further cases were frozen before running the updated engine: rounding
through an aliased consumer and a distant transformed expectation, two removed
guards in one declaration, and two independent equivalent refactors. All passed
twice, retaining **14/14 required lines** without further engine changes. Base
tests passed; head tests failed only the three declared regression tests, while
the equivalent-refactor control passed. These are author-created synthetic
confirmation cases, not external validation or a semantic false-positive score.

Self-review of the larger development diff exposed another bounded-excerpt
issue: surrounding context could exceed the per-excerpt byte limit even when
the required anchors fit. The selector now tries the anchors alone before
declaring the excerpt unavailable. Oversized required lines and instruction-like
source still fail closed. A regression test covers that distinction; full large-PR
coverage is not implied by this fix.

The local runner disables automatic Git maintenance only for its disposable
fixtures. An earlier measurement stopped on a fixture-cleanup error; that
attempt remains a harness failure, not a passed gate. Confirmation artifacts
use new directories and preserve all previous attempts.

### 0.5.0 Readiness

**Stable release remains on hold; local candidate packaging is allowed.**
The package target is now `0.5.0-rc.1`. Version synchronization is preparation,
not a publication or quality verdict. See the [remaining gates](releases/0.5.0.md#remaining-gates).
The six-pair completion-wait follow-up below provides sample-specific token
reductions, but does not resolve dynamic-policy or large-PR evidence gaps.
Neither a total pass percentage nor a small-case result compensates for missing
critical evidence.

- Implemented and checked: deletion-boundary selection, distant expectations,
  negative binding tests and preservation of all extended-suite obligations.
  Larger or unsupported changes can still be incomplete; a warning cannot
  justify a complete-review claim.
- The earlier 8 KiB local verification passed all three suites twice: 19 cases and 114/114
  required lines with unchanged criteria. The largest response was 8,105 bytes.
  These synthetic cases do not establish full-repository review quality.
- Run further model comparisons with separately authorized scope and actual usage
  receipts and frozen quality criteria. Do not count bytes as tokens or equate
  lower total tokens with lower uncached cost.
- After those quality gates pass, run the complete release checks and validate
  the exact packaged installation before publication. Prerelease packaging alone
  must not change the readiness verdict.

That earlier local build also passed 726 tests and the existing QA, repository,
context and execution benchmarks. Coverage was 91.73% lines, 88.76% branches
and 96.18% functions. Scan, plugin installation smoke tests and package dry-run
passed. These component checks are not a clean-checkout `release:check` or CI
verification of a new remote head. The measured follow-up below did not meet
the actual-usage and matching-quality release gate.

### Measured Follow-Up

An approved follow-up used GPT-6 Astra with medium reasoning and a shared
200,000 observed-token stop. The same request, tools, review limits and frozen
case were used in both conditions. Only the candidate had the report-review
skill. Discovery, consent, invocation and interpretation were counted from
request records and completion receipts; no byte-to-token estimates were used.

| Case | Standalone review | Report review, including consent | Status |
| --- | --- | --- | --- |
| Rounding through an aliased consumer | 46,460 | 50,902 | 4,442 more tokens, a 9.56% increase |
| Twelve independent changes | 51,549 observed | 51,515 | Budget gate failed; not a successful comparison |
| Twelve consumers of one shared change | Not run | Not run | Experiment stopped at the shared limit |

The ledger totaled 200,426 tokens across 16 model requests. The final usage
report arrived 426 tokens over the stop threshold. No further request or new
experiment attempt was started. The second baseline produced an answer and a
reconciled completion receipt, but the budget guard still rejected that attempt.
Its observed values remain evidence, not a passed pair or a savings claim.
Monetary cost and subscription deductions were not measured.

Both conditions identified the known mismatch in the first case, and both
identified all twelve affected calculation/test pairs in the second. However,
the report-only answers made their findings conditional on omitted context.
The aliased consumer's import was missing. Under pressure, the twelve-function
response retained each changed return and assertion but omitted each function
declaration and test import. Path counts and required-line checks passed, yet
the model lacked the context needed for equally definite reasoning. This is
not evidence of quality parity, nor a measured general defect-recall rate.

A separate post-hoc context audit confirmed two missing import lines in the
first case, and twelve missing declarations plus twelve missing imports in the
second. These checks do not retrospectively replace the frozen criteria or
invalidate the accurate 114/114 line-preservation result. They show why that
gate alone was insufficient. Original results and failed attempts are retained.

The next evidence gate must cover a connected reasoning unit: declaration and
relevant preconditions, binding or re-export links, consumer call and assertion.
When the response cannot carry that unit, mark the review scope unsupported
rather than count isolated lines as sufficient. First-use consent and an
established user preference are also separate usage conditions; measure both
from real receipts instead of subtracting an estimated consent cost. The
default report-only release remains on hold.

## Context And Preference Follow-Up

A separate 2026-09-22 run removed the token cap with user authorization. It froze
ten pairs on GPT-6 Astra medium before model execution, using fresh sessions,
the same request and tools, and six known synthetic case types. Three cases were
repeated in the opposite order. Nine pairs used an explicitly saved report-review
preference; the last included first-use consent. These are not unseen holdouts.

Short declaration bodies and module bindings now survive compaction. The response
limit increased to 16,384 bytes; that extra context is included in measured usage.
All ten actual responses passed the expanded, predeclared context checks. The
reviewers identified the seeded implementation/test mismatches with correct
affected-file references, preserved policy uncertainty and stayed `not-run`.
The equivalent refactor produced no invented bug. This is author-reviewed
synthetic evidence, not an independent blind assessment of general review quality.

| Pair | Standalone total | Report-review total |
| --- | ---: | ---: |
| Rounding chain | 46,611 | 39,632 |
| Twelve independent changes | 69,122 | 42,479 |
| Twelve shared consumers | 63,214 | 42,314 |
| Aliased re-export | 46,205 | 39,563 |
| Equivalent refactor | 46,160 | 51,799 |
| Runtime policy choice | 46,262 | 39,329 |
| Rounding, repeated | 47,167 | 39,592 |
| Independent changes, repeated | 71,184 | 29,045 |
| Shared consumers, repeated | 63,304 | 42,330 |
| Rounding with first-use consent | 46,982 | 38,184 |

Nine pairs used fewer total tokens; one used more. The configured-use totals were
499,229 versus 366,083, but uncached input increased from 141,999 to 143,859. Do not
describe this as lower monetary cost or subscription deductions. The separate
first-use total includes 11,671 consent tokens and 26,513 review tokens. Across
both conditions, all attempts totaled 950,478 tokens and 74 model requests, with
request increments reconciled to completion receipts. Parent development work
is not included.

The equivalent-refactor candidate yielded its execution tool after one second,
then used another model request to wait for completion. That failed pair remains
in the results. Local coverage checks overlapped part of this experiment, so CPU
load was not controlled and elapsed time is not compared. A subsequent change
requests a 30-second initial foreground wait; it needs its own measurement, not
the deletion of this failure.

The runtime-policy answers also expose a remaining quality boundary. Standalone
review inspected the concrete policy file used by the known test. Report review
did not receive that file. Both avoided unsupported defect claims, but this is
not evidence of equally complete reasoning. Likewise, the large development diff
still omitted many paths and long-declaration context. The default report-only
release remains on hold; these limits cannot be hidden by the aggregate reduction.

### Completion-Wait Follow-Up

A separately frozen six-pair run tested the revised foreground-wait guidance.
The engine's evidence selection did not change. It repeated the equivalent
refactor three times, then reviewed rounding, twelve independent changes and
twelve shared consumers once each. All used an explicitly saved report-review
preference, fresh sessions and the same model, request and tools. No heavy local
verification was run concurrently.

| Pair | Standalone total | Report-review total |
| --- | ---: | ---: |
| Equivalent refactor 1 | 46,275 | 25,727 |
| Equivalent refactor 2 | 46,034 | 39,182 |
| Equivalent refactor 3 | 46,297 | 39,360 |
| Rounding chain | 46,860 | 26,212 |
| Twelve independent changes | 69,074 | 29,018 |
| Twelve shared consumers | 49,207 | 42,592 |

All six pairs met the predeclared finding, citation and execution-state criteria
with fewer total tokens. The totals were 303,747 versus 202,091, a 33.47% reduction
for this sample. Actual candidate calls used `yield_time_ms: 30000`; none required
a separate completion-wait call. Three candidates read the skill first and three
used the generated instructions directly, so requests still varied from two to
three. This is observed host behavior, not something the skill can enforce.

Total uncached input was 131,153 versus 96,200, but it increased in two individual
pairs. Monetary cost and subscription deductions were not measured. This run
used 505,838 tokens and 40 requests; combined with the preceding ten-pair run,
the experiments used 1,456,316 tokens and 114 requests. Do not pool the two builds
into a new-version savings percentage. A missing local verification receipt
blocked the initial follow-up launch before a model process started; that log is
preserved separately from the completed run.

These are four known synthetic case types, not external validation. Finding
meaning was checked against source and executed fixture oracles by the author,
not a blind independent judge. The runtime-policy evidence gap and large-PR
omissions remain unresolved. The supported examples demonstrate a lower-token
path, not unconditional quality parity or readiness for a default-only release.

### Lossless Inline Follow-Up

The subsequent completeness and caller experiments are recorded in
[Release validation](release-validation.md#lossless-inline-follow-up), including
the truncated archive attempt and the 401,557-token paging failure. Those
failures are retained rather than subtracted from usage or relabeled as savings.

The new, separately frozen two-pair run retained all required lines and findings
with 46,301 versus 41,300 tokens for the concrete dynamic policy and 84,518 versus
30,563 for 160 independent changes. All four attempts completed without retry.
Actual model-visible output, rather than only saved files, was audited for
truncation, exact source lines and lossless reconstruction. Both conditions kept
execution `not-run`; the candidate made no independent source-reading pass.

The implementation factors repeated literal text and keeps every differing row.
This is neither lossy summarization nor semantic grouping. It fits this large
synthetic report into one 13,055-byte response and removes eight archive reads.
Irregular evidence that does not fit keeps the checked-page fallback. No actual
token result is available for that heterogeneous fallback on the new build.

This run used the same model at medium effort and preselected report mode, not
first-use consent. Its 202,682 total tokens cover all 14 requests and final
answers, but exclude the parent engineering conversation. The large candidate's
uncached input rose from 14,041 to 21,314; total-token savings do not establish
lower monetary cost. Quality passes refer to frozen findings and citations, not
identical explanation: the candidate reported missing historical context that
standalone review read directly. Independent external quality, mixed-structure
large PRs and repeated-run reliability remain unproven.

## Subsequent Model Comparison

Only after evidence readiness, separately approve a model budget. Freeze the
same review obligations and inputs for both conditions. Count discovery,
consent, invocation, interpretation and failures from actual usage receipts.
Missing telemetry or infrastructure failures make a run ineligible, not zero
cost. Preserve every attempt; never subtract an estimated failure cost.

Begin with one pair per case. If the fixed suite meets the quality gates,
extend every case to three pairs with balanced execution order. Report all
case totals, medians and worst outcomes, plus cached and uncached input. Three
repeats are an exploratory reliability check, not a statistical guarantee.
Judge anonymized answers against the frozen obligations and executed oracle;
list valid unexpected findings separately rather than forcing them into the
seeded-defect count. Unknown evidence never substitutes for a missed known bug.

Do not merge a default report-only workflow on a token reduction alone. Resolve
critical evidence gaps and verify consent/refusal, failures, stale reports and
no unauthorized follow-up reads. A release savings claim additionally requires
quality-preserving lower measured usage across the declared supported cases;
one successful case, fewer bytes, or passing offline tests cannot establish it.
