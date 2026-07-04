import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, USER_PASSWORD } from "../lib/env.js";

// These tests must start from a clean (unauthenticated) browser, so they do
// NOT use the shared admin storageState.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Admin login", () => {
  test("unauthenticated visit redirects to /admin/login", async ({ page }) => {
    await page.goto("/admin/tables");
    await expect(page).toHaveURL(/\/admin\/login$/);
  });

  test("admin signs in and lands on the tables view", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/admin\/tables$/);
    // Sidebar surfaces the signed-in admin's email.
    await expect(page.getByText(ADMIN_EMAIL, { exact: false })).toBeVisible();
  });

  test("non-admin is rejected with a clear error and stays on login", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Email").fill(USER_EMAIL);
    await page.getByLabel("Password").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("not an admin", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login$/);
    // And no admin session is persisted to localStorage.
    const stored = await page.evaluate(() => localStorage.getItem("localbase.admin.session"));
    expect(stored).toBeNull();
  });
});
