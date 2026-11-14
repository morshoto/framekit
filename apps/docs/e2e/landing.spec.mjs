import { test, expect } from "./fixture.mjs";
import AxeBuilder from "@axe-core/playwright";

const contributors = [
  {
    login: "morshoto",
    type: "User",
    html_url: "https://github.com/morshoto",
    avatar_url: "https://avatars.githubusercontent.com/u/103382369",
  },
  {
    login: "renovate[bot]",
    type: "Bot",
    html_url: "https://github.com/apps/renovate",
    avatar_url: "https://avatars.githubusercontent.com/in/2740",
  },
];
test.beforeEach(async ({ page }) => {
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/contributors")
        ? contributors
        : {
            encoding: "base64",
            content: Buffer.from("github: morshoto").toString("base64"),
          },
    }),
  );
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#7060b5"/><circle cx="24" cy="19" r="8" fill="#fff"/><path d="M9 45a15 15 0 0 1 30 0" fill="#fff"/></svg>',
    }),
  );
  await page.route("https://github.com/*.png*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect width="52" height="52" rx="26" fill="#7060b5"/></svg>',
    }),
  );
});

test("all English entry points offer working product and contributor routes", async ({
  page,
  site,
}) => {
  for (const route of ["/", "/en/", "/en/docs/"]) {
    await page.goto(`${site}${route}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Video editing,\s*in your own words/,
    );
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: /^Get started/ }).click();
    await expect(page).toHaveURL(`${site}/en/docs/installation/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Installation",
    );
  }
  for (const [name, slug, heading] of [
    [/Work with a Framekit project/, "headless-editing", "Headless Editing"],
    [/Set up the integration/, "final-cut-pro", "Final Cut Pro"],
    [/Contributor guide/, "development", "Development"],
  ]) {
    await page.goto(`${site}/`);
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(`${site}/en/docs/${slug}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
});

test("community includes automated contributors and survives GitHub failures", async ({
  page,
  site,
}) => {
  await page.goto(`${site}/`);
  await expect(
    page.getByRole("link", { name: /renovate.*automated contributor/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Become a sponsor" }),
  ).toHaveAttribute("href", "https://github.com/sponsors/morshoto");
  await page.evaluate(() => sessionStorage.clear());
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 403, json: { message: "Rate limit" } }),
  );
  await page.reload();
  await expect(page.getByText(/GitHub is unavailable/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /View all contributors/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Become a sponsor" }),
  ).toBeVisible();
});

test("normal scrolling reverses the illustration and reduced motion restores static content", async ({
  page,
  site,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${site}/`);
  const demo = page.locator("[data-workflow-demo]");
  const progress = () =>
    demo.evaluate((element) =>
      Number(element.style.getPropertyValue("--demo-progress")),
    );
  await expect(demo).toHaveAttribute("data-scroll-ready", "");
  const initial = await progress();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(progress).toBeGreaterThan(initial);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(progress).toBeCloseTo(initial, 3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(demo).not.toHaveAttribute("data-scroll-ready");
  await expect(page.locator("[data-current]")).toHaveCount(0);
  await expect(page.getByText(/Do not edit anything/)).toBeVisible();
});

test("responsive themes and enlarged text stay readable and accessible", async ({
  page,
  site,
}, info) => {
  test.skip(info.project.name !== "chromium", "deterministic layout matrix");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [
      320, 375, 580, 581, 760, 761, 800, 801, 1000, 1001, 1440, 1920,
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${site}/`, { waitUntil: "networkidle" });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${theme} at ${width}`,
      ).toBe(true);
      await expect(
        page.getByRole("link", { name: /^Get started/ }),
      ).toBeVisible();
      const figureWidth = await page
        .getByRole("figure")
        .evaluate((element) => element.getBoundingClientRect().width);
      const heroWidth = await page
        .locator('section[aria-labelledby="hero-title"]')
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(
        Math.abs(figureWidth - heroWidth),
        "demo uses the available content width",
      ).toBeLessThan(2);
      if ([375, 1440].includes(width)) {
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        await info.attach(`landing-${theme}-${width}`, {
          body: await page.screenshot({
            fullPage: true,
            animations: "disabled",
          }),
          contentType: "image/png",
        });
      }
    }
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${site}/`, { waitUntil: "networkidle" });
  const description = page.getByText(/Bring your video workflow into Codex/);
  const before = await description.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize),
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  await expect
    .poll(() =>
      description.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    )
    .toBeGreaterThanOrEqual(before * 1.9);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: /^Get started/ }).focus();
  await expect(page.getByRole("link", { name: /^Get started/ })).toBeFocused();
});

test("landing content and navigation work without JavaScript", async ({
  browser,
  site,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${site}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /Video editing/,
    );
    await expect(page.getByText(/not an application screenshot/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Become a sponsor" }),
    ).toBeVisible();
    await page.getByRole("link", { name: /^Get started/ }).click();
    await expect(page).toHaveURL(`${site}/en/docs/installation/`);
  } finally {
    await context.close();
  }
});
