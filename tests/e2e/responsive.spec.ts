import { test, expect } from '@playwright/test';

test('on a phone: onboarding, home and the tab bar fit with no sideways scroll', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByLabel('Your first name').fill('Ayesha');
  await page.getByRole('button', { name: /From Pakistan/ }).click();
  await page.getByRole('button', { name: 'Open my account' }).click();
  await expect(page.getByRole('heading', { name: /, Ayesha$/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await expect(page.getByRole('navigation', { name: 'Main' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(page.getByPlaceholder('Ask anything, or paste an invoice…')).toBeVisible();
});
