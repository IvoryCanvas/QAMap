# Agent Format Contract

`qamap qa --format agent` prints one compact line of JSON designed to be pasted into a coding agent's context instead of the full markdown report. The complete line stays below 4KB. When the uncapped result would be larger, QAMap preserves the strongest intent, routed scenarios, affected flow, and total/omitted counts instead of silently overflowing the context budget. This page is the contract for that output: what the fields mean, what an agent may rely on, and how the format is allowed to change.

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
2. Read `traces` first. Each compact trace links one diff source to an affected lifecycle stage, risk, routing decision, optional artifact, and `not-run` execution state. `traceable` describes provenance, not a passed test. `traceCount` and `omittedTraceCount` disclose compaction.
3. Read `intents` for the surrounding lifecycle and alternative scenarios. Inspect `scenarios[].sources` before accepting a recommendation: diff sources identify the base/head file, line, symbol, hunk, and relation that caused the scenario to be proposed. `direct` is scenario-specific evidence, `supporting` completes the lifecycle, and `contextual` explains intent but cannot independently promote a scenario. `scenarios[].routing` records whether that evidence made the scenario `required`, `recommended`, or `review-only`.
4. Check `execution` before interpreting any result. Version 1 currently reports `status: "not-run"`, `performed: false`, and `scope: "static-analysis-and-draft-mapping"` because `qa` never launches the target application.
5. Check `scenarioCoverage` and `scenarios[].automation` before trusting a draft. A required scenario with `partial` or `not-compiled` automation remains a blocker. `compiled` is a backward-compatible machine value meaning static commands and assertions were fully mapped; it does not mean the target application was executed or passed.
6. Treat `readiness` as automation readiness, not as a verdict on the PR. `requiredBootstrap` contains non-runner repository context only; runner adoption lives under the opt-in `automation` object.
7. Use `flows[].changedFiles`, `flows[].evidence`, and `flows[].reviewQuestion` to understand why the flow was selected. Use `steps`, `selectors`, and `successSignal` to write or review tests; `flows[].scenarioAutomation` is the compact selected-to-draft map and `runnable` says how much to trust the generated draft.
8. Surface `requiredEvidence` in the PR description, and paste `prChecklist` items into the PR body.
9. Run `commands` to validate. Report their results separately from the QAMap analysis receipt.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | object | `{ name: "qamap.qa", version: 1 }` — check before parsing. |
| `base`, `head` | string | Git refs the diff was computed from. |
| `project` | string | Detected project type (for example `web`, `react-native`, `node`, `unknown`). |
| `runner` | string | Automation output adapter selected after QA intent analysis: `maestro`, `playwright`, or `manual`. |
| `manifest` | string \| null | Verification manifest path in use, or `null` when the run used repo signals and the PR diff only. |
| `execution` | object | Receipt for this QAMap invocation: `status: "not-run"`, `performed: false`, and `scope: "static-analysis-and-draft-mapping"`. It prevents static mapping from being mistaken for product QA execution. |
| `readiness` | object | `score` (0–100) and `level` (`ready` \| `near-runnable` \| `needs-work` \| `blocked`). Human reports render the same value as a four-stage journey; the machine value is stable. |
| `testSuite` | object | `present` (boolean) and `files` (number of detected test files). |
| `intentCount`, `omittedIntentCount` | number | Total inferred intents and the count omitted from the compact payload. |
| `intents` | array | Evidence-backed change intents (capped). Each includes `title`, `confidence`, `reviewRequired`, backward-compatible string `evidence`, structured `sources`, ordered `lifecycle` phases, and runner-independent QA `scenarios`. Every compact scenario carries a stable `id`, `confidence`, `reviewRequired`, structured `sources`, assertions, a `routing` receipt, and an optional `automation` receipt; `scenarioCount` and `omittedScenarioCount` disclose capping. Empty when commit and diff evidence cannot support a behavior intent. |
| `scenarioCoverage` | object | Aggregate routing (`required`, `recommended`, `reviewOnly`) and static draft mapping (`compiled`, `partial`, `notCompiled`, `requiredGaps`) counts. These compatible machine values describe mapping completeness only. A required gap must not be reported as completed QA. |
| `traceCount`, `omittedTraceCount` | number | Total QA reasoning traces and the count omitted from the compact payload. |
| `traces` | array | Compact causal paths. Each carries a stable `id`, provenance `status`, strongest `source`, linked `behavior`, `risk`, routed `scenario`, optional draft `artifact`, and `execution: "not-run"`. Extreme 4KB compaction may omit trace bodies while retaining both counts. |
| `firstDraftCommand` | string? | Deprecated v1 compatibility field. New output omits it so runner setup is not promoted as the default QA action. |
| `automation` | object? | Explicitly optional adapter handoff: `optIn`, `adapter`, `setupStatus`, `draftCommand`, and optional `setupCommand`. Use it only after the QA scenario is accepted. |
| `flowCount`, `omittedFlowCount` | number | Total affected flows and the count omitted from the compact payload. |
| `flows` | array | Affected user flows, most relevant first (capped). Each has `title`, `source`, backward-compatible `draft`, optional `runnable`, `entry`, and `verificationMode`, plus `changedFiles`, `reviewQuestion`, `successSignal`, `steps`, `selectors`, short `evidence` reasons, and compact `scenarioAutomation` entries (`id`, `decision`, `status`). Test-only changes expose `existingEvidence`; configuration, docs, generated artifacts, and changed tests use `verificationMode`. |
| `compaction` | object | Present only when lower-priority detail was reduced to keep the complete line below 4KB. Carries `maxBytes`, the uncapped `originalBytes`, and `lean: true` when the smallest evidence-preserving shape was used. |
| `requiredEvidence` | array | Required-priority QA evidence still missing, capped at 8: `flow`, `kind`, `title`. |
| `recommendedEvidenceCount` | number | How many recommended-priority items were omitted; run without `--format agent` to see them. |
| `requiredBootstrap` | array | Non-runner repository context steps (capped at 3): `title`, `action`. Runner setup is represented only under `automation`. |
| `prChecklist` | array of string | Ready-to-paste PR checklist lines (capped). |
| `commands` | array of string | Suggested next commands, most useful first (capped at 4). |

List fields are capped to keep the payload small; caps may grow within version 1 but the shapes above will not change.

## Example

The trace portion below is shown with line breaks for readability. The CLI keeps it on the same single JSON line as the compatibility fields that follow.

```json
{
  "traceCount": 1,
  "omittedTraceCount": 0,
  "traces": [{
    "id": "trace:preferences-primary",
    "status": "traceable",
    "source": { "kind": "diff", "reason": "Invoke fetch.", "file": "src/pages/preferences.tsx", "relation": "supporting", "side": "head", "startLine": 7 },
    "behavior": { "id": "stage:preferences-request", "phase": "side-effect", "label": "Invoke fetch.", "relation": "evidence-linked" },
    "risk": { "kind": "primary", "statement": "The expected outcome may regress." },
    "scenario": { "id": "scenario:preferences-primary", "decision": "required", "title": "Submit notification preferences" },
    "artifact": { "draft": "tests/e2e/submit-notification-preferences.spec.ts", "status": "partial" },
    "execution": "not-run"
  }]
}
```

The existing v1 intent, flow, routing, and automation fields remain available on that line:

```json
{"schema":{"name":"qamap.qa","version":1},"base":"main","head":"HEAD","project":"web","runner":"playwright","manifest":null,"execution":{"status":"not-run","performed":false,"scope":"static-analysis-and-draft-mapping"},"readiness":{"score":37,"level":"blocked"},"scenarioCoverage":{"required":1,"recommended":0,"reviewOnly":0,"compiled":0,"partial":1,"notCompiled":0,"requiredGaps":1},"testSuite":{"present":false,"files":0},"intentCount":1,"omittedIntentCount":0,"intents":[{"title":"Submit notification preferences","confidence":"high","reviewRequired":false,"evidence":["feat: submit notification preferences"],"sources":[{"kind":"diff","reason":"Invoke fetch.","file":"src/pages/preferences.tsx","symbol":"fetch","relation":"supporting","side":"head","startLine":7,"endLine":7,"hunk":"@@ -1,5 +1,19 @@"}],"scenarioCount":1,"omittedScenarioCount":0,"lifecycle":[{"phase":"trigger","label":"Submit notification preferences."},{"phase":"side-effect","label":"Invoke fetch."},{"phase":"observable-outcome","label":"Show the saved state."}],"scenarios":[{"id":"scenario:preferences-primary","priority":"critical","kind":"primary","title":"Submit notification preferences","confidence":"high","reviewRequired":false,"sources":[{"kind":"diff","reason":"Invoke fetch.","file":"src/pages/preferences.tsx","symbol":"fetch","relation":"supporting","side":"head","startLine":7,"endLine":7,"hunk":"@@ -1,5 +1,19 @@"}],"assertions":["Verify the saved state becomes observable."],"routing":{"decision":"required","reason":"Selected as required because one supporting diff hunk supports this critical primary scenario.","requiredSources":1,"referenceSources":1},"automation":{"status":"partial","mappedSteps":0,"totalSteps":2,"mappedAssertions":1,"totalAssertions":1,"blocker":"Two selected action steps did not map to generated commands."}}]}],"automation":{"optIn":true,"adapter":"playwright","setupStatus":"proposed","draftCommand":"qamap e2e draft . --base main --head HEAD","setupCommand":"qamap e2e setup . --runner playwright"},"flowCount":1,"omittedFlowCount":0,"flows":[{"title":"Submit notification preferences","source":"commit-and-diff-intent","draft":"tests/e2e/submit-notification-preferences.spec.ts","runnable":"near-runnable","entry":"route: /preferences (high)","changedFiles":["src/pages/preferences.tsx"],"reviewQuestion":"Does the changed preference lifecycle produce the saved state?","successSignal":"visible text Preferences saved appears","steps":["Submit preferences.","Invoke fetch.","Verify the saved state."],"selectors":["web-test-id: preferences-save"],"scenarioAutomation":[{"id":"scenario:preferences-primary","decision":"required","status":"partial"}],"evidence":["Commit and diff evidence support this change intent."]}],"requiredEvidence":[],"recommendedEvidenceCount":1,"requiredBootstrap":[],"prChecklist":["Review the proposed QA scenario and its diff source."],"commands":["npm run build"]}
```
