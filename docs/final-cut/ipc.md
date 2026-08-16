# Final Cut IPC

The bridge uses newline-delimited JSON over a Unix-domain socket. The socket is
created inside the extension's app-sandbox container:

```text
/tmp/playhead-finalcut.sock
```

The TypeScript transport has bounded connection and response timeouts. It
rejects unavailable sockets and malformed or incompatible responses rather
than substituting fixture data.

The protocol and request shapes are documented in
[`docs/mcp/protocol.md`](../mcp/protocol.md).
