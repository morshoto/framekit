import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DisposableNativeEditWorkflow } from "@framekit/final-cut";
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

test("MCP exposes disposable native preview, execute, and undo workflow calls", async () => {
  const calls: string[] = [];
  const disposableNative = {
    preview: async (request: unknown) => {
      calls.push(`preview:${JSON.stringify(request)}`);
      return { previewToken: "preview-1", request };
    },
    execute: async (previewToken: string) => {
      calls.push(`execute:${previewToken}`);
      return { status: "VERIFIED", operationId: "operation-1" };
    },
    undo: async (operationId: string) => {
      calls.push(`undo:${operationId}`);
      return { undone: true, operationId };
    },
  } as unknown as Pick<DisposableNativeEditWorkflow, "preview" | "execute" | "undo">;
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { disposableNative });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "disposable-native-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const previewTool = tools.tools.find((tool) => tool.name === "editor.native.disposable.preview");
    assert.deepEqual(Object.keys(previewTool?.inputSchema.properties ?? {}).sort(), ["baseRevision", "clipId", "name"]);
    assert.deepEqual(previewTool?.inputSchema.required, ["clipId", "name"]);

    const preview = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.preview",
      arguments: { clipId: "clip-1", name: "Renamed" },
    })));
    const executed = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.execute",
      arguments: { previewToken: preview.previewToken },
    })));
    const undone = JSON.parse(textFrom(await client.callTool({
      name: "editor.native.disposable.undo",
      arguments: { operationId: executed.operationId },
    })));

    assert.equal(executed.status, "VERIFIED");
    assert.equal(undone.undone, true);
    assert.deepEqual(calls, [
      'preview:{"clipId":"clip-1","name":"Renamed"}',
      "execute:preview-1",
      "undo:operation-1",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP keeps disposable native edits fail closed when not configured", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "disposable-native-mcp-unavailable-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "editor.native.disposable.execute",
      arguments: { previewToken: "missing" },
    });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /CAPABILITY_UNAVAILABLE: disposable native edit is not configured/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes resumable native operation submit, status, retry, and cancel tools", async () => {
  const calls: string[] = [];
  const job = {
    jobId: "native-job-1",
    operation: "disposable.rename-clip",
    previewToken: "preview-1",
    projectId: "project-1",
    sequenceId: "sequence-1",
    targetIdentity: "clip-1",
    baseRevision: { id: "revision-1", sequence: 1, timestamp: "2026-09-13T00:00:00.000Z" },
    idempotencyKey: "request-1",
    state: "waiting_for_final_cut",
    accepted: true,
    completed: false,
    verified: false,
    restored: false,
    cancelRequested: false,
    submittedAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2026-09-13T00:01:00.000Z",
    readiness: {
      state: "unavailable",
      nextAction: "retry",
      retryable: true,
      firstMissing: "frontmost",
      frontmost: false,
      timelineFocus: false,
      selectedTarget: true,
      overlay: "clear",
      permission: "granted",
      undo: "unknown",
      guidance: "Bring Final Cut Pro to the front and retry",
    },
    error: { code: "FINAL_CUT_NATIVE_NOT_FRONTMOST", message: "Final Cut is not frontmost", retryable: true },
  };
  const nativeOperationSession = {
    submit: async (request: unknown) => {
      calls.push(`submit:${JSON.stringify(request)}`);
      return job;
    },
    status: (jobId: string) => {
      calls.push(`status:${jobId}`);
      return job;
    },
    retry: async (jobId: string) => {
      calls.push(`retry:${jobId}`);
      return { ...job, state: "completed", completed: true, verified: true };
    },
    cancel: async (jobId: string) => {
      calls.push(`cancel:${jobId}`);
      return { ...job, state: "cancelled" };
    },
  };
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "sequence-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime, { nativeOperationSession: nativeOperationSession as never });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-operation-session-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const submitTool = tools.tools.find((tool) => tool.name === "editor.native.operation.submit");
    assert.deepEqual(submitTool?.inputSchema.required?.slice().sort(), [
      "baseRevision",
      "idempotencyKey",
      "operation",
      "previewToken",
      "projectId",
      "sequenceId",
      "targetIdentity",
    ]);
    assert.ok(tools.tools.find((tool) => tool.name === "editor.native.operation.status"));
    assert.ok(tools.tools.find((tool) => tool.name === "editor.native.operation.retry"));
    assert.ok(tools.tools.find((tool) => tool.name === "editor.native.operation.cancel"));

    const binding = {
      operation: "disposable.rename-clip",
      previewToken: "preview-1",
      projectId: "project-1",
      sequenceId: "sequence-1",
      targetIdentity: "clip-1",
      baseRevision: { id: "revision-1", sequence: 1, timestamp: "2026-09-13T00:00:00.000Z" },
      idempotencyKey: "request-1",
    };
    const submitted = JSON.parse(textFrom(await client.callTool({ name: "editor.native.operation.submit", arguments: binding })));
    const status = JSON.parse(textFrom(await client.callTool({ name: "editor.native.operation.status", arguments: { jobId: submitted.jobId } })));
    const retried = JSON.parse(textFrom(await client.callTool({ name: "editor.native.operation.retry", arguments: { jobId: status.jobId } })));
    const cancelled = JSON.parse(textFrom(await client.callTool({ name: "editor.native.operation.cancel", arguments: { jobId: retried.jobId } })));

    assert.equal(status.state, "waiting_for_final_cut");
    assert.equal(retried.completed, true);
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(calls, [
      `submit:${JSON.stringify(binding)}`,
      "status:native-job-1",
      "retry:native-job-1",
      "cancel:native-job-1",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP keeps resumable native operations fail closed when not configured", async () => {
  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter({
    projectId: "project-1",
    projectName: "Disposable MCP",
    timelineId: "timeline-1",
    timelineName: "Main",
    clips: [],
    media: [],
  }));
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-operation-session-unavailable-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "editor.native.operation.status", arguments: { jobId: "missing" } });
    assert.equal(result.isError, true);
    assert.match(textFrom(result), /CAPABILITY_UNAVAILABLE: native operation session is not configured/);
  } finally {
    await client.close();
    await server.close();
  }
});
