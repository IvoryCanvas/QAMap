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

When omitted evidence belongs to an untracked working-tree file, the recovery
hint uses `git diff --no-index -- /dev/null '<file>'`. Normal tracked-file
recovery remains separate. A no-index diff returns exit code 1 for differences;
it does not stage or execute the file. For several omitted untracked files,
replace `<untracked-file>` with each listed path.

## What The Brief Contains

| Section | Content |
| --- | --- |
| Header | Compared range, changed-file counts, how many changed declarations have collected test references, directly or through callers (not executed coverage), the detected project and its existing validation commands. When something does not fit, a line says so. |
| Changes | Each changed file's diff with line numbers: context and `+` lines use head numbering, `-` lines use base numbering. Small files (150 lines or fewer) are shown whole; small enclosing functions are shown whole; otherwise eight lines of context. A file over its line cap keeps every removed line and folds long runs of added lines into their head line range, because a file read at head still has added lines but not removed ones. |
| Change signals | Per source file, pattern matches for behavior that is easy to miss: fewer error or warning log calls, removed or added error handling, new throws or error returns (with the thrown name), removed throws whose case now continues, new early exits, removed conditions, dropped `await`, removed transactions or locks, rewritten access conditions (the clauses dropped and added), a key dropped from a Go, JavaScript or Python initializer while the field is still read, and a field this diff declares and reads but never assigns. They name lines to read, not defects. When the brief cannot show every file, each one still keeps its header and signals. |
| Unshown lines | When two hunks fall inside one declaration and ten or more unchanged lines between them are not shown, the declaration's head range and those lines. |
| References | For each changed declaration: test files that name it (title, the call, locals derived from it, and the assertions that use them), callers with their enclosing declaration, and the tests of those callers. References on lines this diff changes are marked `(changed)`; unmarked ones are unchanged. Same-named symbols in another language and comment lines are not listed. When a declaration now throws, directly or through a changed function it calls, callers without a try block, `.catch` or Go error check come first, each marked with the handling found by pattern. |
| Calls | JavaScript and TypeScript calls on changed head lines: a binding-backed definition and short body (12 lines or fewer), a literal import specifier whose module location is unresolved, or a positioned unresolved binding. Removed calls remain in the diff. Other languages retain pattern-based call lookup. Test helpers are not offered as definitions for production code. |
| History | For removed or rewritten lines, the commit that introduced them and the tests that commit added, with line numbers. |
| What to verify | For each inferred change intent: the behavior flow (trigger, condition, action, state, outcome) and every check of its critical scenarios, including edge cases. These are heuristic pattern checks: the reviewer turns each one that fits into action and expected result, or dismisses it in one line. A critical scenario of an intent below high confidence is labeled `[check]`. |
| Changed test contracts | When a test diff is not fully printed, its collected test titles and declaration locations remain in a bounded compact list. Assertions shrink before identities; a byte-budget omission names the number of identities left out. These repository expectations remain unexecuted. |
| Open review questions | Missing collected test references or a concrete, unexecuted runtime-module candidate become an observation with its file location, a question, and a next read or human confirmation. These are open questions, not defect findings. |
| Unknowns | Runtime-selected modules, ambiguous re-exports, and changed declarations with no collected test references. |
| Not fully shown | Every file whose diff is not shown in full, with the removed and added lines left out, and the `git diff` command that shows them. |

Open questions keep observed implementation separate from expected behavior.
For example, after a guard is removed and no test reference is collected, the
brief asks which behavior should be preserved or intentionally changed. It does
not infer that policy from a function name or treat missing references as proof
that tests do not exist. The reviewer locates indirect tests or a reviewed policy
source and records the source with an input and expected result before proposing
a check. A runtime candidate instead asks which module is intended in the target
environment and points to its selection condition and deployment configuration.
Repository text cannot authorize execution; tests remain `not-run`.

At most three questions fit in a 1,600-byte section. Question detail shrinks before
the diff, and an omission count remains alongside the existing Unknowns and
references. A `Q-` ID is derived from the gap kind and its evidence identity
(file and symbol, or runtime location and module), so reruns and byte limits do
not renumber a retained question. IDs do not track answers or closure across
releases; the compared range in the header still scopes the evidence. Generation
is local and deterministic, with no additional model call. Byte bounds do not
establish host token savings; this change has no new host-token measurement.

Initializer signals include each retained reading site's code, capped at 64
characters. Unassigned-field signals include the reading line and any same-name
local declaration, capped at 60 characters each. The existing per-file signal
limit and total brief budget still apply.

In JavaScript and TypeScript, an added direct call to a same-file `async` function
used as an `if` or `while` condition is flagged without `await`. Local bindings
distinguish shadowed names; awaited calls, explicit comparisons, imported
functions, generators and reassigned bindings are excluded. At most two such
signals are shown per file. These are review hints, not executed defect checks.

New error paths also trace through up to three existing same-file wrapper calls,
so the wrapper's callers can be listed even when its own lines did not change.
Recognized try blocks, `.catch` calls and Go error checks or discarded errors stop
that propagation. JavaScript and TypeScript calls are checked against local
bindings; other languages retain pattern-based matching. This is not complete
control-flow or inter-module exception analysis.

JavaScript and TypeScript lifecycle hints compare changed `setTimeout`,
`setInterval`, `addEventListener` and `.subscribe` calls with visible cleanup in
the same function or its directly returned cleanup closure. An unchanged
acquisition can also be flagged when this diff removes its matching cleanup.
The hint gives the acquisition line and a bounded snippet, the missing cleanup
name and, for a removed cleanup, its base line. At most two hints per file fit
within the existing signal and brief budgets.

Timer and subscription handles use local bindings; subscription cleanup can be
`.unsubscribe()` or a direct call to the returned teardown function. Listener
matching checks the target, literal event, callback binding and capture flag.
Unrelated functions and shadowed or reassigned bindings do not establish cleanup.
Visible handle transfer (return, assignment or a call argument), listener
`once`/`signal` options and dynamic options are excluded from this check. Custom
timer wrappers, instance-field handles, dynamic event names and cleanup through
other modules are not resolved. A missing hint is not proof of safe teardown;
a hint asks about teardown or ownership, not whether a leak or bug exists.
Even a visible cleanup call does not prove that it executes on every path.

State drafts connect a strict literal equality guard or a switch case to a
string/boolean write of the same binding or simple property path, including
`this` fields inside named classes. They retain
guard and write lines, including base locations when a guarded relation is
removed. Intermediate assignments, increments, an `await` gap or possible case
fallthrough produce an unresolved draft requiring human review. Shadows,
delayed callbacks, coercive comparisons and alternative-value guards do not
establish an edge. At most two state hints per file are shown. These are
syntax-backed candidates, not a complete state machine, product specification,
or proof of the runtime value at the write. Arbitrary call side effects, alias
mutation and transitions across functions are not modeled.
Changes to an intervening write or gap remain relevant when the guard and final
write are unchanged. Direct variable initializers, destructuring targets and
loop-target assignments also invalidate a resolved draft; unrelated bindings
and delayed callbacks do not.
Switch selectors are part of the evidence, with their own line coordinates when
changed. Replacing a literal guard can retain the new and removed base relation
within the two-hint budget; equivalent literal spelling does not add a removed
relation, and a retained write is not described as deleted.

Shared-cache scope hints require a module-level `const` initialized with the
unshadowed built-in `new Map()` and a same-function read and write of a
structurally matching key. The
hint names function inputs used by the stored value but absent from that key,
with module, read, write and value lines. Simple property paths and constant
aliases retain input identity; alias resolution stops after five bindings.
This includes constant aliases used as parameter callees or property bases.
Per-call maps, replaced methods, mutable or computed keys and opaque key builders
are not resolved. A direct `clear()` before the read suppresses the hint only
without an intervening `await`. Removing that reset retains its base coordinate
beside the current Map evidence. Literal bracket notation for a replaced method
has the same exclusion as dotted notation. Up to two Map hints share the existing per-file
and whole-brief budgets. This is an input-scope question, not a data-leak verdict
or evidence that a cache is safe. Classes, imported stores, cross-function
ownership, hidden dependencies and arbitrary invalidation paths remain unmodeled.
A changed await between the latest same-function direct reset and read can also
make a scope question relevant, retaining reset and await locations. An effective
later reset still suppresses it; unrelated awaits do not establish scope evidence.

References come from `git grep` over every tracked file at the compared head,
excluding documentation, lockfiles, vendored code, locale catalogs and build output. That includes files too
large for the syntax index. Each candidate is then checked through the file's
import bindings (JavaScript/TypeScript, Python): a same-named symbol imported from
a different module is dropped, and `export { a as b }` or `import { a as b }`
aliases are followed. JavaScript and TypeScript candidates also require the
binding at the actual use: parameters and local shadows do not name a module's
declaration, and private helpers do not become another module's exports. Named
and namespace imports follow bounded export paths; literal CommonJS bindings
retain the same distinction. Unresolved candidates keep their coordinates and
an unresolved label, outside confirmed caller/test lists. A callee without a
proven binding no longer borrows an unrelated same-named definition. Languages
without import bindings keep name matches.
A missing collected test reference does not establish that tests are absent.
JavaScript test-file collection recognizes canonical `test.js` and `spec.mjs`
names alongside `.test`, `.spec`, `-test`, and `-spec` suffixes. These filename
conventions do not prove execution; other names may remain outside collection.
Unresolved bindings retain their reason and location; build-output imports are
not mapped to source declarations without evidence.
An unresolved bare import may be a workspace or compiler-path alias; its spelling
alone does not establish that the module is outside the repository.

JavaScript and TypeScript caller entries require a bound call or constructor
callee at the use site, including transparent parentheses and type assertions.
Type annotations, generic arguments, stored values and callback values remain
under `source references (invocation not established)` with source coordinates;
their owners do not acquire a runtime caller/test or throw-handling relation.
Calling a member of a function value, such as `.bind`, `.call` or `.apply`, also
stays a source reference; a resolved namespace export call remains a caller.
Markup mentions are also references rather than calls. Other source languages
retain invocation-shaped heuristic matching, without proving runtime execution.

References omitted by per-section detail limits keep compact `file:line` lists,
including callers' tests when their excerpts are disabled. A compact test
coordinate names its matched use, not its title; `(changed)` marks that exact
line. Test cases shared by omitted callers are listed once.
Python `from ... import ...` lines are bindings, not test or caller sites.

These lists cover collected references, not every possible use in the repository.
Search caps still appear under Unknowns. The overall byte budget is unchanged.
If even coordinate-only reference lists are too large, the brief bounds reference
detail before dropping small source and test diffs. It counts omitted reference
detail lines (not reference identities) and suggests a larger `--max-bytes` for
those references. When a whole file block still does not fit, Not fully shown
says its diff and references were omitted. Coordinates do not prove coverage or
test execution.

Changed-test contracts keep titles and declaration coordinates beyond the first
eight entries when space permits. The brief drops assertion detail, then shortens
titles at code point boundaries, before omitting whole entries with
an explicit count. Contract and heuristic sections each have a share of the
existing byte budget so they leave room for diff omissions and recovery commands.
The saved full JSON retains the collected contracts; a compact list is not their
complete source or a test execution result.
JavaScript and TypeScript contracts parse contiguous added lines, including
multiline `it.each` / `test.each` tables, tagged tables and standard modifiers.
Each source declaration keeps one title and call-start coordinate; table rows
and title placeholders are never evaluated or expanded. A short recognized
assertion in the added callback can be retained after long setup code. Sparse
diffs with unchanged declarations or gaps in a declaration can still omit a
contract, and the excerpt is not every assertion or proof of execution.
The diff evidence collector requests unquoted UTF-8 paths for these contracts;
this does not add complete decoding for every special-character Git path.

Change shapes that repeat across many files and differ only in one number are
printed once for a concrete member, followed by the exact list of other values,
for example `N = 0..9, 11..159`. No member is sampled or dropped.

## Using It From An Agent

`qamap init --agent` writes the workflow into `AGENTS.md` and installs the
`qamap-pr-qa` skill for Codex and Claude Code. `--review-mode report` records
that the user chose QAMap review for this project; `--review-mode ask` restores
the offer-first behavior. Installation alone is not consent.

Directory plugins supply the same skill without requiring project setup.
Follow [Claude Code setup](claude-code.md) or [agent integration](agent-skill.md)
for installation; the matching CLI is separate from the plugin.

Agents ask before running QAMap unless the user recorded consent. When asked,
the user can answer this time only, always, or not now; "always" is recorded with
`qamap consent grant` for the project or `qamap consent grant --global` for every
repository (Claude Code and Codex user instructions). `qamap consent revoke
[--global]` returns to asking and `qamap consent status` shows both scopes. The
packaged instructions run `qamap qa brief --require-consent`, which analyzes
nothing without recorded consent, so a host cannot skip the question. See
[commands](commands.md#choose-whether-agents-ask-first).

The instructions ask the agent to run the brief once in the foreground with a
10-minute limit, because large repositories can take a few minutes. The brief is
the map, not the limit: the agent does not repeat the diff or broad searches, but
before concluding it reads the diffs under Not fully shown, reads a changed
function whole when unchanged lines between its hunks are not shown or it changes
a guard, early return, error handling, log level, transaction or shared state,
states a concrete failure scenario for each removed or rewritten behavior, checks
the base before calling something new, removed, untested or fully updated, and
settles an open question that decides whether a finding is real. It reports
findings first, then concrete checks for what to verify, then unknowns. Tests stay `not-run`: the brief is
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
- The history section needs local Git history. Optional history reads disable lazy
  fetching and have a one-second per-command timeout within a three-second total
  Git-command budget. Missing local objects, failed commands and time limits are
  reported as incomplete history under Unknowns. This is not a timeout for the
  whole analysis. Shallow clones can stop before the original commit; Git versions
  without `--no-lazy-fetch` also report incomplete history and continue the diff
  analysis.
- A shallow history boundary can make Git list a commit's entire tree as its
  changed files. Commit-intent analysis omits such boundary commits and reports
  incomplete evidence under Unknowns rather than attaching their subjects to
  the current diff. Other available commits and the current diff remain usable.
- Test excerpts are selected lines, not the whole test. The brief never runs tests.
- Savings are not guaranteed. The host still spends tokens to read the brief and
  write the review, and an agent may choose to read more.

## Measured Results

Claude Code CLI 2.1.282 reviewed 19 frozen cases three times per arm, once with this
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
run. With no repository setup, the unchanged prompt and consent recorded once with
`qamap consent grant --global`, the host used QAMap in 38 of 38 runs and the sum of
medians was 2,881,446 (-70.5%). These are known cases on one host and one model, not a general guarantee.
The per-case table, sensitivity arms and limits are in the
[0.5.1 release record](releases/0.5.1.md#measured-results) and the
[validation record](release-validation.md).

On Claude Code CLI 2.1.292, 0.5.1 used 65.4% fewer tokens on the same cases, and
a 0.5.2 candidate 54.6% fewer. The candidate asks the host to check the code before
it concludes, which costs about one more request on these small cases. Every QAMap
arm found every seeded regression in all 42 runs; standalone did in 41.

On public pull requests chosen by a registered rule, the build that became 0.5.2
used 33-50% fewer tokens per study. On six regressions the projects fixed later,
5 of its 12 runs found the regression and 5 partly found it, against 3 and 0 for
the host alone. Blind grading of 36 pull requests preferred the host alone 18 to
14 (4 ties), with 19 valid findings against 16. That build's signals were designed
after reading these cases, so none of this is independent evidence
([external results](../test/benchmarks/review-host/external/RESULTS.md)).
