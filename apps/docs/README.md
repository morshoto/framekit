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

## GitHub Pages

`.github/workflows/docs-pages.yml` builds and verifies the project-path export on pushes to `main` and publishes `out/` using GitHub Pages. Pull requests run the export checks in CI but do not deploy. The site must first be enabled in repository **Settings → Pages → Build and deployment → GitHub Actions**. The workflow's environment reports the deployed URL; check it after the deploy succeeds. For a future root-domain host, build with `DOCS_BASE_PATH` unset and publish the resulting `out/` directory.

`test:export` checks generated local asset and route references; external URLs are not fetched by that check. Nested routes and production refresh must also be checked after they exist and are deployed.
