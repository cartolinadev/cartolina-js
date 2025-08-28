const { test, expect } = require('@playwright/test');

test('placeholder', async ({ page }) => {
  await page.goto('about:blank');
  await expect(page).toHaveTitle('');
});

