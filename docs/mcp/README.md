# MCP Documentation

Framekit exposes the runtime through a local MCP stdio server. MCP is an
adapter around the runtime; editor-specific behavior belongs in adapters and
the native bridge.

## Editor-first workflow

Framekit follows an editor-first policy for editing requests. Call
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

- [Protocol](./protocol.md): live Final Cut IPC framing and request methods.
- [Tools](./tools.md): MCP tool names, inputs, and behavior.
- [Rough-cut duration policy](../rough-cut/duration-policy.md): explicit duration tradeoffs for planning workflows.
- [Capabilities and errors](./capabilities-and-errors.md): fail-closed rules.
- [Final Cut live backend](./final-cut-live.md): selecting and probing it.

The default `pnpm run mcp` configuration uses the deterministic in-memory
fixture. Set `FRAMEKIT_EDITOR=final-cut-live` to select the live Final Cut
backend, or use `pnpm run framekit -- mcp --editor final-cut-live` to enable
automatic connection setup from a development checkout. Add
`FRAMEKIT_FCPXML_PATH` to enable the canonical document surface alongside live
state.
