import { test, expect, type Page } from '@playwright/test';

/**
 * The product, driven as a student would drive it, against a real build and a
 * real database. Wallet pricing uses live rates.
 */

async function open(page: Page, name = 'Wei') {
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open your account' })).toBeVisible();
  await page.getByLabel('Your first name').fill(name);
  await page.getByRole('button', { name: 'Open my account' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`, ${name}$`) })).toBeVisible();
}

const INVOICE = `King's College London - Student Finance Office
INVOICE
Student ID: K2104471
Description: Tuition fee, Spring term 2027
Amount due: GBP 9,250.00
Payment due by 15 November 2027
Pay to: King's College London`;

test('a new student opens an account and sees every pocket valued live', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Total across your pockets')).toBeVisible();
  await expect(page.getByText('120,000.00').first()).toBeVisible();
  await expect(page.getByText('BridgeWise noticed')).toBeVisible();
});

test('the assistant reads an invoice, prepares a payment, and nothing moves until approval', async ({ page }) => {
  await open(page);
  const box = page.getByPlaceholder('Ask anything, or paste an invoice…');
  await box.fill(INVOICE);
  await box.press('Enter');

  // The card appears; the money has not moved yet.
  const approve = page.getByRole('button', { name: 'Approve' }).first();
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('120,000.00').first()).toBeVisible();

  await approve.click();
  await expect(page.getByText(/King's College London — done/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('120,000.00')).toHaveCount(0);
});

test('a conversion is quoted with its fee before anything is approved', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Wallet' }).first().click();
  await page.getByLabel(/Amount to sell/).fill('5000.00');
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByText('Our fee')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Mid-market (ECB)')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText(/— done\./)).toBeVisible({ timeout: 15_000 });
});

test('declining a proposal leaves the money alone', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Wallet' }).first().click();
  await page.getByLabel(/Amount to sell/).fill('1000.00');
  await page.getByRole('button', { name: 'Get quote' }).click();
  await page.getByRole('button', { name: 'Decline' }).click();
  await page.getByRole('button', { name: 'Home' }).first().click();
  await expect(page.getByText('120,000.00').first()).toBeVisible();
});

test('every control on Home has an accessible name', async ({ page }) => {
  await open(page);
  const unnamed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href], input, textarea, select'))
      .filter((el) => {
        const id = el.id;
        const lab = id ? document.querySelector(`label[for="${id}"]`)?.textContent : null;
        const name = el.getAttribute('aria-label') || lab || (el as HTMLElement).innerText || el.getAttribute('placeholder');
        return !name || !name.trim();
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
});
