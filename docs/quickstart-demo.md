# 30-Second Quick Start Demo

This demo is the shortest way to show what QAMap does in a public README, blog post, or launch thread. The checked-in GIF uses the current source against the public `web-react-record-pinning` benchmark without a manifest. Record actual CLI output and generated code only; do not substitute idealized report blocks.

## Story

A reviewer sees a PR that adds a record-pinning interaction and visible result:

```txt
src/pages/records.tsx
```

The reviewer wants to know:

- Which user flow is affected?
- Which diff hunk caused each QA scenario to be proposed?
- Should this become a Playwright test, a manual checklist, or only a review note?
- What blocks the generated draft from being trusted as regression coverage?

## Command

Run QAMap on the branch:

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

`qa` is important for first contact. It lets maintainers review change intent, behavior lifecycle, scenario confidence, exact diff sources, and a PR checklist without writing files or selecting a test runner.

After the team accepts a scenario and wants executable coverage:

```sh
npx --yes @ivorycanvas/qamap@latest e2e draft . --base origin/main --head HEAD --dry-run
npx --yes @ivorycanvas/qamap@latest e2e draft . --base origin/main --head HEAD
```

For a repository adopting QAMap as team QA memory, start with the manifest loop:

```sh
npx --yes @ivorycanvas/qamap@latest manifest context .
npx --yes @ivorycanvas/qamap@latest manifest init .
npx --yes @ivorycanvas/qamap@latest manifest validate .
npx --yes @ivorycanvas/qamap@latest manifest explain . --base origin/main --head HEAD
```

For a read-only smoke test against a repository you do not want to modify, keep the manifest outside the repo and pass it back into the PR commands:

```sh
npx --yes @ivorycanvas/qamap@latest manifest init . --write /tmp/qamap-manifest.yaml
npx --yes @ivorycanvas/qamap@latest qa . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD
```

The manifest is the optional durable layer. First-run QA routing works without it; teams can add one later to correct domains, flows, anchors, and checks once, then reuse that correction across future PRs without re-explaining the same QA context to an LLM.

If your coding agent supports reusable local instructions, use the packaged skill template as the PR handoff workflow:

```txt
skills/qamap-pr-qa/SKILL.md
```

## Manifest-Backed PoC Path

The practical PoC is not "QAMap reads every project perfectly." The useful loop is:

```txt
default branch repo context
  -> qamap manifest init
  -> reviewed .qamap/manifest.yaml

PR branch diff
  -> qamap manifest explain
  -> qamap e2e draft
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

If `docs/adr/checkout-purchase.md` says the checkout purchase flow must cover success, API failure, and visible confirmation evidence, `manifest init` can bootstrap a flow named `Checkout Purchase` with the route `/checkout`. When a later PR changes `src/pages/checkout/index.tsx`, QAMap can connect the changed route to that manifest flow and preview:

```txt
Manifest Recommendations
- Flow: Checkout Purchase
- Entry route: /checkout
- Evidence sources: route-file, adr-context
- Required checks:
  - Checkout Purchase uses deterministic success fixture data
  - Checkout Purchase handles failed, empty, or unauthorized responses
- If this is wrong: update .qamap/manifest.yaml > flows.checkout-checkout-purchase.anchors

Draft file
- tests/e2e/checkout-purchase.spec.ts
```

That draft is intentionally concrete enough to edit, run, and promote:

```ts
import { expect, test } from "@playwright/test";

test("Checkout Purchase", async ({ page }) => {
  // Verification manifest evidence:
  // Flow: Checkout Purchase
  // .qamap/manifest.yaml > flows.checkout-checkout-purchase.anchors

  await test.step("Open route /checkout.", async () => {
    await page.goto("/checkout");
  });

  await test.step("Fill Email with realistic data.", async () => {
    await page.getByPlaceholder("Email").fill("qamap@example.com");
  });

  await test.step("Submit using Checkout Submit.", async () => {
    await page.getByTestId("checkout-submit").click();
  });

  await expect(page.getByText("Order confirmed")).toBeVisible();
});
```

The human still owns the final truth: fixture data, auth state, API mocks, and assertions must match the real product. The saving is that the repeated context work moves into repo-local manifest memory, and a wrong recommendation points to the manifest path to repair instead of asking a new AI prompt to re-learn the project.

## What QAMap Reads

```txt
Input
- git diff between origin/main and HEAD
- package.json scripts and dependencies
- framework and route files
- existing E2E runner config
- stable selectors such as data-testid, aria-label, role text, placeholder text, and testID
- optional team-owned context in .qamap/manifest.yaml, CONTEXT.md, ADRs, goals, QA runbooks, and agent instructions
```

## What QAMap Returns

```txt
Output
- PR comment/checklist draft
- commit-backed change intent and confidence
- ordered behavior lifecycle
- primary, failure, boundary, and state-transition QA scenarios
- scenario-level confidence, review status, and exact commit or head-side `file:line` sources
- evidence disposition (`confirmed`, `source-gap`, or `mapping-gap`) with repeated source references deduplicated
- changed domain language
- candidate user flow
- manifest evidence when a repo-local flow/check matches
- optional automation adapter selected after QA design
- optional draft file path
- flow language brief
- runnable status
- self-check status
- required action items
- blockers that explain why a draft is not ready yet
- an exact manifest correction target when the reasoning path is wrong, always gated by human approval
```

The result should not stop at "selector needed" or "fixture needed." A useful QAMap report should say which behavior changed, which scenarios follow, which exact hunk supports each scenario, what remains uncertain, and where to update the manifest if the recommendation is wrong. Automation comes after that review.

## Markdown Preview

```txt
# QAMap QA Draft

At a Glance
- Change intent: Submit notification preferences and show the saved state [high]
- Behavior lifecycle: trigger -> state-change -> side-effect -> observable-outcome

Summary
- Project: Web
- Manifest: .qamap/manifest.yaml

QA scenarios
- [critical] changed preference lifecycle [high]
  - Source: src/pages/preferences.tsx:17, symbol onClick
  - Assert: the saved state is visible
- [recommended] failure, timeout, and retry handling [medium; review required]
  - Source: src/pages/preferences.tsx:7, symbol fetch
  - Assert: retries do not duplicate requests or side effects

Evidence gaps in this QA proposal
- [required] fixture: Add deterministic response data for /api/preferences.

PR checklist
- [ ] Review each QA scenario and its diff source.
- [ ] Confirm success and failed-response assertions for /api/preferences.
- [ ] Run pnpm run test:e2e.

Optional automation
- Adapter candidate: Playwright
- qamap e2e draft . --base origin/main --head HEAD
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
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
npx --yes @ivorycanvas/qamap@latest verify . --base origin/main --head HEAD --format markdown
```

The best GIF is not a long terminal scroll. Show:

- the changed files
- the generated flow name
- the planned draft path
- the required action items
- the no-write `--dry-run` line

## Launch Message

```txt
QAMap turns a PR diff into affected flows, missing QA evidence, and draft E2E/checklist work.

It runs locally, does not upload source code, and does not call an LLM API.

Try it:
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```
