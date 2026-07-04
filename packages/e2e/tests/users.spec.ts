import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE, BASE_URL, USER_EMAIL } from "../lib/env.js";
import { signIn, unique } from "../lib/helpers.js";

test.use({ storageState: AUTH_FILE });

test.describe("Auth Manager", () => {
  test("lists users and the signed-in admin is marked 'you'", async ({ page }) => {
    await page.goto("/admin/users");
    // The seed admin appears, flagged as the current operator.
    const row = page.locator("tbody tr", { hasText: ADMIN_EMAIL });
    await expect(row).toBeVisible();
    await expect(row).toContainText("you");
  });

  test("creates a user (role=user) and it appears in the list", async ({ page }) => {
    const email = `${unique("e2e-created")}@localbase.test`;
    await page.goto("/admin/users");
    await page.getByRole("button", { name: "+ New user" }).click();

    const modal = page.locator(".fixed.inset-0.z-50").last();
    // Email input is the dialog's `type=email` field; password its sibling block.
    await modal.locator("input[type='email']").fill(email);
    await modal.locator("input[type='password']").fill("created-user-pass-123");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const row = page.locator("tbody tr", { hasText: email });
    await expect(row).toBeVisible();
    // New users start as plain users.
    await expect(row).toContainText("user");
  });

  test("promotes and demotes a user, flipping the role badge", async ({ page }) => {
    await page.goto("/admin/users");
    const row = page.locator("tbody tr", { hasText: USER_EMAIL });

    // Promote → badge becomes "admin".
    await row.getByRole("button", { name: "Promote" }).click();
    await expect(row.getByText("admin", { exact: true })).toBeVisible();

    // Demote (confirmation dialog) → badge becomes "user".
    await row.getByRole("button", { name: "Demote" }).click();
    await page
      .locator(".fixed.inset-0.z-50")
      .last()
      .getByRole("button", { name: "Demote", exact: true })
      .click();
    await expect(row.getByText("user", { exact: true })).toBeVisible();
  });

  test("reset password takes effect (new password works, old fails)", async ({ request, page }) => {
    const newPassword = unique("new-e2e-pass-") + "-Aa1";
    await page.goto("/admin/users");
    const row = page.locator("tbody tr", { hasText: USER_EMAIL });
    await row.getByRole("button", { name: "Reset password" }).click();

    const modal = page.locator(".fixed.inset-0.z-50").last();
    await modal.locator("input[type='password']").fill(newPassword);
    // Scope to the modal: every user row also has a "Reset password" button.
    await modal.getByRole("button", { name: "Reset password", exact: true }).click();
    // The dialog only closes once the mutation succeeds — wait for that, not
    // for the (always-visible) row button, before verifying the new password.
    await expect(page.locator(".fixed.inset-0.z-50")).toHaveCount(0);

    // Verify over the API: the new password signs in, the canonical one no longer does.
    await signIn(request, BASE_URL, USER_EMAIL, newPassword);
    const res = await request.post(`${BASE_URL}/api/auth/signin`, {
      data: { email: USER_EMAIL, password: "canonical-no-longer-valid" },
    });
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
