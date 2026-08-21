# Final Cut Pro Troubleshooting

## Connection status

Inspect the machine-readable setup state:

```sh
framekit doctor finalcut --json
```

The MCP server exposes the same state through `connection.status`. It reports
whether Final Cut was detected, whether the extension is installed, whether
activation is in progress, and the last actionable error.

## No socket

The normal Framekit flow activates the extension automatically. First check:

```sh
ls -l ~/Library/Containers/com.framekit.finalcut.workflow.extension/Data/framekit.sock
```

If the socket is absent, run `framekit doctor finalcut --json`. If the state is
`needs-user-action`, follow the reported macOS permission or installation
message. If the state is `unavailable` with `FINAL_CUT_LIVE_TIMEOUT`, use the
explicit development connection flow, which reloads Final Cut after replacing
the extension:

```sh
framekit connect finalcut --development --json
```

The command quits gracefully and reopens Final Cut only when it has replaced
the extension. It never force-quits the app or bypasses an unsaved changes
prompt. Do not delete the user's library as a troubleshooting step.

## `FINAL_CUT_LIVE_UNAVAILABLE`

Check that Final Cut Pro is running, the extension process is present, and the
MCP process is using `FRAMEKIT_EDITOR=final-cut-live`.

The live MCP server retries connection setup in the background. It does not
fall back to the fixture backend.

## `CAPABILITY_UNAVAILABLE`

This is expected for complete live timeline reads, rollback,
playback control, analyzers, and native assets. The runtime fails closed by
design.

Native UI writes are separate. Set `FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1`, grant
Accessibility and Automation permission to the MCP host, bring a Final Cut
timeline window to the front, and select one clip. If those conditions are not
met, `editor.native.inspect` and `editor.native.edit` return structured native
capability or target errors.

## Build or signing errors

Run `npm run xcode:check`, verify that Xcode 16.4 is selected, rebuild, and
verify the installed app with `codesign --verify --deep --strict`.

For release artifacts, set `FRAMEKIT_EXTENSION_APP_PATH` only when intentionally
using a local development bundle. Release installs should use the signed
artifact shipped with the Framekit distribution.
