# Selecting the Live Final Cut Backend

Connect Codex with the standard local MCP registration:

```sh
codex mcp add framekit -- framekit mcp --editor final-cut-live
```

The Framekit MCP process automatically:

- detects or launches Final Cut Pro;
- installs the per-user Workflow Extension artifact when needed;
- activates the extension;
- waits for `/tmp/framekit-finalcut.sock`; and
- retries after Final Cut or extension restarts.

The connection is read-only in this phase. Check setup progress with the MCP
tool `connection.status` or:

```sh
framekit doctor finalcut --json
```

For a development checkout, use:

```sh
framekit connect finalcut --development
```

For a non-default socket:

```sh
FRAMEKIT_EDITOR=final-cut-live \
FRAMEKIT_FINAL_CUT_SOCKET=/tmp/framekit-finalcut.sock \
npm run mcp
```

The live backend reads active project/sequence metadata, playhead, selected
sequence range, and incremental change events. It cannot safely provide a
complete timeline or perform native timeline writes in this phase.
