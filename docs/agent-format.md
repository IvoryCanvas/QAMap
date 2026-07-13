# Agent Format Contract

`qamap qa --format agent` prints one compact line of JSON designed to be pasted into a coding agent's context instead of the full markdown report. The complete line is capped at 8KB. When the uncapped result would be larger, QAMap preserves the strongest evidence and reports total and omitted counts instead of silently overflowing the context budget. This page is the contract for that output: what the fields mean, what an agent may rely on, and how the format is allowed to change.

```sh
qamap qa . --base origin/main --head HEAD --format agent
```

## Stability policy

- The output is a single JSON object on one line, followed by a newline. Nothing else is printed to stdout, and it is never colorized.
- Every payload carries `schema: { "name": "qamap.qa", "version": 1 }`. Check both before parsing the rest.
- Within version 1, fields are **only ever added** — existing fields are never removed, renamed, or retyped. Parse leniently: ignore fields you do not recognize.
- A breaking change bumps `schema.version` to 2. Version 1 output will not silently change shape underneath you.
- The machine-readable definition lives at [`schema/qamap-agent.schema.json`](../schema/qamap-agent.schema.json) and is validated against real output in the test suite.

## Consuming it

The intended loop for a coding agent:

1. Run the command above and parse stdout as JSON.
2. Read `intents` first. Confirm its confidence, lifecycle, and QA scenarios. Inspect `scenarios[].sources` before accepting a recommendation: diff sources identify the base/head file, line, symbol, hunk, and relation that caused the scenario to be proposed. `direct` is scenario-specific evidence, `supporting` completes the lifecycle, and `contextual` explains intent but cannot independently promote a scenario to critical. When `reviewRequired` is true, ask a human to confirm it.
3. Treat `readiness` as automation readiness, not as a verdict on the PR. `requiredBootstrap` contains non-runner repository context only; runner adoption lives under the opt-in `automation` object.
4. Use `flows[].changedFiles`, `flows[].evidence`, and `flows[].reviewQuestion` to understand why the flow was selected. Use `steps`, `selectors`, and `successSignal` to write or review tests; `runnable` says how much to trust the generated draft.
5. Surface `requiredEvidence` in the PR description, and paste `prChecklist` items into the PR body.
6. Run `commands` to validate.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | object | `{ name: "qamap.qa", version: 1 }` — check before parsing. |
| `base`, `head` | string | Git refs the diff was computed from. |
| `project` | string | Detected project type (for example `web`, `react-native`, `node`, `unknown`). |
| `runner` | string | Automation output adapter selected after QA intent analysis: `maestro`, `playwright`, or `manual`. |
| `manifest` | string \| null | Verification manifest path in use, or `null` when the run used repo signals and the PR diff only. |
| `readiness` | object | `score` (0–100) and `level` (`ready` \| `near-runnable` \| `needs-work` \| `blocked`). Human reports render the same value as a four-stage journey; the machine value is stable. |
| `testSuite` | object | `present` (boolean) and `files` (number of detected test files). |
| `intentCount`, `omittedIntentCount` | number | Total inferred intents and the count omitted from the compact payload. |
| `intents` | array | Evidence-backed change intents (capped). Each includes `title`, `confidence`, `reviewRequired`, backward-compatible string `evidence`, structured `sources`, ordered `lifecycle` phases, and runner-independent QA `scenarios`. Every compact scenario carries `confidence`, `reviewRequired`, structured `sources`, and assertions; `scenarioCount` and `omittedScenarioCount` disclose capping. Empty when commit and diff evidence cannot support a behavior intent. |
| `firstDraftCommand` | string? | Deprecated v1 compatibility field. New output omits it so runner setup is not promoted as the default QA action. |
| `automation` | object? | Explicitly optional adapter handoff: `optIn`, `adapter`, `setupStatus`, `draftCommand`, and optional `setupCommand`. Use it only after the QA scenario is accepted. |
| `flowCount`, `omittedFlowCount` | number | Total affected flows and the count omitted from the compact payload. |
| `flows` | array | Affected user flows, most relevant first (capped). Each has `title`, `source`, backward-compatible `draft`, optional `runnable`, `entry`, and `verificationMode`, plus `changedFiles`, `reviewQuestion`, `successSignal`, `steps`, `selectors`, and short `evidence` reasons. Test-only changes expose `existingEvidence`; configuration, docs, generated artifacts, and changed tests use `verificationMode`. |
| `compaction` | object | Present only when lower-priority detail was reduced to keep the complete line within 8KB. Carries `maxBytes` and the uncapped `originalBytes`. |
| `requiredEvidence` | array | Required-priority QA evidence still missing, capped at 8: `flow`, `kind`, `title`. |
| `recommendedEvidenceCount` | number | How many recommended-priority items were omitted; run without `--format agent` to see them. |
| `requiredBootstrap` | array | Non-runner repository context steps (capped at 3): `title`, `action`. Runner setup is represented only under `automation`. |
| `prChecklist` | array of string | Ready-to-paste PR checklist lines (capped). |
| `commands` | array of string | Suggested next commands, most useful first (capped at 4). |

List fields are capped to keep the payload small; caps may grow within version 1 but the shapes above will not change.

## Example

```json
{"schema":{"name":"qamap.qa","version":1},"base":"main","head":"HEAD","project":"web","runner":"playwright","manifest":null,"readiness":{"score":51,"level":"needs-work"},"testSuite":{"present":false,"files":0},"intentCount":1,"omittedIntentCount":0,"intents":[{"title":"Submit notification preferences","confidence":"high","reviewRequired":false,"evidence":["feat: submit notification preferences"],"sources":[{"kind":"diff","reason":"Invoke fetch.","file":"src/pages/preferences.tsx","symbol":"fetch","relation":"supporting","side":"head","startLine":7,"endLine":7,"hunk":"@@ -1,5 +1,19 @@"}],"scenarioCount":1,"omittedScenarioCount":0,"lifecycle":[{"phase":"trigger","label":"Submit notification preferences."},{"phase":"side-effect","label":"Invoke fetch."},{"phase":"observable-outcome","label":"Show the saved state."}],"scenarios":[{"priority":"critical","kind":"primary","title":"Submit notification preferences","confidence":"high","reviewRequired":false,"sources":[{"kind":"diff","reason":"Invoke fetch.","file":"src/pages/preferences.tsx","symbol":"fetch","relation":"supporting","side":"head","startLine":7,"endLine":7,"hunk":"@@ -1,5 +1,19 @@"}],"assertions":["Verify the saved state becomes observable."]}]}],"automation":{"optIn":true,"adapter":"playwright","setupStatus":"proposed","draftCommand":"qamap e2e draft . --base main --head HEAD","setupCommand":"qamap e2e setup . --runner playwright"},"flowCount":1,"omittedFlowCount":0,"flows":[{"title":"Submit notification preferences","source":"commit-and-diff-intent","draft":"tests/e2e/submit-notification-preferences.spec.ts","runnable":"near-runnable","entry":"route: /preferences (high)","changedFiles":["src/pages/preferences.tsx"],"reviewQuestion":"Does the changed preference lifecycle produce the saved state?","successSignal":"visible text Preferences saved appears","steps":["Submit preferences.","Invoke fetch.","Verify the saved state."],"selectors":["web-test-id: preferences-save"],"evidence":["Commit and diff evidence support this change intent."]}],"requiredEvidence":[],"recommendedEvidenceCount":1,"requiredBootstrap":[],"prChecklist":["Review the proposed QA scenario and its diff source."],"commands":["npm run build"]}
```
