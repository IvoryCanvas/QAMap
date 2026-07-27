# Symbol QA Annotations

QAMap starts with commit, diff, and repository evidence. Most repositories should run `qamap qa` without adding annotations.

When static inference repeatedly misunderstands one important exported function, component, API client, schema, or service, a small JSDoc annotation can add symbol-level QA meaning without requiring a full manifest rewrite.

```ts
/**
 * @qamapFlow campaign-application
 * @qamapStage action Submit the application
 * @qamapOutcome Application status becomes submitted
 * @qamapRisk Duplicate submission
 */
export async function submitApplication(input: ApplicationInput) {
  return saveApplication(input);
}
```

If a PR later changes `submitApplication`, QAMap can connect the changed line to the declared flow, action, outcome, and risk. The report still cites the actual diff line and keeps the annotation as repo-authored context. The annotation does not claim that QA ran or passed.

## Tags

| Tag | Meaning |
| --- | --- |
| `@qamapFlow <id>` | Stable product or service flow ID. Repeat the tag when one symbol participates in multiple flows. |
| `@qamapStage <kind> [label]` | Role in the behavior lifecycle. Supported kinds are `trigger`, `condition`, `action`, `state-change`, `side-effect`, and `observable-outcome`. `state`, `transition`, `effect`, and `outcome` are accepted aliases. |
| `@qamapOutcome <observable result>` | Result a reviewer should be able to observe or verify. |
| `@qamapRisk <failure or boundary>` | Repo-authored risk that becomes a recommended, review-required QA scenario when the annotated symbol changes. |

Keep values domain-specific to the repository but independent of implementation details. `Application status becomes submitted` is more durable than `setState returns true`.

## Activation Rules

QAMap applies an annotation only when all of these conditions hold:

1. The file is JavaScript or TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, or `.cts`).
2. The JSDoc block is immediately followed by a named exported declaration.
3. The declaration itself or its body overlaps the PR diff.
4. At least one supported tag has a valid value.

Adding comments alone does not create changed behavior or a QA scenario. An annotation on an unchanged neighboring export is also ignored for that PR.

Malformed tags, invalid lifecycle kinds, and comments that no longer attach to an export appear as `symbol-annotation/*` diagnostics instead of being silently trusted.

## Manifest Relationship

Annotations and the verification manifest solve different scopes:

- `.qamap/manifest.yaml` stores team-wide domains, flows, checks, routes, selectors, and validation policy.
- JSDoc annotations bind one code symbol to a flow, lifecycle role, outcome, or risk.
- Diff and source analysis determine whether that symbol is actually affected by the current PR.

Annotations remain optional. Do not document every function. Add them only where a stable, important symbol repeatedly needs human semantic context.

## Current Limits

- Only named top-level exports are supported in the first adapter.
- Annotations improve QA selection; they do not execute the application.
- A declared risk remains review-required and must be checked against the cited code and diff.
- Other languages can adopt the same internal annotation contract through future language-specific adapters rather than copying JSDoc syntax.
