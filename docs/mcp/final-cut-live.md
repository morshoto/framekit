# Selecting the Live Final Cut Backend

Prerequisites:

- Final Cut Pro is open with an active project.
- The Playhead Workflow Extension is installed and activated from Final Cut's
  Window → Extensions menu.
- The extension socket exists in its sandbox container.

Start the MCP server with:

```sh
PLAYHEAD_EDITOR=final-cut-live npm run mcp
```

For a non-default socket:

```sh
PLAYHEAD_EDITOR=final-cut-live \
PLAYHEAD_FINAL_CUT_SOCKET=/path/to/p.sock \
npm run mcp
```

The live backend reads active project/sequence metadata, playhead, selected
sequence range, and incremental change events. It cannot safely provide a
complete timeline or perform native timeline writes in this phase.
