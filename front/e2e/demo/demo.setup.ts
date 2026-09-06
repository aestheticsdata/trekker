import { expect, test as setup } from "@playwright/test";

/**
 * Signing the demo in — as the house dev account, never as anything real.
 *
 * The corpus the take films is the fake tree TRE-140 materialises under the allowlist, and it exists
 * only in the dev database under this account. Nothing on screen is a real host, path or address,
 * which is the precondition for putting the video on a public page.
 *
 * ⚠️ Trekker keeps ONE live session per account: this sign-in revokes every other one
 * (`nest-api/src/users/users.controller.ts`). Your own tab on `local.dev@mock.io` is signed out the
 * moment this runs, and a sign-in of yours mid-take kills the recording the same way.
 */
const STORAGE_STATE = "e2e/.auth/demo.json";

setup("sign in as the demo operator", async ({ page }) => {
  const username = process.env.DEMO_USERNAME;
  const password = process.env.DEMO_PASSWORD;
  setup.skip(!username || !password, "set DEMO_USERNAME and DEMO_PASSWORD in .env.test.local");

  await page.goto("/login");
  await page.fill('input[name="email"]', username as string);
  await page.fill('input[name="password"]', password as string);
  await page.click('button[type="submit"]');

  // The form finishes with `router.replace("/")`, a soft navigation that never fires a `load`
  // event — so the explorer's top bar appearing is the real signal that the private shell
  // rendered, and it is what the saved session has to be good for. The explorer is `/`, so a URL
  // assertion alone would also pass on the login screen it just left.
  await expect(page.locator("header")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/localhost:\d+\/(\?.*)?$/);
  await page.context().storageState({ path: STORAGE_STATE });
});
