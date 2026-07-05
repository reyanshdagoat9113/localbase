import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE, BASE_URL } from "../lib/env.js";
import { signIn, uploadFile, unique } from "../lib/helpers.js";

test.use({ storageState: AUTH_FILE });

const BUCKET = "e2e-storage";

test.describe("Storage browser", () => {
  test("browses a bucket and deletes a file", async ({ request, page }) => {
    // Seed a file via the storage API (the UI only lists/deletes — no upload).
    const session = await signIn(request, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const filename = `${unique("file")}.txt`;
    const { originalName } = await uploadFile(
      request,
      BASE_URL,
      session,
      BUCKET,
      filename,
      "e2e storage content"
    );

    await page.goto("/admin/storage");
    await page.getByPlaceholder(/bucket-name/i).fill(BUCKET);
    await page.getByRole("button", { name: "Browse" }).click();

    const row = page.locator("tbody tr", { hasText: originalName });
    await expect(row).toBeVisible();

    // Delete it through the confirm dialog.
    await row.getByRole("button", { name: "Delete" }).click();
    await page
      .locator(".fixed.inset-0.z-50")
      .last()
      .getByRole("button", { name: "Delete", exact: true })
      .click();

    await expect(row).toHaveCount(0);

    // And confirm server-side.
    const res = await request.get(`${BASE_URL}/api/storage/${BUCKET}`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const body = await res.json();
    expect(body.data.files.some((f: { originalName: string }) => f.originalName === originalName)).toBeFalsy();
  });
});
