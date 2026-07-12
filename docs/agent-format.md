# Agent Format Contract

`qamap qa --format agent` prints one compact line of JSON designed to be pasted into a coding agent's context instead of the full markdown report. Small heuristic changes are usually 2–4KB; evidence-rich intent lifecycles can be larger. This page is the contract for that output: what the fields mean, what an agent may rely on, and how the format is allowed to change.

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
2. Read `intents` first. Confirm its commit evidence, confidence, lifecycle, and QA scenarios before treating runner-specific output as correct. When `reviewRequired` is true, ask a human to confirm the intent.
3. If `readiness.level` is `blocked` or `needs-work`, treat generated drafts as review-only; `requiredBootstrap` lists what unlocks the next stage.
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
| `intents` | array | Evidence-backed change intents (capped). Each includes `title`, `confidence`, `reviewRequired`, commit/diff `evidence`, ordered `lifecycle` phases, and runner-independent QA `scenarios` with assertions. Empty when commit and diff evidence cannot support a behavior intent. |
| `firstDraftCommand` | string? | One command that creates the first E2E draft. Present only when the repository has no test suite and the diff reaches a product journey. |
| `flows` | array | Affected user flows, most relevant first (capped). Each has `title`, `source`, `draft`, optional `runnable`, `entry`, and `verificationMode`, plus `changedFiles`, `reviewQuestion`, `successSignal`, `steps`, `selectors`, and short `evidence` reasons. Test-only changes expose `existingEvidence`; configuration, docs, generated artifacts, and changed tests use `verificationMode`, keep `draft` only as a fallback artifact path, and omit `firstDraftCommand` rather than inventing a required product journey. |
| `requiredEvidence` | array | Required-priority QA evidence still missing, capped at 8: `flow`, `kind`, `title`. |
| `recommendedEvidenceCount` | number | How many recommended-priority items were omitted; run without `--format agent` to see them. |
| `requiredBootstrap` | array | Setup steps (capped at 3) that must happen before drafts count as regression coverage: `title`, `action`. |
| `prChecklist` | array of string | Ready-to-paste PR checklist lines (capped). |
| `commands` | array of string | Suggested next commands, most useful first (capped at 4). |

List fields are capped to keep the payload small; caps may grow within version 1 but the shapes above will not change.

## Example

```json
{"schema":{"name":"qamap.qa","version":1},"base":"main","head":"HEAD","project":"web","runner":"playwright","manifest":null,"readiness":{"score":51,"level":"needs-work"},"testSuite":{"present":false,"files":0},"intents":[{"title":"Submit checkout and persist the confirmed order","confidence":"high","reviewRequired":false,"evidence":["feat: submit checkout and persist the confirmed order"],"lifecycle":[{"phase":"trigger","label":"Submit checkout."},{"phase":"side-effect","label":"Create the order."},{"phase":"observable-outcome","label":"Show order confirmation."}],"scenarios":[{"priority":"critical","kind":"primary","title":"Submit checkout and persist the confirmed order","assertions":["Verify order confirmation is visible."]}]}],"firstDraftCommand":"qamap e2e setup . --runner playwright","flows":[{"title":"Submit checkout and persist the confirmed order","source":"commit-and-diff-intent","draft":"tests/e2e/submit-checkout-and-persist-the-confirmed-order.spec.ts","runnable":"near-runnable","entry":"route: /checkout (high)","changedFiles":["src/pages/checkout/index.tsx"],"reviewQuestion":"Can a reviewer confirm that the changed checkout lifecycle is verified?","successSignal":"visible text Order confirmed appears","steps":["Submit checkout.","Create the order.","Verify order confirmation is visible."],"selectors":["web-test-id: checkout-submit"],"evidence":["Commit and diff evidence support this change intent."]}],"requiredEvidence":[],"recommendedEvidenceCount":2,"requiredBootstrap":[],"prChecklist":["Review the generated intent-backed draft."],"commands":["npm run build"]}
```
