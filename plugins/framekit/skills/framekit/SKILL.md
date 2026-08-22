---
name: framekit
description: Inspect a live Final Cut Pro session through Framekit MCP while preserving explicit capability and native-edit safety boundaries.
---

# Framekit Live Final Cut

Use this skill when the user asks to inspect or work with Final Cut Pro through
Framekit.

## Connection preflight

1. Call `connection.status` before relying on the live bridge.
2. Call `editor.live.inspect` to read the current project, sequence, playhead,
   revision, and advertised capabilities.
3. Treat missing Final Cut Pro, Workflow Extension, socket, Accessibility, or
   Automation access as an actionable prerequisite error. Never describe the
   connection as ready when the server reports otherwise.
4. Treat `CAPABILITY_UNAVAILABLE` as a hard boundary for the active backend.
   Do not invent timeline snapshots, media results, or edit success.

The plugin always starts Framekit with `--headless`. That mode probes an existing
Workflow Extension bridge and does not launch, activate, focus, or edit Final Cut
through macOS UI automation.

## Capability boundaries

- Live metadata availability does not prove canonical timeline snapshot or write
  access. Inspect the reported capability flags before selecting a tool.
- Native destructive operations are disabled by the plugin's headless startup.
  If the user deliberately switches to a headed native-write setup, retain the
  existing preview, execute, frontmost, focus, verification, and undo workflow.
- Ask the user to complete missing first-run macOS permissions or Workflow
  Extension setup; do not broaden filesystem or application access on their
  behalf.
