import { test, expect } from "@playwright/test";
import { AUTH_FILE } from "../lib/env.js";

// The seeded admin is role=admin, not owner, so these tests verify the
// owner-only gate. A full approve/reject flow requires an owner account,
// which is covered at the API layer in @localbase/core.
test.use({ storageState: AUTH_FILE });

test.describe("Admin Requests", () => {
  test("non-owner admin sees an owner-only error", async ({ page }) => {
    await page.goto("/admin/admin-requests");

    await expect(
      page.getByText("Only the owner can manage admin requests.", { exact: true })
    ).toBeVisible();
  });

  test("sidebar hides Admin Requests from non-owner admins", async ({ page }) => {
    await page.goto("/admin/tables");

    // The sidebar nav should not surface the owner-only item.
    await expect(page.getByRole("link", { name: "Admin Requests" })).not.toBeVisible();
  });
});
