import { test, expect } from '@playwright/test';

test('on a phone: onboarding, home and the tab bar fit with no sideways scroll', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByLabel('Password').fill('testpass123');
  await page.getByLabel('Your first name').fill('Ayesha');
  await page.getByRole('button', { name: 'From Pakistan, studying in China' }).click();
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: /, Ayesha$/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await expect(page.getByRole('navigation', { name: 'Main' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByPlaceholder('Ask anything, or paste an invoice…')).toBeVisible();
});
