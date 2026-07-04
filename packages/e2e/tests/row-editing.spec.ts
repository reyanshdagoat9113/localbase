import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE, BASE_URL } from "../lib/env.js";
import { adminGet, adminInsert, signIn, unique } from "../lib/helpers.js";

test.use({ storageState: AUTH_FILE });

// `projects` is editable (single integer PK, not a system table). Its only
// required column is `name`; owner_id/description are nullable, color/created_at
// have defaults — perfect for exercising the grid's write paths.
const TABLE = "projects";

test.describe("Row editing", () => {
  test("adds a row through the New row dialog", async ({ request, page }) => {
    const session = await signIn(request, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const name = unique("e2e-add");
    await page.goto(`/admin/tables/${TABLE}`);
    await page.getByRole("button", { name: "+ New row" }).click();

    // The dialog renders a <label>text</label><input/> pair per column (the
    // label does not wrap the input), so reach each input via its sibling.
    // Fill a valid integer for owner_id — leaving it blank would submit an
    // empty string into an INTEGER column, which the admin API rejects.
    const modal = page.locator(".fixed.inset-0.z-50").last();
    const field = (col: string) =>
      modal.locator("label", { hasText: col }).locator("xpath=following-sibling::input[1]");
    await field("owner_id").fill(String(session.user.id));
    await field("name").fill(name);
    await page.getByRole("button", { name: "Save" }).click();

    // The dialog closes and the row lands in the grid.
    await expect(page.getByText(`New row in ${TABLE}`)).toHaveCount(0);
    await expect(page.locator("tbody")).toContainText(name);

    // And it actually persisted server-side.
    const res = await request.get(
      `${BASE_URL}/_api/admin/tables/${TABLE}/rows?name=${encodeURIComponent(`eq.${name}`)}`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
    const body = await res.json();
    expect(body.data.rows.some((r: Record<string, unknown>) => r.name === name)).toBeTruthy();
  });

  test("edits a cell inline via double-click + Enter", async ({ request, page }) => {
    const session = await signIn(request, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const row = await adminInsert(request, BASE_URL, session, TABLE, {
      name: unique("e2e-edit-before"),
    });
    const id = row.id as number;
    const renamed = unique("e2e-edit-after");

    await page.goto(`/admin/tables/${TABLE}`);
    // Double-click the seeded name cell to open the editor.
    const cell = page.locator("tbody td span", { hasText: String(row.name) }).first();
    await cell.dblclick();
    const editor = page.locator("#cell-editor-input");
    await editor.fill(renamed);
    await editor.press("Enter");

    // Grid reflects the new value...
    await expect(page.locator("tbody")).toContainText(renamed);
    // ...and so does the database.
    const after = await adminGet(request, BASE_URL, session, TABLE, id);
    expect(after?.name).toBe(renamed);
  });

  test("deletes a row via the row × button + confirm dialog", async ({ request, page }) => {
    const session = await signIn(request, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const row = await adminInsert(request, BASE_URL, session, TABLE, {
      name: unique("e2e-delete"),
    });
    const id = row.id as number;

    await page.goto(`/admin/tables/${TABLE}`);
    // The × sits in the leading cell of the seeded row. Target it via the row.
    const rowEl = page.locator("tbody tr", { hasText: String(row.name) }).first();
    await rowEl.locator("button[title='Delete row']").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.locator("tbody")).not.toContainText(String(row.name));
    expect(await adminGet(request, BASE_URL, session, TABLE, id)).toBeNull();
  });
});
