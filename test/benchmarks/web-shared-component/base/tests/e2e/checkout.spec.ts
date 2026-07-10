import { expect, test } from "@playwright/test";

test("checkout opens", async ({ page }) => {
  await page.goto("/checkout");
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
});
