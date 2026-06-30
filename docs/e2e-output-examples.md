# E2E Output Examples

These examples show the shape of CodeWard output that should be good enough for the first public release. They are intentionally short snippets, not full generated files. The important property is that they are derived from repository structure, git changes, manifests, and test evidence without an LLM call.

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

`codeward e2e plan` should prefer the team-approved name:

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

When CodeWard can infer durable browser controls, the draft should prefer executable Playwright locators over placeholder text:

```ts
await test.step("Fill profile email.", async () => {
  // Step intent: Fill profile email.
  await page.getByPlaceholder("Profile email").fill("codeward@example.com");
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

For framework-native routing, CodeWard should preserve the route a user can actually open rather than framework-only folder syntax. A Next App Router file such as `src/app/(shop)/products/[productId]/page.tsx` should become `/products/:productId`, and a concrete link such as `/products/demo-product` can seed the generated route params:

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

For an Expo or React Native change, CodeWard should recommend Maestro and carry mobile selectors into the draft:

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

## API / Service Contract

For backend changes such as `src/v1/offer/utils.ts`, CodeWard should not invent a browser journey. It should infer the domain word and stay contract-focused:

```txt
Project: API / service
Recommended runner: Manual

Flow: Offer API contract smoke checklist
Actor: API consumer or upstream service
Trigger: Call the endpoint, handler, or service path affected by src/v1/offer/utils.ts.
Success signal: the changed contract returns the expected status, response shape, auth behavior, and failure handling
```

The manual draft should stay actionable:

```md
# Offer API contract

## Steps

- [ ] Call the changed endpoint, client, command, or handler with a valid request.
- [ ] Verify the response shape, status, and parsed data match the public contract.
- [ ] Verify invalid input, authorization failure, timeout, and server-error handling.
- [ ] Check backward compatibility for existing callers.
```

## Test-Light Project

When a project has little or no E2E setup, CodeWard should be honest about what must happen before a draft becomes regression coverage:

```txt
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
- readiness score: 64/100 (needs-work)
- runnable status: near-runnable
- self-check: warning or fail when placeholder locators remain
- top blocker: No Playwright config file was detected.
- required runner: Create `playwright.config.ts` with `testDir`, `use.baseURL`, and `webServer.command` when CodeWard inferred the dev URL from scripts.
- required assertion: Turn generated TODOs into runnable assertions
- required fixture: Add deterministic fixture or mock data
- required validation: Resolve missing validation evidence
- recommended manifest: Promote durable product language
```

## API-Dependent Client Flow

When a client-side change calls an API path but the branch does not include backend or fixture evidence, CodeWard should name that as a readiness gap and still give the tester a concrete mock slot:

```ts
const mockApiResponses = {
  "**/api/orders/fixture-order-id": {
    status: 200,
    body: {
      ok: true,
      source: "codeward-draft",
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

## Monorepo Package

When run at the workspace root, CodeWard should identify changed package targets before asking the maintainer to choose a final runner:

```sh
codeward e2e plan . --base main --head HEAD
```

Expected root-level behavior:

```txt
Changed App/Package Targets

| Target | Package | Project | Runner | Scoped Command |
| services/offer | offer | Web | Playwright | codeward e2e plan services/offer --workspace-root . --base main --head HEAD |
| apps/mobile | @acme/mobile | Expo / React Native | Maestro | codeward e2e plan apps/mobile --workspace-root . --base main --head HEAD |
```

For package scans, CodeWard should use workspace policy without leaking workspace-root paths into package-local drafts:

```sh
codeward e2e plan services/offer --workspace-root . --base main --head HEAD
```

Expected behavior:

```txt
Workspace root: .
Package root: services/offer
Matched core flow: Offer submit
Changed files: src/features/offer/submit.ts
Generated draft path: docs/e2e/offer-submit.md
```

The draft should mention package-local files:

```md
Related Changed Files

- `src/features/offer/submit.ts`
```

## What Good Output Feels Like

Good CodeWard output should answer these questions quickly:

- What behavior did this branch probably change?
- What does the team call that behavior?
- Who or what exercises it?
- Which runner or checklist is the right first shape?
- Which setup, selector, fixture, or validation gap blocks this from becoming real regression coverage?

If the output only says "make an E2E test" without these answers, it is not ready for `0.1.0`.
