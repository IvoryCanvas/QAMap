# E2E Output Examples

These examples show the shape of QAMap output that should be good enough for the current public release. They are intentionally short snippets, not full generated files. The important property is that they are derived from repository structure, git changes, manifests, and test evidence without an LLM call.

## PR QA Skill Preview

First contact should work without a manifest:

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

The output should be specific enough to paste into a PR comment:

```txt
# QAMap QA Draft

Summary
- Project: Web
- Recommended runner: Playwright
- Manifest: not found; using repo signals and PR diff only
- Stage: almost runnable (3 of 4)

PR Comment Draft
- Affected flow: Checkout UI smoke flow
- User journey: Customer -> Open route /checkout -> Complete checkout with realistic form data
- Success signal: confirmation state is visible after submit
- Changed files: src/pages/checkout/index.tsx

Suggested E2E / QA Draft
- tests/e2e/checkout-ui-smoke-flow.spec.ts: near runnable
- Open route /checkout.
- Fill checkout email.
- Submit checkout.
- Assert confirmation state is visible after submit.

Missing evidence before trusting this PR
- [required] fixture: Add deterministic fixture or mock data.
- [recommended] selector: Confirm stable selectors.

PR checklist
- [ ] Review the generated draft path.
- [ ] Answer the reviewer question for the affected flow.
- [ ] Run local validation: pnpm run test:e2e
```

If this recommendation is useful but slightly wrong, the next step is not another long AI prompt. Generate and correct repo-local QA memory:

```sh
pnpm exec qamap manifest init .
```

Then future `qamap qa` runs can use `.qamap/manifest.yaml` to produce more precise flow names, checks, anchors, and repair paths.

## Verification Manifest Feedback

When a repository has `.qamap/manifest.yaml`, QAMap should explain why a recommendation happened and how a maintainer can correct it:

```txt
Manifest recommendations: 3

Bundle Submission Complete `bundle-submission-complete`
- Kind: flow
- Confidence: high
- Why this was recommended: Changed files match anchors for the Bundle Submission Complete flow.
- Evidence sources: product-qa
- Manifest evidence: .qamap/manifest.yaml > flows.bundle-submission-complete.anchors
- If this is wrong: update .qamap/manifest.yaml > flows.bundle-submission-complete.anchors
- Next actions:
  - Draft or review E2E coverage for the Bundle Submission Complete flow.
  - Cover the declared checks: Submit media link successfully; Show validation error for invalid media link.
- Repair hints:
  - If these files do not belong to this flow, update .qamap/manifest.yaml > flows.bundle-submission-complete.anchors.
  - If the recommended assertions feel vague, rewrite .qamap/manifest.yaml > flows.bundle-submission-complete.checks in team language.
```

This is the feedback loop: static analysis proposes a baseline, humans correct durable manifest entries, and future E2E recommendations become more specific without spending another LLM prompt on the same explanation.

`qamap manifest validate .` checks whether that repo-local knowledge is usable:

```txt
QAMap Manifest Validate
Status: valid
Manifest: .qamap/manifest.yaml
Issues: 0 errors, 0 warnings, 0 info
```

`qamap manifest explain . --base origin/main --head HEAD` makes a single branch debuggable:

```txt
QAMap Manifest Explain
Changed files: 1
Matches: 3

Matches:
- Bundle Submission Complete (flow, high)
  Why: Changed files match anchors for the Bundle Submission Complete flow.
  Evidence: .qamap/manifest.yaml > flows.bundle-submission-complete.anchors
  If wrong: update .qamap/manifest.yaml > flows.bundle-submission-complete.anchors
  Checks: Submit media link successfully; Show validation error for invalid media link
```

When that flow includes an entry route and checks, `qamap e2e draft` promotes it ahead of heuristic drafts:

```ts
// Verification manifest evidence:
// - Flow: Bundle Submission Complete (bundle-submission-complete)
// - Entry route: /bundle/official/submissionComplete
// - Required checks:
//   - [ ] Submit media link successfully
//   - [ ] Show validation error for invalid media link

test("Bundle Submission Complete", async ({ page }) => {
  await test.step("Open route /bundle/official/submissionComplete.", async () => {
    await page.goto("/bundle/official/submissionComplete");
  });
});
```

## Web Core Flow

When a web app declares a core flow:

```yaml
flows:
  - id: checkout-purchase
    name: Checkout purchase
    priority: critical
    files:
      - src/pages/checkout/**
    routes:
      - /checkout
    checks:
      - Complete checkout with a valid payment method.
      - Verify declined payment recovery.
```

`qamap e2e plan` should prefer the team-approved name:

```txt
Project: Web
Recommended runner: Playwright
Execution profile: high
Start command: pnpm run dev
Test command: pnpm run test:e2e
Base URL: http://127.0.0.1:4173
Matched core flows: 1

Flow: Checkout purchase UI smoke flow
Actor: Customer
Trigger: Open route /checkout.
Success signal: Verify declined payment recovery
```

The Playwright draft should read like the product journey:

```ts
test("Checkout purchase", async ({ page }) => {
  await test.step("Open route /checkout.", async () => {
    await page.goto("/checkout");
  });

  await test.step("Complete checkout with a valid payment method.", async () => {
    await page.getByTestId("checkout-submit").click();
  });
});
```

When QAMap can infer durable browser controls, the draft should prefer executable Playwright locators over placeholder text:

```ts
await test.step("Fill profile email.", async () => {
  // Step intent: Fill profile email.
  await page.getByPlaceholder("Profile email").fill("qamap@example.com");
});

await test.step("Save settings.", async () => {
  // Step intent: Save settings.
  await page.getByRole("button", { name: "Save settings" }).click();
});
```

The draft result should also explain whether the generated file passed static runner checks:

```txt
Draft self-check: pass
Command: pnpm run test:e2e
Summary: Playwright draft passed static runner checks.
```

Before writing files, `--dry-run` should expose the same readiness data with preview status:

```txt
Mode: dry run (no files were written)
Files: 0 created, 1 previewed, 0 skipped

- preview: `tests/e2e/checkout-purchase.spec.ts` (Checkout purchase)
  - source: core-flow
  - runnable status: near-runnable
  - self-check: pass
```

For framework-native routing, QAMap should preserve the route a user can actually open rather than framework-only folder syntax. A Next App Router file such as `src/app/(shop)/products/[productId]/page.tsx` should become `/products/:productId`, and a concrete link such as `/products/demo-product` can seed the generated route params:

```ts
const routeParams = {
  productId: "demo-product",
};

await page.goto(`/products/${routeParams.productId}`);
```

React Router config should work similarly when route objects expose path values:

```ts
createBrowserRouter([
  { path: "/reports/:reportId", element: <ReportPage /> },
]);
```

## Expo / React Native Flow

For an Expo or React Native change, QAMap should recommend Maestro and carry mobile selectors into the draft:

```txt
Project: Expo / React Native
Recommended runner: Maestro

Flow: Ink Drawing UI smoke flow
Actor: User
Trigger: Open the Ink Drawing screen.
Selectors: testID=ink-save-button, testID=record-mode-ink
```

Example Maestro draft shape:

```yaml
appId: ${APP_ID}
---
- launchApp
- tapOn: { id: "record-mode-ink" }
- tapOn: { id: "ink-save-button" }
```

When the changed file name exposes a narrower user action, the generated flow should use that action instead of stopping at a broad domain journey:

```txt
Changed file: src/features/listing/components/MediaLinkSubmitModal.tsx
Domain term: Listing
Generated scenario: Listing Media Link Submit
Generated draft path: .maestro/listing-media-link-submit.yaml
```

The draft should then carry the same product-action wording into the runnable skeleton:

```yaml
# Flow: Listing Media Link Submit
# Domain scenario: Listing Media Link Submit
# Intent: Verify the changed "Media Link Submit" behavior inside Listing instead of stopping at a generic primary journey.
appId: ${APP_ID}
---
- launchApp
- tapOn: { id: "listing-media-link-submit" }
```

## API / Service Contract

For backend changes such as `src/v1/listing/utils.ts`, QAMap should not invent a browser journey. It should infer the domain word and stay contract-focused:

```txt
Project: API / service
Recommended runner: Manual

Flow: Listing API contract smoke checklist
Actor: API consumer or upstream service
Trigger: Call the endpoint, handler, or service path affected by src/v1/listing/utils.ts.
Success signal: the changed contract returns the expected status, response shape, auth behavior, and failure handling
```

The manual draft should stay actionable:

```md
# Listing API contract

## Steps

- [ ] Call the changed endpoint, client, command, or handler with a valid request.
- [ ] Verify the response shape, status, and parsed data match the public contract.
- [ ] Verify invalid input, authorization failure, timeout, and server-error handling.
- [ ] Check backward compatibility for existing callers.
```

## CLI Command Verification

For an npm package that exposes `package.json` bin entries, QAMap should not invent a UI journey. It should stay focused on the command contract users run in terminals, scripts, and CI:

```txt
Project: CLI
Recommended runner: Manual

Flow: CLI command verification checklist
Actor: CLI user or maintainer
Trigger: Run the CLI command path affected by src/cli.ts.
Success signal: the command returns the expected stdout, stderr, generated files, and exit code for valid and invalid inputs
```

The manual draft should name concrete command evidence:

```md
# CLI command verification checklist

## Steps

- [ ] Build or install the package in a clean local environment.
- [ ] Run the changed command with a representative valid argument set.
- [ ] Verify stdout, stderr, generated files, and exit code match the intended behavior.
- [ ] Run one invalid, missing-argument, or unsupported-input path and verify the failure message and exit code.
```

## Test-Light Project

When a project has little or no E2E setup, QAMap should move the user toward a concrete starter draft, not just a task list:

```txt
## First E2E Draft Bootstrap

QAMap did not find committed test files for this target. The next step is to create the first runnable starter draft, not to stop at a checklist.

- Recommended first runner: Playwright
- Create command: `qamap e2e setup . --runner playwright`
- Install command: `pnpm add -D @playwright/test`
- Draft files QAMap can create:
  - `playwright.config.ts`
  - `tests/e2e/`
  - `tests/e2e/checkout-primary-journey.spec.ts`
- Files to update: `package.json`

Bootstrap summary:
4 required bootstrap steps must be resolved before generated E2E drafts should be treated as regression coverage.

Required:
- Configure Playwright before making drafts required
- Create the first changed-flow E2E draft
- Add deterministic fixture or mock responses
- Add stable selectors for changed UI surfaces
```

Draft action items should make the next developer action explicit:

```txt
Action summary:
- readiness stage: draft in progress (2 of 4), score 64/100
- runnable status: near-runnable
- self-check: pass or warning based on generated starter code and execution profile
- top blocker: No Playwright config file was detected.
- required runner: Create `playwright.config.ts` with `testDir`, `use.baseURL`, and `webServer.command` when QAMap inferred the dev URL from scripts.
- required fixture: Add deterministic fixture or mock data
- required validation: Resolve missing validation evidence
- recommended manifest: Promote durable product language
```

## API-Dependent Client Flow

When a client-side change calls an API path but the branch does not include backend or fixture evidence, QAMap should name that as a readiness gap and still give the tester a concrete mock slot:

If reusable repo-local evidence already exists, the PR QA output reads its contents (exports, handled routes, response keys) and points at the concrete thing to reuse instead of only saying "add a fixture":

```txt
Missing evidence before trusting this PR
- [recommended] fixture: Confirm fixture coverage for /api/sample/status - Reuse src/services/sampleSeed.ts (exports sampleSeed) to build a deterministic response for /api/sample/status.
```

When an existing handler file already covers part of the flow, the next action names the file and the still-uncovered endpoints, for example `Extend src/mocks/handlers.ts (already handles /api/invoices) to also cover /api/payments/summary`. The generated Playwright mock bodies then reuse the response keys observed in that file (`invoices: "qamap-invoices"`) instead of the generic placeholder below, with a comment noting the source file.

When no fixture file contents are available, the draft falls back to the generic placeholder:

```ts
const mockApiResponses = {
  "**/api/orders/fixture-order-id": {
    status: 200,
    body: {
      ok: true,
      source: "qamap-draft",
    },
  },
};

// Replace sample responses with deterministic fixtures from the target domain before promoting this draft.
for (const [urlPattern, response] of Object.entries(mockApiResponses)) {
  await page.route(urlPattern, async (route) => {
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body),
    });
  });
}
```

This is useful for PRs where the UI can be built against mockdata before the server implementation is available. The generated file should still report fixture readiness as missing or partial until a reviewer replaces the sample response with domain-correct success, empty, unauthorized, timeout, or server-error fixtures.

When the PR changes the endpoint implementation itself, QAMap should not hide that contract behind a synthetic response. In that case the Playwright draft records the endpoint as an observed API pattern instead of adding a response mock:

```ts
const changedApiEndpointPatterns = [
  "**/api/checkout",
];
const observedChangedApiResponses: Array<{ url: string; status: number }> = [];
page.on("response", (response) => {
  if (changedApiEndpointPatterns.some((pattern) => response.url().includes(pattern.replace(/^\*\*/, "")))) {
    observedChangedApiResponses.push({ url: response.url(), status: response.status() });
  }
});
```

## Monorepo Package

When run at the workspace root, QAMap should identify changed package targets before asking the maintainer to choose a final runner:

```sh
qamap e2e plan . --base main --head HEAD
```

Expected root-level behavior:

```txt
Changed App/Package Targets

| Target | Package | Project | Runner | Scoped Command |
| services/listing | listing | Web | Playwright | qamap e2e plan services/listing --workspace-root . --base main --head HEAD |
| apps/mobile | @acme/mobile | Expo / React Native | Maestro | qamap e2e plan apps/mobile --workspace-root . --base main --head HEAD |
```

For package scans, QAMap should use workspace policy without leaking workspace-root paths into package-local drafts:

```sh
qamap e2e plan services/listing --workspace-root . --base main --head HEAD
```

Expected behavior:

```txt
Workspace root: .
Package root: services/listing
Matched core flow: Listing submit
Changed files: src/features/listing/submit.ts
Generated draft path: docs/e2e/listing-submit.md
```

The draft should mention package-local files:

```md
Related Changed Files

- `src/features/listing/submit.ts`
```

## What Good Output Feels Like

Good QAMap output should answer these questions quickly:

- What behavior did this branch probably change?
- What does the team call that behavior?
- Who or what exercises it?
- Which runner or checklist is the right first shape?
- Which setup, selector, fixture, or validation gap blocks this from becoming real regression coverage?

If the output only says "make an E2E test" without these answers, it is not ready for the current release bar.
