import { expect, test } from "@playwright/test";

test("reports page opens", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
});
