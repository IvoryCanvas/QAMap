# One-Call Review Handoff

[한국어](ko/agent-handoff.md)

**Development feature, not available in 0.4.17. Proposed release target: 0.5.0.**
Use a local build whose `qamap qa --help` lists `--handoff`.

The user can ask their coding agent to review a PR without naming QAMap. A host
that discovers the installed skill can offer a local first pass. An explicit
QAMap request or an existing user preference can supply consent; installation
alone does not. A refusal leaves ordinary review unchanged.

## After Consent

Run one command from the repository root with the actual PR base:

```sh
qamap qa report . --base origin/main --head HEAD --handoff
```

The process analyzes locally, saves the reports, and returns one minified JSON
response. The execution host awaits completion; it does not need a model to poll
progress or a generated terminal launcher. Add `--include-working-tree` only
when those changes belong to the requested review.

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

The default save-only command is unchanged. Without `--handoff`, `qa report`
returns paths only and must not trigger automatic interpretation. Handoff mode
accepts JSON or agent output, not text, and saves `handoff.json` beside the other
reports. Incomplete writes produce an error rather than a completion receipt.

## Evidence And Limits

Source-to-test paths take precedence over references inside test setup code.
Each selected path identifies its `sourceKind`; `test` is not evidence of a
production-code contract. Equivalent source/endpoint pairs share one excerpt
slot; distinct symbols and contract locations remain separate. Omitted paths
remain in the full report with their original indexes.

Module gaps retain the specifier, line, symbol and full-report pointer when
available. Explicit `node:` builtins recognized by the running Node version are
marked `node-builtin-outside-repository`, not unresolved local code. Their runtime
behavior is still unverified. Other gaps precede these runtime boundaries, with
indexed source gaps before documentation gaps. The selector never invents a
missing connection.
Repeated module diagnostics at the same location share one representative in
the handoff. Other symbol contexts remain in the full report and count as omitted.

The local analysis command does not upload source code. When a cloud-backed
agent invokes it, the returned excerpts can enter that model's context. Follow
your host and repository data policies; local analysis is not a promise that
LLM-mediated review keeps all code on the device.

Use the attached material first instead of reading `summary.json` again. Verify
important findings against the cited excerpts. When more information is needed,
use `recovery` pointers: the summary's `repository` corresponds to
`/repositoryIndex` and `/repositoryImpact` in the full report.

- The response is at most 8,192 UTF-8 bytes including its newline. This is a
  transport bound, not a token estimate or savings guarantee.
- The summary keeps its existing 4,096-byte bound. Excerpt evidence has a
  separate 3,072-byte bound and at most two complete source/endpoint pairs.
  Under pressure, it retains the strongest pair when that pair fits alone;
  dropped diagnostics increase `omittedGapCount` and remain in the full report.
- Source files are read only through indexed JS/TS paths, up to 300,000 bytes
  each. An excerpt contains at most seven lines and 1,200 serialized bytes.
- File content must still match its indexed hash. Changed files, symlinks,
  unreadable content, oversized excerpts and instruction-like text produce gaps.
- Excerpt paths are workspace-relative even when other analysis is package-scoped.
- `complete: false` means the excerpt selection never proves complete review.
  Preserve omitted path/gap counts and inspect relevant missing evidence.
- No code is evaluated and no expected test result is invented. A quoted
  assertion is a repository expectation, not proof that it passes.

Reports are snapshots, not an automatic cache or an execution authorization.
If files change after the response, reassess relevant evidence. Repeated command
invocations remain separate analyses; the host should not retry or rerun merely
to summarize a completed response.

## Before 0.5.0

The proposed minor release groups repository-wide evidence discovery with the
new caller handoff. Version numbers and published plugins have not changed yet.

- Implemented: local one-response delivery, bounded excerpts, recovery pointers,
  save-only compatibility, and consent-aware packaged instructions.
- Still to verify: real-host skill discovery, consent/refusal behavior and
  process waiting. Skill text alone cannot enforce every host's behavior.
- Still to measure: total invocation, consent, interpretation and further-review
  tokens on isolated matched-quality comparisons, including regressions.
- Still required: release-wide checks and explicit release approval.

The design aims to reduce duplicated evidence gathering while preserving review
quality. It does not promise lower model usage, replace independent reasoning,
or prevent wider inspection when the evidence is incomplete.
