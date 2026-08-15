# MCP Documentation

Playhead exposes the runtime through a local MCP stdio server. MCP is an
adapter around the runtime; editor-specific behavior belongs in adapters and
the native bridge.

- [Protocol](./protocol.md): live Final Cut IPC framing and request methods.
- [Tools](./tools.md): MCP tool names, inputs, and behavior.
- [Capabilities and errors](./capabilities-and-errors.md): fail-closed rules.
- [Final Cut live backend](./final-cut-live.md): selecting and probing it.

The default `npm run mcp` configuration uses the deterministic in-memory
fixture. Set `PLAYHEAD_EDITOR=final-cut-live` to select the live Final Cut
backend.
