import { test, expect, type Page } from '@playwright/test';

/**
 * The product, driven as a student would drive it, against a real build and a
 * real database. Wallet pricing uses live rates.
 */

async function open(page: Page, name = 'Wei') {
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your money, across borders, handled.' })).toBeVisible();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByLabel('Password').fill('testpass123');
  await page.getByLabel('Your first name').fill(name);
  // These scenarios were written for a CNY-home, GBP-study student.
  await page.getByRole('button', { name: 'From China, studying in the UK' }).click();
  await page.getByRole('button', { name: 'Create my account' }).click();
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
  // The payment is on the statement, tagged with its reference.
  await expect(page.getByText(/Tuition · ref K2104471/)).toBeVisible();
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

test('add money, pay for something, and see both on the statement with running balances', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Wallet' }).first().click();
  // Add money offers only real rails: Alipay's cashier and a card through Stripe.
  await page.getByRole('button', { name: 'Add money' }).first().click();
  const add = page.getByRole('dialog');
  await expect(add.getByRole('button', { name: 'Alipay 支付宝', exact: true })).toBeVisible();
  await expect(add.getByRole('button', { name: 'Bank card' })).toBeVisible();
  await expect(add.getByText(/test funds/i)).toHaveCount(0);
  await add.getByRole('button', { name: 'Close' }).click();
  // Paying on Alipay's own cashier can't be scripted, so fund the pocket through
  // the local-only top-up endpoint (it returns 404 on the hosted site).
  const origin = new URL(page.url()).origin;
  const r = await page.request.post('/api/topup', { headers: { origin }, data: { currency: 'GBP', amount: '250.00', source: 'Transfer from home bank', idempotencyKey: 'e2e-' + Date.now() } });
  expect(r.ok()).toBe(true);
  await page.reload();

  await page.getByRole('button', { name: 'Pay' }).first().click();
  const pay = page.getByRole('dialog');
  await pay.getByLabel('Where').fill('Tesco');
  await pay.getByLabel('Amount').fill('40.00');
  await pay.getByLabel('Pocket').selectOption('GBP');
  await page.getByRole('dialog').getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Activity' }).first().click();
  // 900 + 250 = 1150, then 1150 - 40 = 1110.
  await expect(page.getByText('bal 1,150.00')).toBeVisible();
  await expect(page.getByText('bal 1,110.00')).toBeVisible();
});

test('a new Alipay recipient is saved by the student and paid through Alipay only after approval', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await page.getByRole('button', { name: 'New recipient' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Li Na');
  // The Alipay sandbox pays only its own accounts: this is the project's sandbox buyer.
  await page.getByLabel('Their Alipay account').fill(process.env.ALIPAY_SANDBOX_PAYEE ?? 'pybnum6156@sandbox.com');
  await page.getByLabel('Real name on that Alipay').fill(process.env.ALIPAY_SANDBOX_PAYEE_NAME ?? 'pybnum6156');
  await page.getByRole('button', { name: 'Save recipient' }).click();
  await page.getByLabel(/They receive/).fill('5.00');
  await page.getByRole('button', { name: 'Get quote' }).click();
  await expect(page.getByText('Send 5.00 CNY to Li Na')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('Sent 5.00 CNY to Li Na.')).toBeVisible({ timeout: 20_000 });
});

test('a budget shows spending against its limit', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Budget' }).first().click();
  await page.getByLabel(/Monthly limit/).fill('100');
  await page.getByRole('button', { name: 'Set budget' }).click();
  await expect(page.getByText(/0\.00 \/ 100\.00 GBP/)).toBeVisible();
});

test('the 中文 switch turns the interface Chinese and back', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '切换到中文' }).click();
  await expect(page.getByRole('heading', { name: /^(早上好|下午好|晚上好), Wei$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '充值' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Wei$/ })).toBeVisible();
});
