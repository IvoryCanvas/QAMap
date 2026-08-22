# Agent benchmark task suite

Each directory is one fixed task of the agent token benchmark
(`pnpm bench:agent`, see [docs/benchmarking.md](../../docs/benchmarking.md)).
A task asks a coding agent to do a small, realistic piece of QA work on a
committed public fixture from `test/benchmarks/`:

| Task | Fixture | Shape |
| --- | --- | --- |
| `reproduce-regression` | `web-symbol-annotated-renewal` | Explain a duplicate-request regression fixed on the branch and write a reproduction test. |
| `verify-copy-against-spec` | `web-divergent-surface-copy` | Compare rendered copy on two surfaces with a specification table committed as a task input. |
| `reverify-after-fix` | `web-persisted-workspace-setting` | Re-verify a persistence fix on top of a seeded regression with a pre-authored manifest baseline. |

## What a task declares

`task.json` is validated against [`schema.json`](schema.json):

- `prompt` is the exact user message sent to the provider. It is identical in
  both benchmark arms; only the tool list differs.
- `fixture` names the public fixture directory, the overlay applied on top of
  `base/` before the `main` baseline commit, the overlay committed on
  `benchmark/change`, and the commit message.
- `inputs` are extra files copied from the task directory and committed on
  `main` before the change, such as a copy specification.
- `successCriteria` are the only way success is judged.
- `maxTurns` caps provider round trips per run.
- `firstAuthoring` decides whether the first run starts from a bare repository
  and is reported separately as first-authoring cost. When it is `false`, the
  harness commits a `qamap manifest init` baseline on `main` before every run,
  so all runs are steady state.

## How success is judged

Success is decided locally and deterministically after the agent stops. The
model's prose is never read. Four check kinds exist:

| Kind | Passes when |
| --- | --- |
| `file-exists` | A repository-relative file exists. |
| `command-exit` | An argv command run from the repository root exits with the expected code. |
| `stdout-includes` | An argv command's stdout contains a string. |
| `json-path-equals` | A dotted path inside a JSON file equals an expected literal. |

Checks are static and cheap: they confirm that a deliverable exists at the
requested path, references the expected endpoint, selector, or key, leaves
product source untouched, and reports the expected structured answer. They do
not install dependencies or launch a browser; the
[execution benchmark](../../docs/benchmarking.md#run-the-execution-contract)
remains the gate that proves generated browser tests catch a regression.

## What leaves the machine

When a provider key is configured, the provider receives the committed system
prompt, the task prompt, the tool schemas, and tool results produced inside a
temporary copy of the committed public fixture. Temporary paths are replaced
with placeholders before tool output is returned to the model. No private
repository, local path, or credential is part of a task.
