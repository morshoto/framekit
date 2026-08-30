# MCP Documentation

Framekit exposes the runtime through a local MCP stdio server. MCP is an
adapter around the runtime; editor-specific behavior belongs in adapters and
the native bridge.

- [Protocol](./protocol.md): live Final Cut IPC framing and request methods.
- [Tools](./tools.md): MCP tool names, inputs, and behavior.
- [Capabilities and errors](./capabilities-and-errors.md): fail-closed rules.
- [Final Cut live backend](./final-cut-live.md): selecting and probing it.

The default `pnpm run mcp` configuration uses the deterministic in-memory
fixture. Set `FRAMEKIT_EDITOR=final-cut-live` to select the live Final Cut
backend, or use `pnpm run framekit -- mcp --editor final-cut-live` to enable
automatic connection setup from a development checkout. Add
`FRAMEKIT_FCPXML_PATH` to enable the canonical document surface alongside live
state.
