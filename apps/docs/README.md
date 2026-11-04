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

The files in `content/docs/en` and `content/docs/ja` are synthetic test content. `pnpm --filter @framekit/docs check:content` checks local article links, anchors and images and runs as part of the build. Add a document to the locale manifest and static import map as well as its content file. `pnpm --filter @framekit/docs test:locales` exercises a built export using Chromium. Set `DOCS_SITE_ORIGIN` at build time when publishing under a different origin; combine it with `DOCS_BASE_PATH` for canonical and language-alternate URLs.

## Static search

The docs build indexes the static export with Pagefind after Next completes and reports the index size. Pagefind reads `html lang` and creates separate English and Japanese indexes; only article bodies are indexed. Search assets are loaded lazily from the configured base path, and unavailable assets leave navigation usable. `pnpm --filter @framekit/docs test:search` exercises the built export; run it once with `DOCS_BASE_PATH` unset and once after a `/framekit` build with that variable set.
