# 30-Second Quick Start Demo

This demo is the shortest way to show what CodeWard does in a public README, blog post, or launch thread.

![CodeWard 30-second PR demo](assets/codeward-30s-demo.gif)

The GIF shows a simulated local PR where a checkout form changed. CodeWard does not report a real browser test pass during `--dry-run`. It reports the generated verification artifact: the affected flow, the planned Playwright draft path, static self-check status, and the remaining work before the draft can be trusted as PR evidence.

## Story

A reviewer sees a PR that changes a checkout form:

```txt
src/app/checkout/page.tsx
src/features/checkout/CheckoutForm.tsx
src/features/checkout/submitCheckout.ts
```

The reviewer wants to know:

- Which user flow is affected?
- Should this become a Playwright test, a manual checklist, or only a review note?
- What blocks the generated draft from being trusted as regression coverage?

## Command

Run CodeWard on the branch:

```sh
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD --dry-run
```

`--dry-run` is important for first contact. It lets maintainers preview the plan, draft path, readiness, and blockers without writing files.

## What CodeWard Reads

```txt
Input
- git diff between origin/main and HEAD
- package.json scripts and dependencies
- framework and route files
- existing E2E runner config
- stable selectors such as data-testid, aria-label, role text, placeholder text, and testID
- optional team-owned context in .codeward/domains.yml and .codeward/flows.yml
```

## What CodeWard Returns

```txt
Output
- changed domain language
- candidate user flow
- recommended runner
- draft file path
- flow language brief
- runnable status
- self-check status
- required action items
- blockers that explain why a draft is not ready yet
```

## Markdown Preview

```txt
CodeWard E2E Draft
Mode: dry run (no files were written)
Project: Web
Recommended runner: Playwright
Files: 0 created, 1 previewed, 0 skipped

- preview: tests/e2e/checkout-purchase.spec.ts
  Flow: Checkout purchase
  Actor: Customer
  Trigger: Open route /checkout.
  Goal: Complete checkout with realistic form data.
  Success signal: confirmation state is visible after submit
  Reviewer question: Can a customer still complete checkout after this PR?
  Runnable status: near-runnable
  Promotion status: needs-review

Required action items:
- Add or confirm stable selectors for changed checkout controls.
- Add deterministic payment/customer fixture data.
- Review generated assertions against the real success and error states.
- Run pnpm run test:e2e after reviewing the generated draft.

Top blockers:
- Playwright config was not detected.
- Fixture or mock data was not found for the checkout submit path.
```

## Draft Shape

```ts
import { expect, test } from "@playwright/test";

test("Checkout purchase", async ({ page }) => {
  await test.step("Open route /checkout.", async () => {
    await page.goto("/checkout");
  });

  await test.step("Fill checkout email.", async () => {
    await page.getByPlaceholder("Email").fill("buyer@example.com");
  });

  await test.step("Fill checkout name.", async () => {
    await page.getByPlaceholder("Name").fill("Ada Lovelace");
  });

  await test.step("Submit checkout.", async () => {
    await page.getByRole("button", { name: "Complete purchase" }).click();
  });

  await expect(page.getByText("Order confirmed")).toBeVisible();
});
```

In the demo branch, the generated test is meant to protect this review question:

```txt
Can a customer still complete the Checkout purchase flow after the checkout form change?
```

The draft covers:

- entering the checkout route
- using the changed checkout form controls
- checking the success/confirmation state
- checking the invalid-input recovery path

The dry-run result is intentionally conservative:

```txt
Generated E2E draft: yes
Static Playwright self-check: pass
Browser test execution: not run in --dry-run
Still required: deterministic fixture/mock data and real pnpm run test:e2e execution
```

## Recording A Short GIF

Use a tiny branch where a form, button, route, or API client changed. The recording only needs three terminal moments:

```sh
git diff --stat origin/main...HEAD
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD --dry-run
pnpm dlx @ivorycanvas/codeward verify . --base origin/main --head HEAD --format markdown
```

The best GIF is not a long terminal scroll. Show:

- the changed files
- the generated flow name
- the planned draft path
- the required action items
- the no-write `--dry-run` line

## Launch Message

```txt
CodeWard turns a PR diff into domain-aware verification flows and draft E2E tests.

It runs locally, does not upload source code, and does not call an LLM API.

Try it:
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD --dry-run
```
