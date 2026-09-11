import assert from "node:assert/strict";
import test from "node:test";
import { resolveEditingIntent } from "@framekit/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}

test("editing intent maps cut-and-remove-the-rest to trim_to_duration", () => {
  assert.deepEqual(resolveEditingIntent("Cut at 30 seconds and remove the rest"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.trim-to-duration.preview",
    operation: {
      type: "trim_to_duration",
      duration: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "tail",
      start: { value: "30", timescale: "1" },
      end: "sequence-end",
    },
  });
});

test("editing intent maps a blade request to blade_at_playhead", () => {
  assert.deepEqual(resolveEditingIntent("Blade at 30 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.blade.preview",
    operation: {
      type: "blade_at_playhead",
      playheadTime: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "playhead",
      at: { value: "30", timescale: "1" },
    },
  });
});

test("editing intent maps a range removal to delete_range", () => {
  assert.deepEqual(resolveEditingIntent("Remove 10–15 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.delete-range.preview",
    operation: {
      type: "delete_range",
      range: {
        start: { value: "10", timescale: "1" },
        end: { value: "15", timescale: "1" },
      },
    },
    affectedRange: {
      kind: "range",
      start: { value: "10", timescale: "1" },
      end: { value: "15", timescale: "1" },
    },
  });
});

test("editing intent asks for clarification without selecting an operation", () => {
  assert.deepEqual(resolveEditingIntent("Cut this part out"), {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Which editing operation should Framekit perform?",
    options: ["trim_to_duration", "blade_at_playhead", "delete_range"],
  });
});

test("editing intent does not select delete_range for a reversed range", () => {
  assert.equal(resolveEditingIntent("Remove 15-10 seconds").status, "clarification_required");
});

test("editing intent does not select delete_range for a zero-length range", () => {
  assert.equal(resolveEditingIntent("Remove 10-10 seconds").status, "clarification_required");
});

test("editing intent preserves high-precision decimal seconds as a rational time", () => {
  const resolution = resolveEditingIntent("Cut at 0.12345678901234567890 seconds and remove the rest");
  assert.equal(resolution.status, "resolved");
  if (resolution.status === "resolved") {
    assert.equal(resolution.operation.type, "trim_to_duration");
    if (resolution.operation.type === "trim_to_duration") {
      assert.deepEqual(resolution.operation.duration, {
        value: "12345678901234567890",
        timescale: "100000000000000000000",
      });
    }
  }
});

test("editing intent compares high-precision delete bounds exactly", () => {
  const resolution = resolveEditingIntent("Remove 9007199254740992-9007199254740993 seconds");
  assert.equal(resolution.status, "resolved");
  if (resolution.status === "resolved") {
    assert.equal(resolution.operation.type, "delete_range");
  }
});

test("MCP exposes the resolved operation, affected range, and preview requirement", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Intent Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editing-intent-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "editing.intent.resolve"));
    const resolved = JSON.parse(textFrom(await client.callTool({
      name: "editing.intent.resolve",
      arguments: { request: "Remove 10–15 seconds" },
    })));
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.operation.type, "delete_range");
    assert.equal(resolved.previewTool, "editor.native.delete-range.preview");
    assert.deepEqual(resolved.affectedRange, {
      kind: "range",
      start: { value: "10", timescale: "1" },
      end: { value: "15", timescale: "1" },
    });
    assert.equal(resolved.previewRequired, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP intent resolution does not select or preview an ambiguous request", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Intent Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editing-intent-ambiguity-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const ambiguous = JSON.parse(textFrom(await client.callTool({
      name: "editing.intent.resolve",
      arguments: { request: "Cut this part out" },
    })));
    assert.equal(ambiguous.status, "clarification_required");
    assert.equal(ambiguous.operation, undefined);
    assert.equal(ambiguous.previewRequired, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("editing intent maps local media import to the native import workflow", () => {
  assert.deepEqual(resolveEditingIntent('Import "/tmp/framekit-Interview Clip.mov"'), {
    status: "resolved",
    destructive: false,
    previewRequired: false,
    operation: {
      type: "media_import",
      path: "/tmp/framekit-Interview Clip.mov",
      targetProject: "active",
    },
    requiredCapabilities: ["native.mediaImport"],
    requiredParameters: ["path"],
    workflow: ["editor.native.media.import"],
  });
});

test("editing intent maps Browser media selection to the native select workflow", () => {
  assert.deepEqual(resolveEditingIntent("Select Browser media with handle media-42"), {
    status: "resolved",
    destructive: false,
    previewRequired: false,
    operation: {
      type: "media_select",
      mediaHandle: "media-42",
    },
    requiredCapabilities: ["native.mediaSelection"],
    requiredParameters: ["mediaHandle"],
    workflow: ["editor.native.media.select"],
  });
});

test("editing intent maps append-selected to its guarded preview and execute pair", () => {
  assert.deepEqual(resolveEditingIntent("Append the selected media to the active timeline"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.media.append.selected.preview",
    executeTool: "editor.native.media.append.selected.execute",
    operation: {
      type: "media_append_selected",
      targetProject: "active",
      placement: "append",
    },
    requiredCapabilities: ["native.mediaAppendSelected"],
    requiredParameters: ["project", "placement"],
    workflow: [
      "editor.native.media.append.selected.preview",
      "editor.native.media.append.selected.execute",
    ],
  });
});

test("editing intent maps append-by-handle through selection and guarded append", () => {
  assert.deepEqual(resolveEditingIntent("Append media with handle media-42 to the timeline"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.media.append.preview",
    executeTool: "editor.native.media.append.execute",
    operation: {
      type: "media_append",
      mediaHandle: "media-42",
      targetProject: "active",
      placement: "append",
    },
    requiredCapabilities: ["native.mediaSelection", "native.mediaAppend"],
    requiredParameters: ["mediaHandle", "project", "placement"],
    workflow: [
      "editor.native.media.select",
      "editor.native.media.append.preview",
      "editor.native.media.append.execute",
    ],
  });
});

test("editing intent maps insert-at-playhead through selection and guarded insert", () => {
  assert.deepEqual(resolveEditingIntent("Insert media with handle media-42 at the playhead"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.media.insert.preview",
    executeTool: "editor.native.media.insert.execute",
    operation: {
      type: "media_insert",
      mediaHandle: "media-42",
      targetProject: "active",
      placement: "insert",
    },
    requiredCapabilities: ["native.mediaSelection", "native.mediaInsert"],
    requiredParameters: ["mediaHandle", "project", "placement"],
    workflow: [
      "editor.native.media.select",
      "editor.native.media.insert.preview",
      "editor.native.media.insert.execute",
    ],
  });
});

test("editing intent keeps import-then-append as explicit native stages", () => {
  assert.deepEqual(resolveEditingIntent('Import "/tmp/framekit-Interview.mov" and append it to the active timeline'), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    previewTool: "editor.native.media.append.preview",
    executeTool: "editor.native.media.append.execute",
    operation: {
      type: "media_import_then_append",
      path: "/tmp/framekit-Interview.mov",
      targetProject: "active",
      placement: "append",
    },
    requiredCapabilities: ["native.mediaImport", "native.mediaSelection", "native.mediaAppend"],
    requiredParameters: ["path", "project", "placement"],
    workflow: [
      "editor.native.media.import",
      "editor.native.media.select",
      "editor.native.media.append.preview",
      "editor.native.media.append.execute",
    ],
  });
});

test("editing intent asks for a path rather than inventing one for an import request", () => {
  assert.deepEqual(resolveEditingIntent("Import this video and append it to the active timeline"), {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Which local media path should Framekit import before appending?",
    options: ["media_import_then_append", "media_import"],
  });
});

test("editing intent asks whether append should use a handle or current selection", () => {
  assert.deepEqual(resolveEditingIntent("Append media to the active timeline"), {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Should Framekit append the currently selected Browser media or use a media handle?",
    options: ["media_append_selected", "media_append"],
  });
});

test("editing intent fails closed when a required native capability is unavailable", () => {
  assert.deepEqual(resolveEditingIntent("Insert media with handle media-42 at the playhead", {
    availableCapabilities: {
      "native.mediaSelection": true,
      "native.mediaInsert": false,
    },
  }), {
    status: "capability_unavailable",
    destructive: true,
    previewRequired: false,
    question: "The connected editor cannot perform this native media operation.",
    options: ["media_insert"],
    requiredCapabilities: ["native.mediaSelection", "native.mediaInsert"],
    missingCapabilities: ["native.mediaInsert"],
  });
});

test("MCP intent resolution reports unavailable native media capabilities", async () => {
  const server = createMcpServer(new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Intent Fixture",
    timelineId: "timeline-1",
    timelineName: "Main Edit",
    clips: [],
  })));
  const client = new Client({ name: "editing-intent-capability-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const unavailable = JSON.parse(textFrom(await client.callTool({
      name: "editing.intent.resolve",
      arguments: { request: "Append selected media to the active timeline" },
    })));
    assert.equal(unavailable.status, "capability_unavailable");
    assert.deepEqual(unavailable.missingCapabilities, ["native.mediaAppendSelected"]);
    assert.deepEqual(unavailable.options, ["media_append_selected"]);
  } finally {
    await client.close();
    await server.close();
  }
});
