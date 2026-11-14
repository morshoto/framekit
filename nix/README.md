# Reproducible development environment

Enter the project shell with:

```sh
nix develop ./nix
```

The flake provides Node.js 24, the repository-pinned pnpm through Corepack,
FFmpeg/ffprobe, SQLite, Git, and Bash. It supports fixture and headless
development on Linux and macOS. Xcode is intentionally not packaged by Nix:
Apple's Workflow Extension SDK and `ProExtensionHost` must be provided by a
real Xcode installation selected with `xcode-select`.

For a fresh Linux checkout, run the fixture-only bootstrap from the repository
root:

```sh
nix develop ./nix
pnpm install --frozen-lockfile
pnpm run framekit -- doctor dev --profile fixture
pnpm run build
pnpm run test:fixtures
pnpm run smoke:fixture-mcp
```

`doctor dev --profile fixture` checks the contributor Node.js/pnpm versions and
writable state/cache paths. It does not require FFmpeg, Xcode, Final Cut Pro, or
credentials. The `headless` profile also checks FFmpeg, ffprobe, and SQLite; the
`native` profile additionally checks for Xcode. `doctor finalcut` retains its
existing connection check.

The native compatibility target is recorded in
[`xcode-version.json`](./xcode-version.json). Run the check before building the
Workflow Extension:

```sh
bash nix/check-xcode.sh
```

The manifest currently targets Xcode 16.4 / macOS SDK 15.5 and records the
machine's observed Command Line Tools state separately. Update the manifest in
the same change as any Xcode or SDK compatibility decision.

The separate `ci` profile pins hosted shim validation to Xcode 26.6 (17F113)
with the macOS 26.5 SDK on `macos-26`. CI explicitly selects that installation
and runs `bash nix/check-xcode.sh --ci`. This checks project metadata and the
Swift source against the checked-in shim; it does not build the extension or
establish headed Final Cut compatibility. The default check continues to use
the local native target above.
