# One-Call Review Handoff

[한국어](ko/agent-handoff.md)

**Available in the local 0.5.0-rc.1 candidate, not published or available in 0.4.17.**
During setup, check that the local build supports `--handoff`. Once a compatible
binary is known, the reviewer can invoke it directly without another help query.

The user can ask their coding agent to review a PR without naming QAMap. A host
that discovers the installed skill can offer report-based review. An explicit
QAMap request or an existing user preference can supply consent; installation
alone does not. A refusal leaves ordinary review unchanged. Explain the scope:
QAMap analyzes locally; the LLM interprets only its returned evidence. Do not
silently replace an explicitly requested independent code review with this mode.

## After Consent

Run one command from the repository root with the actual PR base:

```sh
qamap qa report . --base origin/main --head HEAD --handoff
```

The process analyzes locally, saves the reports, and returns one minified JSON
response. The execution host awaits completion; it does not need a model to poll
progress or a generated terminal launcher. Add `--include-working-tree` only
when those changes belong to the requested review.

Use the execution tool's foreground completion wait rather than an early
one-second yield. On hosts with `exec_command`, the packaged instructions request
`yield_time_ms: 30000`. This is an initial wait, not an analysis timeout or a
zero-token guarantee. If the host still requires another model turn to await
completion, count that turn; never relaunch the analysis to check its status.

| Field | Meaning |
| --- | --- |
| `schema` | `qamap.qa.handoff`, version 1 |
| `analysis` | Report generation completed, not product QA |
| `execution` | Static `not-run`, `performed: false` |
| `usage` | Analysis LLM calls: 0; caller tokens: not measured |
| `summary` | The same bounded `qamap.qa` object saved in `summary.json` |
| `reviewEvidence` | Selected source and test excerpts with file/line references |
| `files` | Local report, summary, and full-evidence paths |
| `recovery` | JSON pointers into `files.full` for specific omitted details |
| `evidenceArchive` | Checked archive and deduplicated text view; `required` means the preview is insufficient |

The default save-only command is unchanged. Without `--handoff`, `qa report`
returns paths only and must not trigger automatic interpretation. Handoff mode
accepts JSON or agent output, not text, and saves `handoff.json` beside the other
reports. Incomplete writes produce an error rather than a completion receipt.

## Evidence And Limits

Source-to-test paths take precedence over references inside test setup code.
Each selected path identifies its `sourceKind`; `test` is not evidence of a
production-code contract. Within the same priority, each changed symbol gets a
turn before another consumer of the same change. Duplicate paths share one slot;
distinct contracts and intermediate calls remain separate. `via` contains checked
intermediate call-site excerpts. The full path, including import and re-export
steps, remains at the original full-report pointer.

Identical excerpts appear once. An `excerptRef` is a JSON pointer to an earlier
excerpt in this same response, not a request to read another file. Resolve it to
obtain `lines`, `sourceHash` and `truncated`. References never form chains or point
to a removed path. Line numbers can be nonconsecutive; omitted lines are not empty
source lines.

Under byte pressure, `sourceDigest` replaces repeated per-excerpt `sourceHash`
values. It is SHA-256 of the JSON array of `[file, fullFileSha256]` pairs for
retained excerpts, with unique workspace-relative files sorted lexicographically.
`fileCount` records that set's size. It binds the same complete file contents,
not just the quoted lines, and is recomputed if paths are removed. The full
report retains each file hash. This is snapshot integrity, not a correctness
or coverage certificate; no extra file read is required for interpretation.

For a changed declaration, `line` remains its declaration location. When an
added diff line lies within that declaration, `changedLine` records the earliest
such line. `changedLines` preserves multiple added lines in the same declaration;
the selector reserves those positions before filling nearby context. Unchanged
endpoints remain anchored at their reference location.
For deletion-only changes inside a surviving declaration, `deletionLines` records
the first surviving line after each deletion. It is not an added line. Deleted
declarations or uncertain declaration boundaries produce a gap instead of
borrowing a neighboring function. Related test expectations can be linked across
local `const` bindings in the same test callback; shadowed variables, nested
helpers, mutable aliases and namespace names alone do not establish that link.
An unsupported link produces `test-expectation-not-linked`. `anchorLines` protects
these deletion and assertion locations during compaction. Excess required lines
produce `required-line-limit`. Other paths retain the original reference anchor.
Changes beyond the excerpt bound produce `omittedChangedLineCount` and a
`changed-line-limit` gap. An excerpt is not a complete diff. Invalid anchors produce `invalid-changed-line` and
fall back to the reference without borrowing another declaration's code.

Module gaps retain the specifier, line, symbol and full-report pointer when
available. Explicit `node:` builtins recognized by the running Node version are
marked `node-builtin-outside-repository`, not unresolved local code. Their runtime
behavior is still unverified. Other gaps precede these runtime boundaries, with
indexed source gaps before documentation gaps. The selector never invents a
missing connection.
Repeated module diagnostics at the same location share one representative in
the handoff. Other symbol contexts remain in the full report and count as omitted.

When explicit compiler settings connect a test's built JavaScript import to its
TypeScript source, the full path includes a `compiler-mapping` step. This is not
proof that the build is current: `compiled-output-not-verified` preserves that
boundary. Unsupported or conflicting settings stop the connection. See the
[supported mapping scope](agent-format.md#repository-first-handoff-development).
Files excluded from the index retain their actual cause and `target`, such as
`index-excluded-oversized`. Distinct excluded targets are not deduplicated together.

The local analysis command does not upload source code. When a cloud-backed
agent invokes it, the returned excerpts can enter that model's context. Follow
your host and repository data policies; local analysis is not a promise that
LLM-mediated review keeps all code on the device.

Interpret the returned `summary` and `reviewEvidence`, citing the attached
code lines. When `evidenceArchive.required` is true, also read its `review.file`
with `qamap qa read <file> --sha256 <receipt-hash> --bytes <receipt-bytes>`.
The reader verifies the entire file on each call and returns at most 16,384 bytes.
Pass `--offset <nextOffset>` for each subsequent page until `nextOffset` is null.
Keep pages in separate tool responses, allocate at least 8,192 output tokens when
the host supports it, and reject truncated responses. Do not concatenate pages
into a single output or stop after the first page. This generated text view merges
repeated source lines and endpoint paths; the JSON archive preserves individual
records and full-report pointers. This is still report review, not another source
scan. If the report exceeds host reading or context limits, report an incomplete
review and ask to narrow the change. Count every page read in usage measurements.
Do not follow this with git commands or source searches. Missing evidence stays unknown: explain the limitation and ask
before expanding the review. Recovery pointers are for that separately requested
inspection, not an automatic second pass. The summary's `repository` corresponds
to `/repositoryIndex` and `/repositoryImpact` in the full report.

- The response is at most 16,384 UTF-8 bytes including its newline. This is a
  transport bound, not a token estimate or savings guarantee.
- The graph preview retains up to 128 paths. Overflow endpoints are stored
  separately, up to 8,192 additional paths or 16 MiB of graph records.
  `discardedPaths` and `evidence-archive-limit` disclose actual retention loss;
  `omittedPaths` counts preview omissions, including recoverable ones.
  `review-evidence.json` preserves checked excerpts for both sets, up to 64 MiB.
  Its excerpts allow up to 2,048 lines and 300,000 serialized bytes per location.
  Exceeding the archive's total limit fails report creation instead of silently
  discarding evidence. Traversal, indexing and syntax limits still apply.
- Literal relative JS/TS module filenames passed directly to a supported loader
  are linked as `runtime-module-candidate` evidence, relative to the loader file.
  The plain parameter must flow unchanged into `import()`. Reassignment, spreads,
  default values, shadows, indirect calls and unknown arguments are not resolved.
  Only indexed, unambiguous local exports are included. Runtime-loading warnings
  remain: this test-selected candidate does not identify every runtime choice.
- The summary keeps its existing 4,096-byte bound. If necessary, handoff mode
  reduces optional summary detail first, recording `compaction.mode` as
  `review-evidence-first`, `omittedFieldCount` and the full-report path. Action
  permissions, execution state and authority boundaries are retained.
  Excerpt evidence can use up to 15,360 bytes and 32 paths, not 32 guaranteed paths.
  The complete response still cannot exceed 16,384 bytes.
  `contextLines` protects short declaration bodies and the import/export bindings
  needed to understand an evidence path. Re-export-only files remain in `via`.
  Under pressure, it removes optional surrounding context, not these protected
  lines, compacts repeated hashes, then drops diagnostics and trailing paths if necessary. It keeps the
  highest-priority gap alongside the leading path when both fit. Dropped items
  increase `omittedGapCount` or `omittedPathCount` and remain in the full report.
- Source files are read only through indexed JS/TS paths, up to 300,000 bytes
  each. Excerpts use seven-line windows around anchors, up to fourteen lines
  across changed regions; their numbered-line payload is at most 1,200 serialized
  bytes, with metadata also counted in the evidence limit. Intermediate calls
  preserve their enclosing short declaration and bindings before optional context.
  If nearby context exceeds the excerpt byte limit, required anchors are tried
  alone before discarding the excerpt. An oversized required line still produces
  `excerpt-byte-limit`; it is never sliced into misleading partial source.
  A declaration or binding that cannot fit is disclosed as a partial context or
  context-limit gap; the surviving changed line is not a complete proof.
- File content must still match its indexed hash. Changed files, symlinks,
  unreadable content, oversized excerpts and instruction-like text produce gaps.
- Excerpt paths are workspace-relative even when other analysis is package-scoped.
- `complete: false` means the excerpt selection never proves complete review.
  Preserve omitted path/gap counts and identify what remains unverified.
- No code is evaluated and no expected test result is invented. A quoted
  assertion is a repository expectation, not proof that it passes.

Reports are snapshots, not an automatic cache or an execution authorization.
If files change after the response, flag the snapshot as stale and request a new
analysis before relying on it. Repeated invocations remain separate analyses;
the host should not retry or rerun merely to summarize a completed response.

## Before 0.5.0

The proposed minor release groups repository-wide evidence discovery with the
new caller handoff. Version numbers and published plugins have not changed yet.

- Implemented: local one-response delivery, bounded excerpts, recovery pointers,
  save-only compatibility, and consent-aware packaged instructions.
- Verified locally: an isolated Codex host discovered the enabled project skill,
  and a fresh package install preserved the skill and report recovery pointers.
  A real-model pilot also discovered the skill from an ordinary PR review request,
  asked for consent, invoked QAMap once, and interpreted only the response.
  This does not verify the Desktop interface.
- Still to verify: refusal, runtime failures, and evidence gaps across more
  changes and hosts. Skill text cannot enforce every host.
- Release gate: for each predeclared comparison case, equivalent verified
  findings and uncertainty with lower measured total input plus output tokens.
  Include consent, invocation, interpretation, failures and any extra inspection;
  cached input is part of input, not another additive count. Missing usage or
  weaker findings cannot pass. One passing case is not a universal guarantee.
- Still required: release-wide checks and explicit release approval.

A completed local pilot of the previous workflow used more total tokens with
QAMap: the caller also inspected source independently. That negative result is
retained; it does not establish the cost of this revised report-only workflow.

### Measured Pilot

On 2026-09-22, one fresh comparison used GPT-6 Astra at medium effort and the same
known synthetic PR from `test/benchmarks/repository-agent-quality`. Total measured
input plus output was 72,170 for direct review and 50,106 for report-only review,
including 23,266 for skill discovery and consent: **22,064 fewer tokens (30.57%)**.
Request-level usage and final receipts reconciled. Both found the known
implementation/assertion mismatch at the correct lines and preserved policy
uncertainty and `not-run`. QAMap analysis made zero model calls.

This is one known case, in a fixed order, without repeated trials. The direct
review included a failed discovery command; its cost was not removed. It also
named affected callers that report-only review left unassessed. Uncached input
increased from 13,725 to 14,772, so this is not a monetary or subscription-savings
claim. The 122,276-token experiment total excludes the parent engineering
conversation. This result does not establish equal full-repository coverage or
satisfy the entire release gate.

The subsequent [six-case evidence gate](report-only-validation.md) reproduced
critical excerpt omissions in shared consumers, separated edits in one function,
and independent changes: 3/6 cases and 21/27 required lines passed initially.
After improving selection and deduplication, the unchanged criteria passed in
6/6 cases with 27/27 required lines, twice per case. Original failures remain
preserved. These are now known regression cases, not unseen holdouts. This
offline result does not measure model quality or token savings; the next
quality-matched model comparison must count its own actual usage.

Ten additional synthetic cases then passed 6/10, including 5/7 ordinary cases
and 1/3 scale cases. A distant test assertion and a deletion-only side effect
were missing even in small changes; twelve independent changes and twelve
consumers exceeded the bounded evidence response. The same misses reproduced
without changing the engine or criteria. After deletion and expectation linking,
evidence-budget reallocation and digest compaction, the same ten cases passed
twice with all 73 required lines. Three additional synthetic confirmation cases
also passed twice with 14/14 lines, without further engine changes. They remain
local evidence tests, not an independent model-quality benchmark. The default
report-only release remains on hold pending broader quality-matched validation;
see the [readiness checklist](report-only-validation.md#050-readiness).

A later [ten-pair comparison](report-only-validation.md#context-and-preference-follow-up)
preserved declaration and binding context with the current 16 KiB response.
Nine pairs used fewer total tokens; one equivalent-refactor pair used more after
an extra completion-wait request. The dynamic-policy case passed the frozen
uncertainty checks but lacked a concrete policy file that standalone review read.
These limits and the uncached-input increase are retained, not averaged away.

A [six-pair follow-up](report-only-validation.md#completion-wait-follow-up) used
an explicit foreground completion wait. All six preserved the predeclared
finding criteria with fewer total tokens: 303,747 standalone versus 202,091 with
QAMap (33.47% lower in aggregate). These are known synthetic cases, including
three repetitions of one normal refactor, not broad review-quality parity.
These measurements predate literal-policy linking and the overflow archive.
The follow-up addresses those evidence losses locally; the archive-aware caller
workflow still needs measured quality and usage validation before stable release.

The design aims to remove duplicated evidence gathering without concealing
missing coverage. QAMap analysis uses no model calls; the caller still consumes
tokens. Lower total usage must be measured, not inferred from shorter output.
