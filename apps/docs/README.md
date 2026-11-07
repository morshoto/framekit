# Framekit Docs

This private workspace is a static documentation-site foundation. Its copy is placeholder content; the maintained engineering documentation remains in the repository's top-level `docs/` directory.

Use the repository's pinned Node and pnpm versions, then run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @framekit/docs dev
pnpm --filter @framekit/docs typecheck
pnpm --filter @framekit/docs build
pnpm --filter @framekit/docs test:export
DOCS_BASE_PATH=/framekit pnpm --filter @framekit/docs build
DOCS_BASE_PATH=/framekit pnpm --filter @framekit/docs test:export
```

The export is written to `out/`; an empty `DOCS_BASE_PATH` produces root-relative assets. Next 16.4.5 supports Node 20.9 and newer and React 19; the repository's contributor baseline is Node 22.14.0 and pnpm 12.14.0. React 19.3.1 and Sass 1.107.1 satisfy Next's peer requirements. Versions are pinned for reproducible builds. Sass's optional watcher build script is disabled because static compilation does not require it.

## Components and Storybook

Run `pnpm --filter @framekit/docs test`, `pnpm --filter @framekit/docs storybook`, and `pnpm --filter @framekit/docs build-storybook`. After installing Chromium with `pnpm --filter @framekit/docs exec playwright install chromium`, run `pnpm --filter @framekit/docs test:stories` against the built Storybook to capture light/dark screenshots. The docs workspace pins TypeScript 5.9 for its Storybook/Vite tooling, independently of the root compiler. Storybook shares the app's Sass tokens and offers light/dark themes and viewport presets.

For each shared visual component, create a directory containing `Component.tsx`, `Component.module.scss`, `Component.stories.tsx`, `Component.test.tsx`, and `index.ts`. Export the component and its props through the barrel; consumers should use that public entry. Write behavior and accessible-name tests and add stories for meaningful interactive states. `IconButton` requires a descriptive `label`; `Button` disables activation while loading.

## Mock localized content

The files in `content/docs/en` and `content/docs/ja` are synthetic test content. `pnpm --filter @framekit/docs check:content` checks local article links, anchors and images and runs as part of the build. Register each document and its available locales in the content registry as well as adding its content file. `pnpm --filter @framekit/docs test:locales` exercises a built export using Chromium. Set `DOCS_SITE_ORIGIN` at build time when publishing under a different origin; combine it with `DOCS_BASE_PATH` for canonical and language-alternate URLs.

## Static search

The docs build indexes the static export with Pagefind after Next completes and reports the index size. Pagefind reads `html lang` and creates separate English and Japanese indexes; only article bodies are indexed. Search assets are loaded lazily from the configured base path, and unavailable assets leave navigation usable. `pnpm --filter @framekit/docs test:search` exercises the built export; run it once with `DOCS_BASE_PATH` unset and once after a `/framekit` build with that variable set.

## Static-site browser checks

Install the Playwright browsers, then test each build with the same base path used to build it:

```sh
pnpm --filter @framekit/docs exec playwright install chromium firefox webkit
pnpm --filter @framekit/docs build
pnpm --filter @framekit/docs test:e2e
DOCS_BASE_PATH=/framekit pnpm --filter @framekit/docs build
DOCS_BASE_PATH=/framekit pnpm --filter @framekit/docs test:e2e
```

The tests start ephemeral localhost servers over the actual export; the project profile mounts it under `/framekit/`. The five projects cover desktop Chromium, Firefox and WebKit and emulated iPhone WebKit and Android Chromium. Playwright pins browser revisions; inspect the test report for the current run. Failure screenshots, traces, and videos and visual review screenshots are retained in CI for seven days. External GitHub links are checked as links without navigating to external services.

### Real-device record

| Device | Browser version | Date | Result | Screenshot |
| --- | --- | --- | --- | --- |
| macOS Safari | — | — | NOT TESTED | — |
| iPhone Safari | — | — | NOT TESTED | — |
| Android Chrome | — | — | NOT TESTED | — |

The emulated browser projects do not establish real-device coverage. Published-site smoke evidence, including the deployment workflow run and exact deployed commit, must be recorded when the Pages deployment is available.

To smoke-test the latest published build, supply the successful Pages workflow run ID and its full commit SHA:

```sh
DOCS_DEPLOY_RUN_ID=123 DOCS_EXPECTED_SHA=<full-commit-sha> pnpm --filter @framekit/docs test:pages
```

The command requires `gh` authentication and a Playwright Chromium installation. It checks the workflow run and latest Pages deployment metadata before visiting localized articles and searching the published site. It reports BLOCKED if the deployment cannot be tied to the supplied run and SHA.

## GitHub Pages

`.github/workflows/docs-pages.yml` builds and verifies the project-path export on pushes to `main` and publishes `out/` using GitHub Pages. Pull requests run the export checks in CI but do not deploy. The repository site is enabled in **Settings → Pages → Build and deployment → GitHub Actions**. The workflow's environment reports the deployed URL; check it after the deploy succeeds. For a future root-domain host, build with `DOCS_BASE_PATH` unset and publish the resulting `out/` directory.

`test:export` checks generated local asset and route references; external URLs are not fetched by that check. Nested routes and production refresh must also be checked after they exist and are deployed.

## Content registry and drafts

`src/lib/docs/source.ts` is the registry for stable slugs, section order, localized titles and editorial status. To add a page, choose a URL-safe slug and a unique nonnegative order within its section, add a registry entry, and add an MDX file under each locale listed in its `titles`. Add a translation by adding its localized title and corresponding file; locales may be omitted. The content check rejects missing or unregistered files and broken links. Reorder pages by changing their order values; the sidebar, breadcrumbs and pager follow the registry. Existing `getting-started` and `examples` routes are retained as synthetic QA fixtures.

Draft pages are navigable for design review, visibly labeled, marked `noindex`, and excluded from Pagefind. They have no edit link and there is currently no sitemap; any future sitemap must omit drafts. Change a page to `ready` only after its content and translations have been reviewed. Readiness describes editorial state and does not establish native Final Cut capabilities. Missing translations link to the locale overview with a visible fallback notice. Run `check:content`, `test`, and both root and project-path builds and export checks after content changes.
