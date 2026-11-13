# Independent review pilot, registered 2026-11-13

The candidate's QA source was frozen at `97bcb42ad12ae19b862b4561bbea6bda5834ffc2`
before loading the public changes for this pilot. It remains an unpublished
candidate with package metadata 0.5.3, distinct from the registry release.
Do not tune the engine against these answers and continue calling them independent.

## Selection and limits

Use two public repositories not in the prior 42-PR evaluation: `pallets/click`
and `sindresorhus/p-limit`. Inspect closed PR metadata, newest updated first;
select the first merged, non-bot bug fix with production source and tests and
at most five changed files and 200 changed source/test lines. Freeze the PR,
commit IDs, source hashes and expected defect before host runs. If neither
qualifies within the first 20 records, report the selection gap instead of
choosing a convenient replacement after seeing host answers.

Materialize only public source needed for the case, preserving its license and
attribution. Do not install dependencies, execute repository tests or expose
private checkouts. A case may reintroduce the fixed production change while
retaining its regression test; label that as a seeded public regression,
not an untouched natural PR or an estimate of real-world prevalence.

First run one paired pilot per eligible case, alternating arm order, with
Codex CLI's fixed `gpt-6.1-sol` model and the same prompt and read-only settings
in both arms. Run sequentially, at most 120 seconds per host invocation. The
QAMap arm adds its normal repository-local review setup. This is a harness and
feasibility pilot, not a statistically powered savings or quality claim.

Claude measurements require a separately available Claude Code CLI and pinned
model. A missing CLI is unmeasured; do not install it, reuse another host's
metrics or interpret a dry run as a measurement.

## Metrics and eligibility

Retain actual CLI version, requested model, exact case snapshots, engine source
commit, prompt hash, native JSONL, final answer and elapsed time. Codex reports
input including its cached subset: total is input plus output, without adding
cached input again. Preserve unknown provider model identity, cache-write
counts, request counts and billing as unknown. Native turn receipts describe
CLI-reported usage, not independently audited account usage or hidden startup
requests. Keep hosts separate; their tool interfaces are not equivalent.

A missing/invalid receipt, timeout, failed turn, changed working tree, external
tool or incomplete answer is ineligible. Check command transcripts for static
review violations. No package install or test run is part of a review arm.

Before comparing usage, grade the answers against the frozen defect and file
anchors. Report found/partial/missed, unsupported findings and verification
coverage beside raw usage. Keep a complete receipt from a poor review visible,
but do not present its lower usage as a successful optimization. Preserve
selection gaps, skipped hosts and ineligible runs in the final record.

Native output documentation:
https://learn.chatgpt.com/docs/non-interactive-mode
Model identifier documentation:
https://learn.chatgpt.com/docs/models?surface=cli
