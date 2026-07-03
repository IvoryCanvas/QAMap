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
pnpm dlx @ivorycanvas/codeward qa . --base origin/main --head HEAD
```

`qa` is important for first contact. It lets maintainers preview the PR comment draft, affected flow, draft path, readiness, and blockers without writing files.

When the team wants actual draft files:

```sh
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD --dry-run
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD
```

For a repository adopting CodeWard as team QA memory, start with the manifest loop:

```sh
pnpm dlx @ivorycanvas/codeward manifest context .
pnpm dlx @ivorycanvas/codeward manifest init .
pnpm dlx @ivorycanvas/codeward manifest validate .
pnpm dlx @ivorycanvas/codeward manifest explain . --base origin/main --head HEAD
```

For a read-only smoke test against a repository you do not want to modify, keep the manifest outside the repo and pass it back into the PR commands:

```sh
pnpm dlx @ivorycanvas/codeward manifest init . --write /tmp/codeward-manifest.yaml
pnpm dlx @ivorycanvas/codeward qa . --manifest /tmp/codeward-manifest.yaml --base origin/main --head HEAD
```

The manifest is the durable part. It lets a team correct domains, flows, anchors, and checks once, then reuse that correction across future PRs without re-explaining the same QA context to an LLM.

If your coding agent supports reusable local instructions, use the packaged skill template as the PR handoff workflow:

```txt
skills/codeward-pr-qa/SKILL.md
```

## Manifest-Backed PoC Path

The practical PoC is not "CodeWard reads every project perfectly." The useful loop is:

```txt
default branch repo context
  -> codeward manifest init
  -> reviewed .codeward/manifest.yaml

PR branch diff
  -> codeward manifest explain
  -> codeward e2e draft
  -> draft test file plus manifest repair path
```

For example, a repository can contain:

```txt
CONTEXT.md
docs/adr/checkout-purchase.md
AGENTS.md
src/pages/checkout/index.tsx
playwright.config.ts
```

If `docs/adr/checkout-purchase.md` says the checkout purchase flow must cover success, API failure, and visible confirmation evidence, `manifest init` can bootstrap a flow named `Checkout Purchase` with the route `/checkout`. When a later PR changes `src/pages/checkout/index.tsx`, CodeWard can connect the changed route to that manifest flow and preview:

```txt
Manifest Recommendations
- Flow: Checkout Purchase
- Entry route: /checkout
- Evidence sources: route-file, adr-context
- Required checks:
  - Checkout Purchase uses deterministic success fixture data
  - Checkout Purchase handles failed, empty, or unauthorized responses
- If this is wrong: update .codeward/manifest.yaml > flows.checkout-checkout-purchase.anchors

Draft file
- tests/e2e/checkout-purchase.spec.ts
```

That draft is intentionally concrete enough to edit, run, and promote:

```ts
import { expect, test } from "@playwright/test";

test("Checkout Purchase", async ({ page }) => {
  // Verification manifest evidence:
  // Flow: Checkout Purchase
  // .codeward/manifest.yaml > flows.checkout-checkout-purchase.anchors

  await test.step("Open route /checkout.", async () => {
    await page.goto("/checkout");
  });

  await test.step("Fill Email with realistic data.", async () => {
    await page.getByPlaceholder("Email").fill("codeward@example.com");
  });

  await test.step("Submit using Checkout Submit.", async () => {
    await page.getByTestId("checkout-submit").click();
  });

  await expect(page.getByText("Order confirmed")).toBeVisible();
});
```

The human still owns the final truth: fixture data, auth state, API mocks, and assertions must match the real product. The saving is that the repeated context work moves into repo-local manifest memory, and a wrong recommendation points to the manifest path to repair instead of asking a new AI prompt to re-learn the project.

## What CodeWard Reads

```txt
Input
- git diff between origin/main and HEAD
- package.json scripts and dependencies
- framework and route files
- existing E2E runner config
- stable selectors such as data-testid, aria-label, role text, placeholder text, and testID
- optional team-owned context in .codeward/manifest.yaml, CONTEXT.md, ADRs, goals, QA runbooks, and agent instructions
```

## What CodeWard Returns

```txt
Output
- PR comment/checklist draft
- changed domain language
- candidate user flow
- manifest evidence when a repo-local flow/check matches
- recommended runner
- draft file path
- flow language brief
- runnable status
- self-check status
- required action items
- blockers that explain why a draft is not ready yet
```

The result should not stop at "selector needed" or "fixture needed." A useful CodeWard draft should say which flow changed, which test file would be generated, which checks it covers, why those checks were selected, and where to update the manifest if the recommendation is wrong.

## Markdown Preview

```txt
# CodeWard QA Draft

Summary
- Project: Web
- Recommended runner: Playwright
- Manifest: .codeward/manifest.yaml
- Readiness: near-runnable

PR Comment Draft
- Affected flow: Checkout purchase
- Suggested draft: tests/e2e/checkout-purchase.spec.ts
- User journey: Customer -> Open route /checkout -> Complete checkout with realistic form data
- Success signal: confirmation state is visible after submit

Missing evidence before trusting this PR
- [required] fixture: Add deterministic payment/customer fixture data.
- [recommended] selector: Confirm stable selectors for changed checkout controls.

PR checklist
- [ ] Review tests/e2e/checkout-purchase.spec.ts.
- [ ] Confirm success and failed-response assertions.
- [ ] Run pnpm run test:e2e.
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
pnpm dlx @ivorycanvas/codeward qa . --base origin/main --head HEAD
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
CodeWard turns a PR diff into affected flows, missing QA evidence, and draft E2E/checklist work.

It runs locally, does not upload source code, and does not call an LLM API.

Try it:
pnpm dlx @ivorycanvas/codeward qa . --base origin/main --head HEAD
```
