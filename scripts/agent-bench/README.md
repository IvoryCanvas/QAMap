# Optional Repository Cache Arms

The existing `agent-bench.config.json` and `generic`/`qamap` arms retain their
workflow. `agent-repository-bench.config.json` opts into six repository tasks and
provider adapters with `generic`, `qamap-cold`, and `qamap-warm`. All QAMap arms
have identical tool schemas. Every arm receives the identical system/task
prompts, turn/output limits, and model. No extra agent engine is involved.

With an already compiled checkout, exercise the harness offline:

```sh
node scripts/agent-bench.mjs --config agent-repository-bench.config.json --dry-run --runs 1 --assert --format json
```

A real measurement uses the same command without `--dry-run`, only after the
operator explicitly configures `QAMAP_BENCH_PROVIDER`, `QAMAP_BENCH_MODEL`, and
`QAMAP_BENCH_API_KEY`. It can incur provider charges. Without configuration it
returns `skipped`. Neither the config nor tests include credentials; focused
tests and dry runs never call a provider. This workflow does not install fixture
dependencies or execute generated Playwright tests automatically.

## Measurement Run

Start with one task after approving the model and expenditure:

```sh
node scripts/agent-bench.mjs --config agent-repository-bench.config.json --task trace-shared-package --runs 1 --max-requests 36 --assert --format json --save
```

Remove `--task` and use at least three runs for the full comparison after the
pilot. `--max-requests` is shared across every task, arm and repeat in one
invocation, including failed requests. The default is 100; raising it requires
the operator to reconsider the approved budget. It is a request ceiling,
**not a currency cap**. The 60-second request timeout includes reading the
response body. A timed-out request may still incur provider charges.

If a later request fails, prior confirmed usage survives in `partialUsage`;
complete-run usage is null and that run cannot support a savings comparison.
Saved JSON preserves these receipts. The report pins an implementation digest,
prompts, fixtures, limits and model so a version label alone cannot conceal a
different local build. Save notifications use stderr to keep JSON stdout valid.

## Cache Treatment

- Every task/arm/run owns a temporary fixture repository plus isolated home,
  configuration, and temp/cache directories outside that repository. Only
  process-launch environment variables are inherited by tools and checks.
- Cold starts with an empty repository-index cache. Its first agent analysis
  builds the head index; repeated analysis inside that run can then reuse it.
- Warm builds the base index after baseline inputs/manifest initialization but
  **before applying the head overlay, in the same canonical fixture root**.
  Only that base snapshot is warmed; no head analysis runs before the agent.
  The CLI later uses the same temp directory and root-keyed cache namespace.
- `repositoryCache.setup` reports baseline build time, fingerprint, and the
  index's read/rebuild/reuse counters separately. `io.repositoryIndexes` records
  head observations from actual JSON output or diagnostic inspection of an
  agent-format recovery report. No structured observation means unavailable,
  not claimed reuse. Syntax reuse does not imply zero file reads.
- Runs do not carry manifests, recovery reports, or caches across paths.
  Optional arms require `carryOverPaths: []`, including for generic controls.
  Each warm replicate pays its own reported baseline setup cost. Compare agent
  latency and setup separately; warm setup is not free end-to-end performance.

## Measurement And Eligibility

`io` records executor-observed UTF-8 tool inputs/outputs, captured command
stdout/stderr, and direct `read_file`/`grep` bytes. Index-reported read counters are
diagnostics, not executor-observed repository I/O. Child-process filesystem I/O,
including shell internals, is not comprehensively instrumented and is not
estimated. Error-message wrappers added by the loop and provider wire framing
are outside these byte counters. None of these bytes become proxy tokens.

`compactOutputBytes` measures returned agent-format tool output, including the
exit wrapper and truncation annotation. `fullReportGeneratedBytes` counts
generated recovery artifacts; `diagnosticReadBytes` counts harness inspection,
not agent consumption. Recovery pointers become virtual repository-relative
paths handled by the existing `read_file` executor. `fullRecoveryReadBytes`
counts actual recovery-file reads, and `fullRecoveryOutputBytes` counts delivered
recovery responses (also explicit full JSON requests). The existing output cap
still applies: these may be prefixes, **not successful full recovery**. Reads
are individually marked complete or incomplete under `io.recoveryReads`. Reads
through arbitrary shell commands remain unclassified in captured stdout. Files
are not copied into the fixture or fed to the agent automatically.

`repositoryComparisons` gates differences on equal run indices, task/criteria
and prompt fingerprints, model/provider, limits, fixture tree snapshots, and
first-authoring state. Cold/warm tool fingerprints must also match. Failed local
checks, exhausted/truncated agent loops, harness/provider errors, unpaired runs,
and missing usage are ineligible.
Token fields come only from provider-reported input/output/cache usage. Cache
counts retain provider-native meaning and are not combined with input counts.

The six tasks cover editor behavior, transitive package impact, a changed test,
mixed documentation and product edits, unresolved dynamic wiring, and an editor
follow-up. The [task oracle](../../test/agent-tasks/README.md) scores located
evidence precision/recall, contract completeness and uncertainty. Fixture bytes
are checked independently of Git metadata. The offline script deliberately
does not write the expected answer and therefore never passes model quality;
its second unchanged QAMap query verifies warm reuse after the head update.

Dry-run success means **harness-only**. Scripted usage is null and comparisons
are `not-measured`; passing offline tests prove neither model quality nor token
savings. Local criteria inspect deliverables and selected commands;
they do not establish browser reproduction quality. All fixture inputs are
public and synthetic. Temporary state is removed on completion or
an error after baseline materialization.
