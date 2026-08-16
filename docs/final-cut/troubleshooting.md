# Final Cut Pro Troubleshooting

## No socket

Confirm the extension is activated from Final Cut Pro's Window → Extensions
menu, then check:

```sh
ls -l /tmp/framekit-finalcut.sock
```

If the socket is stale, close and reopen Final Cut Pro after reinstalling the
extension. Do not delete the user's library as a troubleshooting step.

## `FINAL_CUT_LIVE_UNAVAILABLE`

Check that Final Cut Pro is running, the extension process is present, and the
MCP process is using `FRAMEKIT_EDITOR=final-cut-live`.

## `CAPABILITY_UNAVAILABLE`

This is expected for complete live timeline reads, native writes, rollback,
playback control, analyzers, and native assets. The runtime fails closed by
design.

## Build or signing errors

Run `npm run xcode:check`, verify that Xcode 16.4 is selected, rebuild, and
verify the installed app with `codesign --verify --deep --strict`.
