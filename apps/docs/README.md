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

## GitHub Pages

`.github/workflows/docs-pages.yml` builds and verifies the project-path export on pushes to `main` and publishes `out/` using GitHub Pages. Pull requests run the export checks in CI but do not deploy. The site must first be enabled in repository **Settings → Pages → Build and deployment → GitHub Actions**. The workflow's environment reports the deployed URL; check it after the deploy succeeds. For a future root-domain host, build with `DOCS_BASE_PATH` unset and publish the resulting `out/` directory.

`test:export` checks generated local asset and route references; external URLs are not fetched by that check. Nested routes and production refresh must also be checked after they exist and are deployed.
