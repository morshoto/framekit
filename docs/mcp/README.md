# MCP Documentation

Framekit exposes the runtime through a local MCP stdio server. MCP is an
adapter around the runtime; editor-specific behavior belongs in adapters and
the native bridge.

## Headless-first workflow

Framekit-owned projects use the headless Timeline IR and project store as the
default editing path. Call `editing.route` for the intended operation; for
`timeline.edit`, include the concrete `editType` such as
`rename-occurrence`, `set-transform`, or `add-title`. When that concrete
headless capability is available it returns `selectedPath: "headless"`
and the workflow continues through `headless.project.*` and
`headless.edit.*`. This path does not require Final Cut Pro to be installed,
running, frontmost, or accessible through Accessibility/System Events.

The route is capability-granular: unsupported legacy edit types such as
`reduce-noise`, `set-color-correction`, and `ripple-delete` return
`HEADLESS_UNAVAILABLE` rather than claiming the whole `timeline.edit` surface.

If the headless capability is unavailable, the route returns structured
`HEADLESS_UNAVAILABLE` evidence. It does not launch or activate an NLE, and
does not silently fall back to native UI.

## Explicit headed/editor-first workflow

For a caller that explicitly selects the headed path, Framekit retains the
editor-first workflow. Call
`connection.status`, then `editor.inspect`, then `project.inspect` before
choosing a path. Use `editing.route` to check the selected operation against
the editor's advertised capabilities, and stop with `CAPABILITY_UNAVAILABLE`
when the editor cannot safely satisfy it. Continue with the operation's
preview and execute tools, then observe the result with `edit.diff` and
`edit.verify`.

An external renderer is never an implicit substitute for the connected editor.
Pass `fallback: "external-renderer"` to `editing.route` only when external
processing is explicitly selected or authorized. The route response reports
`EXTERNAL_FALLBACK_SELECTED` and its structured cause; the MCP server does not
invoke the external renderer.

Pass `path: "headed"` to `editing.route` only when the caller explicitly
chooses the headed/editor-first path. Native operation tools remain explicit
and are never selected by a headless route.

The explicit background artifact workflow is selected with
`editing.route({ "operation": "artifact.edit" })` when
`FRAMEKIT_FCPXML_PATH` is configured. Its `artifact.edit.*` preview, execute,
diff, verify, and undo tools operate on the managed file without requiring
Final Cut Pro to be frontmost; their artifact revision and digest are not the
revision of the open Final Cut timeline.

- [Protocol](./protocol.md): live Final Cut IPC framing and request methods.
- [Tools](./tools.md): MCP tool names, inputs, and behavior.
- [Rough-cut duration policy](../rough-cut/duration-policy.md): explicit duration tradeoffs for planning workflows.
- [Capabilities and errors](./capabilities-and-errors.md): fail-closed rules.
- [Final Cut live backend](./final-cut-live.md): selecting and probing it.
- [Local speech analysis](../speech-analysis.md): configuring a local
  Whisper/VAD-compatible wrapper and its revision-bound JSON contract.

The default `pnpm run mcp` configuration uses the deterministic in-memory
fixture. Set `FRAMEKIT_EDITOR=final-cut-live` to select the live Final Cut
backend, or use `pnpm run framekit -- mcp --editor final-cut-live` to enable
automatic connection setup from a development checkout. Add
`FRAMEKIT_FCPXML_PATH` to enable the canonical document surface alongside live
state.
