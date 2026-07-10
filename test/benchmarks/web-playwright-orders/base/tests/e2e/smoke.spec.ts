import { expect, test } from "@playwright/test";

test("orders page opens", async ({ page }) => {
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
});
