import { test, expect } from './fixture.mjs';
import AxeBuilder from '@axe-core/playwright';

test('landing and localized articles load with healthy assets', async ({ page, site }) => {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { if (response.url().startsWith(site + '/') && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${site}/`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /View on GitHub/ })).toBeVisible();
  for (const locale of ['en', 'ja']) {
    await page.goto(`${site}/${locale}/docs/introduction/`, { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('main')).toHaveCount(1);
    await page.reload({ waitUntil: 'networkidle' });
  }
  expect(failures).toEqual([]);
});

test('localized navigation and search work', async ({ page, site }) => {
  await page.goto(`${site}/en/docs/introduction/`);
  await page.getByRole('link', { name: '日本語' }).click();
  await expect(page).toHaveURL(/\/ja\/docs\/introduction\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Search documentation' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').fill('ランタン');
  await expect(dialog.getByText('No results found.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/docs\/introduction\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/ja\/docs\/introduction\/$/);
});

test('layouts do not overflow at viewport and breakpoint edges', async ({ page, site }) => {
  for (const width of [320, 375, 393, 767, 768, 769, 1024, 1199, 1200, 1201, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${site}/en/docs/getting-started/`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`).toBe(true);
  }
});

test('navigation drawer and search dialog have no axe violations', async ({ page, site }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${site}/en/docs/introduction/`);
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Documentation navigation' });
  await expect(drawer).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[role=dialog]').analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: /^Search docs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Search documentation' });
  await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[role=dialog]').analyze()).violations).toEqual([]);
});

test('static content works with JavaScript disabled and missing routes return 404', async ({ browser, site }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${site}/en/docs/introduction/`);
  await expect(page.getByRole('heading', { name: 'What is Framekit?' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Fixture setup', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/docs\/getting-started\/$/);
  await expect(page.getByRole('heading', { name: 'Fixture setup', level: 1 })).toBeVisible();
  const response = await page.goto(`${site}/en/docs/not-real/`);
  expect(response.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await context.close();
});

test('article navigation, anchors, pager, and history', async ({ page, site }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${site}/en/docs/introduction/`);
  await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Choose a path' }).click();
  await expect(page).toHaveURL(/#choose-a-path$/);
  await page.getByRole('navigation', { name: 'Page navigation' }).getByRole('link', { name: /Next:/ }).click();
  await expect(page).toHaveURL(/\/en\/docs\/installation\/$/);
  await expect(page.getByRole('heading', { name: 'Installation', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Page navigation' }).getByRole('link', { name: /Previous:/ }).click();
  await expect(page).toHaveURL(/\/en\/docs\/introduction\/$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/docs\/installation\/$/);
});

test('theme persists and reduced motion is respected', async ({ page, site }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(`${site}/en/docs/introduction/`);
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
});

test('blocked search assets leave static navigation usable', async ({ page, site }) => {
  await page.route('**/pagefind/**', route => route.abort());
  await page.goto(`${site}/en/docs/introduction/`);
  await page.getByRole('button', { name: /^Search docs/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Search documentation' });
  await dialog.getByRole('combobox').fill('local-first');
  await expect(dialog.getByRole('link', { name: 'Browse docs' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('main')).toBeVisible();
});

test('capture representative layouts for visual review', async ({ page, site }, info) => {
  test.skip(info.project.name !== 'chromium', 'one deterministic visual reference per profile');
  const capture = async name => info.attach(name, { body: await page.screenshot({ animations: 'disabled', fullPage: true }), contentType: 'image/png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${site}/`, { waitUntil: 'networkidle' }); await capture('landing');
  await page.goto(`${site}/en/docs/introduction/`, { waitUntil: 'networkidle' }); await capture('article-desktop');
  await page.setViewportSize({ width: 1024, height: 900 }); await capture('article-tablet');
  await page.setViewportSize({ width: 375, height: 800 }); await capture('article-mobile');
  await page.getByRole('button', { name: 'Open navigation' }).click(); await capture('mobile-navigation');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Search docs/ }).click(); await capture('search-open');
  await page.getByRole('combobox').fill('local-first'); await expect(page.getByRole('option').first()).toBeVisible(); await capture('search-results');
  await page.getByRole('combobox').fill('unlikely-fixture-query-zzzz'); await expect(page.getByText('No results found')).toBeVisible(); await capture('search-empty');
  await page.keyboard.press('Escape'); await page.emulateMedia({ colorScheme: 'dark' }); await capture('dark-mode');
  await page.goto(`${site}/missing-route/`); await capture('not-found');
});

test('mobile drawer closes by button, backdrop, and navigation', async ({ page, site }, info) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${site}/en/docs/introduction/`);
  const open = page.getByRole('button', { name: 'Open navigation' });
  const dialog = page.getByRole('dialog', { name: 'Documentation navigation' });
  const activate = async locator => info.project.name.startsWith('mobile-') ? locator.tap() : locator.click();
  await activate(open); await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await activate(dialog.getByRole('button', { name: 'Close navigation' })); await expect(dialog).toHaveCount(0);
  await activate(open); await page.mouse.click(370, 400); await expect(dialog).toHaveCount(0);
  await activate(open); await activate(dialog.getByRole('link', { name: 'Fixture setup' }));
  await expect(dialog).toHaveCount(0); await expect(page).toHaveURL(/\/en\/docs\/getting-started\/$/);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('search results open the correct localized articles', async ({ page, site }) => {
  for (const [locale, query] of [['en', 'local-first']]) {
    await page.goto(`${site}/${locale}/`);
    const trigger = page.getByRole('button', { name: /^Search docs/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search documentation' });
    await dialog.getByRole('combobox').fill(query);
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await dialog.getByRole('option').filter({ hasText: locale === 'en' ? 'Introduction' : 'はじめに' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/docs/introduction/`));
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
});

test('representative pages have no axe violations', async ({ page, site }) => {
  await page.goto(`${site}/en/docs/introduction/`, { waitUntil: 'networkidle' });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('mobile controls meet minimum touch size and article assets load', async ({ page, site }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${site}/en/docs/introduction/`, { waitUntil: 'networkidle' });
  for (const name of ['Open navigation', /^Search docs/]) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box, `${name} must be visible`).not.toBeNull();
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole('heading', { name: 'What is Framekit?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Headless Editing' }).first()).toHaveAttribute('href', /headless-editing/);
});


test('keyboard search traps focus and returns it to the trigger', async ({ page, site }) => {
  await page.goto(`${site}/en/docs/introduction/`);
  const trigger = page.getByRole('button', { name: /^Search docs/ });
  await trigger.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Search documentation' });
  const input = dialog.getByRole('combobox');
  const close = dialog.getByRole('button', { name: 'Close search' });
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('landing offers distinct paths and unfinished Japanese pages offer English', async ({ page, site }) => {
  await page.goto(`${site}/`);
  await expect(page.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', /\/en\/docs\/installation\/$/);
  for (const text of ['Work with a Framekit project', 'Set up the integration', 'Contributor guide']) await expect(page.getByRole('link', { name: new RegExp(text) })).toBeVisible();
  await page.goto(`${site}/en/docs/quick-start/`);
  await expect(page.getByText('Use Framekit to check the connection status', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '日本語' }).click();
  await expect(page.getByRole('link', { name: '英語版を読む' })).toHaveAttribute('href', /\/en\/docs\/quick-start\/$/);
  await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
  await page.goto(`${site}/ja/`);
  await expect(page.getByRole('link', { name: '英語版のドキュメントを読む' })).toBeVisible();
});

test('landing paths remain readable on narrow screens', async ({ page, site }) => {
  for (const width of [320, 375, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${site}/`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `landing overflow at ${width}px`).toBe(true);
    await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Work with a Framekit project/ })).toBeVisible();
  }
});
