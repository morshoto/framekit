import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CommandAudioAnalyzer } from "@framekit/final-cut";
import type { NativeFinalCutEditor } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("Final Cut MCP composes FCPXML reads, local analysis, assets, edits, and undo", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-finalcut-mcp-"));
  const xmlPath = join(directory, "project.fcpxml");
  const mediaPath = join(directory, "interview.wav");
  const assetRoot = join(directory, "Motion Templates.localized", "Transitions.localized", "Cross Dissolve.motr", "Contents");
  await mkdir(assetRoot, { recursive: true });
  await writeFile(mediaPath, "fixture media");
  await writeFile(join(assetRoot, "Info.plist"), `<?xml version="1.0"?><plist><dict><key>CFBundleDisplayName</key><string>Cross Dissolve</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></dict></plist>`);
  await writeFile(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources><asset id="r1" name="Interview.wav" src="interview.wav" /></resources>
  <library><event name="Event"><project name="MCP Final Cut"><sequence duration="10s"><spine>
    <asset-clip ref="r1" name="Interview" offset="0s" start="0s" duration="10s" lane="1" />
  </spine></sequence></project></event></library>
</fcpxml>`);

  const speech = await makeAnalyzer(directory, JSON.stringify({ words: [{ text: "um", start: 0, end: 0.3, confidence: 0.98, filler: true }] }));
  const audio = await makeAnalyzer(directory, JSON.stringify({ integratedLufs: -18, truePeakDb: -3, silenceMs: 120 }));
  const visual = await makeAnalyzer(directory, JSON.stringify({
    scenes: [{ id: "scene-1", start: 0, end: 10, label: "interview", confidence: 0.97 }],
    subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 0, end: 10 }],
    motion: { score: 0.12, label: "low" },
    keyframes: [{ time: 1, source: mediaPath, labels: ["person"] }],
  }));

  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: {
      ...process.env,
      FRAMEKIT_EDITOR: "final-cut-live",
      FRAMEKIT_FINAL_CUT_HEADLESS: "0",
      FRAMEKIT_AUTO_CONNECT: "0",
      FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
      FRAMEKIT_FCPXML_PATH: xmlPath,
      FRAMEKIT_FINAL_CUT_ASSET_ROOTS: join(directory, "Motion Templates.localized"),
      FRAMEKIT_SPEECH_ANALYZER: speech,
      FRAMEKIT_AUDIO_ANALYZER: audio,
      FRAMEKIT_VISUAL_ANALYZER: visual,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "finalcut-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.identity.backend, "final-cut-session");
    assert.equal(editor.capabilities.editor.timelineSnapshotRead, true);
    assert.equal(editor.capabilities.editor.timelineArtifactWrite, true);
    assert.equal(editor.capabilities.editor.rollback, true);
    assert.equal(editor.capabilities.editor.assetDiscovery, true);
    assert.equal(editor.capabilities.analyzers.speechTranscribe, true);
    assert.equal(editor.capabilities.analyzers.audioLoudness, true);
    assert.equal(editor.capabilities.analyzers.visualTrack, true);

    const projectResult = await client.callTool({ name: "project.inspect", arguments: {} });
    const project = JSON.parse(textFrom(projectResult));
    assert.equal(project.projectName, "MCP Final Cut");
    assert.equal(project.media[0].source, mediaPath);

    const context = JSON.parse(textFrom(await client.callTool({ name: "context.inspect", arguments: {} })));
    assert.equal(context.project.projectName, "MCP Final Cut");
    if (context.editorState) assert.equal(context.editorState.project?.name, "Playhead Phase 1 E2E");

    const speechResult = JSON.parse(textFrom(await client.callTool({ name: "speech.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(speechResult.words[0].filler, true);
    const audioResult = JSON.parse(textFrom(await client.callTool({ name: "audio.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(audioResult.integratedLufs, -18);
    const visualResult = JSON.parse(textFrom(await client.callTool({ name: "visual.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(visualResult.subjects[0].label, "person");
    const understanding = JSON.parse(textFrom(await client.callTool({ name: "media.understand", arguments: { mediaId: "r1" } })));
    assert.equal(understanding.visual.scenes[0].label, "interview");

    const assets = JSON.parse(textFrom(await client.callTool({ name: "editor.assets", arguments: { query: "dissolve" } })));
    assert.equal(assets[0].name, "Cross Dissolve");

    const edited = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit",
      arguments: { type: "rename-clip", clipId: project.timeline.clips[0].id, name: "Interview Clean", baseRevision: project.revision },
    })));
    assert.equal(edited.status, "VERIFIED");
    assert.equal(edited.after.timeline.clips[0].name, "Interview Clean");

    const diff = JSON.parse(textFrom(await client.callTool({ name: "edit.diff", arguments: { transactionId: edited.id } })));
    assert.equal(diff.modified[0].after.name, "Interview Clean");
    const verification = JSON.parse(textFrom(await client.callTool({ name: "edit.verify", arguments: { transactionId: edited.id } })));
    assert.equal(verification.passed, true);
    const undone = JSON.parse(textFrom(await client.callTool({ name: "edit.undo", arguments: { transactionId: edited.id } })));
    assert.equal(undone.timeline.clips[0].name, "Interview");
  } finally {
    await client.close();
    await transport.close();
  }
});

test("local analyzer commands fail closed for unavailable media and invalid output", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-analyzer-errors-"));
  const mediaPath = join(directory, "media.wav");
  await writeFile(mediaPath, "fixture media");
  const invalid = await makeAnalyzer(directory, JSON.stringify({ integratedLufs: -18 }));
  const analyzer = new CommandAudioAnalyzer({ command: invalid });
  const input = {
    project: {
      projectId: "project-1",
      projectName: "Analyzer Test",
      timeline: { id: "timeline-1", name: "Timeline", duration: 1, clips: [], storyElements: [], markers: [], captions: [] },
      media: [{ mediaId: "media-1", source: mediaPath }],
      revision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
    },
    media: { mediaId: "media-1", source: mediaPath },
  };
  await assert.rejects(analyzer.analyze(input), /ANALYZER_INVALID_OUTPUT/);
  await assert.rejects(analyzer.analyze({ ...input, media: { mediaId: "media-1", source: join(directory, "missing.wav") } }), /ANALYZER_MEDIA_UNAVAILABLE/);
});

test("Final Cut live MCP exposes native range contracts and capabilities", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-native-mcp-contract-"));
  const socketPath = join(directory, "bridge.sock");
  const bridge = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; version: number; method: string };
      const result = request.method === "state"
        ? {
            identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
            capabilities: {
              editor: {
                projectRead: true,
                timelineSnapshotRead: false,
                timelineWrite: false,
                timelineArtifactWrite: false,
                readAfterWrite: false,
                incrementalChanges: true,
                rollback: false,
                assetDiscovery: false,
                liveStateRead: true,
                playheadWrite: false,
                playbackControl: false,
              },
              analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
            },
            state: {
              project: { id: "project-1", name: "Contract Test" },
              sequence: { id: "sequence-1", name: "Contract Test", startTime: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" }, frameDuration: { value: "1", timescale: "24" } },
              playheadTime: { value: "0", timescale: "1" },
              sequenceTimeRange: { start: { value: "0", timescale: "1" }, duration: { value: "10", timescale: "1" } },
              revision: { id: "rev-1", sequence: 1, timestamp: new Date(0).toISOString() },
            },
          }
        : {
            identity: { name: "Final Cut Pro", version: "test", backend: "workflow-extension-ipc" },
            capabilities: {
              editor: {
                projectRead: true,
                timelineSnapshotRead: false,
                timelineWrite: false,
                timelineArtifactWrite: false,
                readAfterWrite: false,
                incrementalChanges: true,
                rollback: false,
                assetDiscovery: false,
                liveStateRead: true,
                playheadWrite: false,
                playbackControl: false,
              },
              analyzers: { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false },
            },
          };
      socket.end(`${JSON.stringify({ version: request.version, id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: {
      ...process.env,
      FRAMEKIT_EDITOR: "final-cut-live",
      FRAMEKIT_FINAL_CUT_HEADLESS: "0",
      FRAMEKIT_AUTO_CONNECT: "0",
      FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "1",
      FRAMEKIT_FINAL_CUT_SOCKET: socketPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "native-contract-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const deletePreview = tools.tools.find((tool) => tool.name === "editor.native.delete-range.preview");
    const trimPreview = tools.tools.find((tool) => tool.name === "editor.native.trim-to-duration.preview");
    assert.ok(deletePreview);
    assert.ok(trimPreview);
    assert.deepEqual(Object.keys(deletePreview.inputSchema.properties ?? {}).sort(), ["end", "start"]);
    assert.deepEqual(Object.keys(trimPreview.inputSchema.properties ?? {}).sort(), ["duration"]);

    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.native.deleteRange, true);
    assert.equal(editor.native.trimToDuration, true);
    assert.equal(editor.native.mediaAppend, true);
    assert.equal(editor.native.mediaInsert, true);
    assert.equal(editor.native.timelineFocus, true);

    const native = JSON.parse(textFrom(await client.callTool({ name: "editor.native.inspect", arguments: {} })));
    assert.equal(typeof native.timelineWindowAvailable, "boolean");
    assert.equal(typeof native.timelineFocused, "boolean");
    assert.ok(["timeline", "browser", "text-field", "modal", "unknown", "none"].includes(native.focusTarget));
    if (native.error) {
      assert.match(native.error.code, /^FINAL_CUT_NATIVE_/);
      assert.equal(typeof native.error.message, "string");
    }
    const focus = JSON.parse(textFrom(await client.callTool({ name: "editor.native.focus", arguments: {} })));
    assert.equal(typeof focus.timelineWindowAvailable, "boolean");
    assert.equal(typeof focus.timelineFocused, "boolean");
    assert.ok(["timeline", "browser", "text-field", "modal", "unknown", "none"].includes(focus.focusTarget));

    const preview = await client.callTool({
      name: "editor.native.delete-range.preview",
      arguments: {
        start: { value: "1", timescale: "1" },
        end: { value: "2", timescale: "1" },
      },
    });
    if (preview.isError) {
      assert.match(textFrom(preview), /FINAL_CUT_NATIVE_/);
    } else {
      const payload = JSON.parse(textFrom(preview));
      assert.equal(payload.operation, "delete-range");
      assert.equal(typeof payload.previewToken, "string");
    }
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  }
});

test("Final Cut MCP preserves overlay-blocked focus diagnostics", async () => {
  const nativeContext = {
    available: false,
    application: "Final Cut Pro" as const,
    frontmost: true,
    frontWindow: "Final Cut Pro",
    timelineWindowAvailable: true,
    timelineFocused: false,
    focusTarget: "unknown" as const,
    focusedWindowName: "Framekit",
    framekitWindowAvailable: true,
    framekitWindowMinimized: false,
    overlayBlocked: true,
    target: { kind: "playhead" as const },
    bladeAvailable: false,
    undoAvailable: false,
    error: {
      code: "FINAL_CUT_NATIVE_OVERLAY_BLOCKED",
      message: "The Framekit window could not be minimized; close or minimize the overlay and retry",
    },
  };
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      timelineFocus: true,
      requiresAccessibility: true as const,
      requiresFinalCutFrontmost: true as const,
    }),
    inspect: async () => nativeContext,
    focusTimeline: async () => nativeContext,
  } as unknown as NativeFinalCutEditor;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "MCP Overlay Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { nativeEditor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "overlay-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inspect = JSON.parse(textFrom(await client.callTool({ name: "editor.native.inspect", arguments: {} })));
    const focus = JSON.parse(textFrom(await client.callTool({ name: "editor.native.focus", arguments: {} })));
    for (const response of [inspect, focus]) {
      assert.equal(response.error.code, "FINAL_CUT_NATIVE_OVERLAY_BLOCKED");
      assert.equal(response.focusedWindowName, "Framekit");
      assert.equal(response.framekitWindowAvailable, true);
      assert.equal(response.framekitWindowMinimized, false);
      assert.equal(response.overlayBlocked, true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("Final Cut MCP exposes deterministic append and insert media workflows", async () => {
  const nativeContext = {
    available: true,
    application: "Final Cut Pro" as const,
    frontmost: true,
    frontWindow: "Final Cut Pro",
    timelineWindowAvailable: true,
    timelineFocused: true,
    focusTarget: "timeline" as const,
    target: { kind: "playhead" as const },
    bladeAvailable: false,
    undoAvailable: true,
    undoCommand: "Undo Append",
  };
  const media = { handle: "media-1", name: "Interview", role: "AXBrowserMedia" };
  const preview = {
    previewToken: "append-preview-1",
    operation: "append" as const,
    media,
    beforeDuration: { value: "10", timescale: "1" },
    insertionTime: { value: "10", timescale: "1" },
    sequenceId: "sequence-1",
    revision: "rev-1",
    command: "Append selected media" as const,
    expiresAt: new Date(30_000).toISOString(),
  };
  const result = {
    operationId: "native-append-1",
    previewToken: preview.previewToken,
    operation: preview.operation,
    media,
    before: nativeContext,
    after: nativeContext,
    beforeDuration: preview.beforeDuration,
    afterDuration: { value: "15", timescale: "1" },
    beforeRevision: { id: "rev-1", sequence: 1, timestamp: new Date(1).toISOString() },
    afterRevision: { id: "rev-2", sequence: 2, timestamp: new Date(2).toISOString() },
    verification: { verified: true, detail: "verified" },
    undoAvailable: true,
    undoCommand: "Undo Append",
  };
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      mediaAppend: true,
      mediaInsert: true,
      timelineFocus: true,
      requiresAccessibility: true as const,
      requiresFinalCutFrontmost: true as const,
    }),
    inspect: async () => nativeContext,
    focusTimeline: async () => nativeContext,
    previewAppendMedia: async () => preview,
    executeAppendMedia: async () => result,
    previewInsertMedia: async () => ({ ...preview, operation: "insert" as const, command: "Insert selected media at playhead" as const }),
    executeInsertMedia: async () => ({ ...result, operation: "insert" as const }),
    undo: async () => ({ operationId: result.operationId, undone: true, context: nativeContext, verification: { verified: true, detail: "restored" } }),
  } as unknown as NativeFinalCutEditor;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "MCP Media Insertion Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { nativeEditor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "media-insertion-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const name of [
      "editor.native.media.append.preview",
      "editor.native.media.append.execute",
      "editor.native.media.insert.preview",
      "editor.native.media.insert.execute",
    ]) assert.ok(tools.tools.find((tool) => tool.name === name));

    const appendPreview = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.media.append.preview",
      arguments: { mediaHandle: media.handle },
    })));
    assert.equal(appendPreview.operation, "append");
    const appendResult = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.media.append.execute",
      arguments: { previewToken: appendPreview.previewToken },
    })));
    assert.equal(appendResult.verification.verified, true);
    assert.equal(appendResult.afterRevision.id, "rev-2");

    const insertPreview = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.media.insert.preview",
      arguments: { mediaHandle: media.handle },
    })));
    assert.equal(insertPreview.operation, "insert");
    const insertResult = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.media.insert.execute",
      arguments: { previewToken: insertPreview.previewToken },
    })));
    assert.equal(insertResult.operation, "insert");
    const undone = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.undo",
      arguments: { operationId: appendResult.operationId },
    })));
    assert.equal(undone.undone, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Final Cut MCP exposes the native Undo command and preserves Undo errors", async () => {
  const nativeContext = {
    available: true,
    application: "Final Cut Pro" as const,
    frontmost: true,
    frontWindow: "Final Cut Pro",
    timelineWindowAvailable: true,
    timelineFocused: true,
    focusTarget: "timeline" as const,
    focusedWindowName: "Final Cut Pro",
    framekitWindowAvailable: true,
    framekitWindowMinimized: true,
    overlayBlocked: false,
    target: { kind: "playhead" as const },
    bladeAvailable: false,
    undoAvailable: true,
    undoCommand: "Undo Delete Range",
  };
  const nativeEditor = {
    capabilities: () => ({
      selectionEdit: true,
      undo: true,
      mediaLibrarySearch: true,
      mediaSelection: true,
      timelineOccurrenceLocate: true,
      bladeAtPlayhead: true,
      deleteRange: true,
      trimToDuration: true,
      timelineFocus: true,
      requiresAccessibility: true as const,
      requiresFinalCutFrontmost: true as const,
    }),
    inspect: async () => nativeContext,
    focusTimeline: async () => nativeContext,
    undo: async () => {
      throw new Error("FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED: Final Cut's current Undo command does not match the native edit");
    },
  } as unknown as NativeFinalCutEditor;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "MCP Undo Test",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { nativeEditor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "undo-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const inspect = JSON.parse(textFrom(await client.callTool({ name: "editor.native.inspect", arguments: {} })));
    assert.equal(inspect.undoAvailable, true);
    assert.equal(inspect.undoCommand, "Undo Delete Range");
    const response = await client.callTool({ name: "editor.native.undo", arguments: { operationId: "native-range-1" } });
    assert.equal(response.isError, true);
    assert.match(textFrom(response), /FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED/);
  } finally {
    await client.close();
    await server.close();
  }
});

async function makeAnalyzer(directory: string, output: string): Promise<string> {
  const path = join(directory, `analyzer-${Math.random().toString(16).slice(2)}.sh`);
  await writeFile(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${output.replaceAll("'", "'\\''")}'\n`);
  await chmod(path, 0o755);
  return path;
}
