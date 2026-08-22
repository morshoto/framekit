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
3. Treat missing Final Cut Pro, Workflow Extension, or socket as an actionable
   prerequisite error. Never describe the connection as ready when the server
   reports otherwise. Accessibility and Automation permissions are required
   only for an explicit headed native-write setup; they are not prerequisites
   for headless read-only access.
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
- Ask the user to complete missing Workflow Extension setup. Ask for first-run
  macOS permissions only when the selected headed native-write capability
  requires them; do not broaden filesystem or application access on their behalf.
