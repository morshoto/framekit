# Final Cut Pro Installation

## Toolchain

Use the repository's Nix shell for Node and shell tooling:

```sh
nix develop ./nix
```

Xcode remains a host dependency. Confirm the selected version:

```sh
npm run xcode:check
```

The verified native baseline is Xcode 16.4 / build 16F6 with macOS SDK 15.5.

## Build

```sh
bash native/FinalCutWorkflowExtension/build.sh
```

Install the generated development app:

```sh
ditto /tmp/playhead-finalcut-derived/Build/Products/Debug/PlayheadFinalCutWorkflow.app \
  /Applications/PlayheadFinalCutWorkflow.app
```

Then reopen Final Cut Pro and activate Playhead from Window → Extensions.
See the [live E2E test](../tests/final-cut-live-e2e.md) for the complete
read-only procedure.
