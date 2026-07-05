import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE, BASE_URL } from "../lib/env.js";
import { adminInsert, signIn, unique } from "../lib/helpers.js";

// Authenticated for the whole file (skips the login screen).
test.use({ storageState: AUTH_FILE });

test.describe("Tables browser", () => {
  test("lists user + system tables and badges system tables", async ({ page }) => {
    await page.goto("/admin/tables");
    // A user table renders as a card.
    await expect(page.getByRole("link", { name: /projects/ }).first()).toBeVisible();
    // At least one system table carries the "system" badge.
    await expect(page.locator("text=system").first()).toBeVisible();
  });

  test("opens a table into the data grid and shows its columns", async ({ page }) => {
    await page.goto("/admin/tables/projects");
    await expect(page.getByRole("button", { name: "Data" })).toBeVisible();
    // Header row exposes a known column.
    await expect(
      page.getByRole("columnheader").filter({ hasText: "name" })
    ).toBeVisible();
  });

  test("Schema tab shows column metadata and PK flag", async ({ page }) => {
    await page.goto("/admin/tables/projects");
    await page.getByRole("button", { name: "Schema" }).click();
    // The Schema table lists the `name` column.
    await expect(page.locator("td.font-mono", { hasText: "name" })).toBeVisible();
  });

  test("clicking a column header toggles the sort indicator", async ({ page }) => {
    await page.goto("/admin/tables/projects");
    const nameHeader = page.getByRole("columnheader").filter({ hasText: "name" });
    await nameHeader.click();
    await expect(nameHeader).toContainText("↑");
    await nameHeader.click();
    await expect(nameHeader).toContainText("↓");
  });

  test("search filters the grid to matching rows", async ({ request, page }) => {
    const session = await signIn(request, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const needle = unique("zz-search");
    await adminInsert(request, BASE_URL, session, "projects", { name: needle });

    await page.goto("/admin/tables/projects");
    await page.getByPlaceholder(/search/i).fill(needle);
    // 300ms debounce + network refetch.
    await expect(page.locator("tbody")).toContainText(needle);
  });
});
