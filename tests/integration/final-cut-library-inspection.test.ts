import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildFinalCutLibraryInspectionScript,
  FinalCutLibraryInspectionProvider,
  FinalCutSessionAdapter,
  parseFinalCutLibraryInspectionResponse,
} from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import type { ContextRevision, EditorChange, EditorIdentity, EditorLiveState, RuntimeCapabilities } from "@framekit/runtime";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const execFile = promisify(execFileCallback);

const validResponse = JSON.stringify({
  version: 1,
  libraries: [{
    id: "library-1",
    name: "Library",
    events: [{
      id: "event-1",
      name: "Event",
      projects: [{
        id: "project-1",
        name: "Project",
        sequence: {
          id: "sequence-1",
          name: "Main",
          startTime: { value: "0", timescale: "24" },
          duration: { value: "240", timescale: "24" },
          frameDuration: { value: "1", timescale: "24" },
        },
      }],
    }],
  }],
});

test("parses library, event, project, and sequence metadata", () => {
  const result = parseFinalCutLibraryInspectionResponse(validResponse);

  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  const sequence = result.catalog.libraries[0]!.events[0]!.projects[0]!.sequences[0]!;
  assert.deepEqual(result.catalog.libraries[0], {
    id: "library-1",
    name: "Library",
    events: [{
      id: "event-1",
      name: "Event",
      projects: [{
        id: "project-1",
        name: "Project",
        sequences: [{
          id: "sequence-1",
          name: "Main",
          startTime: { status: "available", value: { value: "0", timescale: "24" } },
          duration: { status: "available", value: { value: "240", timescale: "24" } },
          frameDuration: { status: "available", value: { value: "1", timescale: "24" } },
        }],
      }],
    }],
  });
  assert.deepEqual(sequence.duration, {
    status: "available",
    value: { value: "240", timescale: "24" },
  });
});

test("preserves partial sequence timing as structured unavailable fields", () => {
  const partial = JSON.stringify({
    version: 1,
    libraries: [{
      id: "library-1",
      name: "Library",
      events: [{
        id: "event-1",
        name: "Event",
        projects: [{
          id: "project-1",
          name: "Project",
          sequence: {
            id: "sequence-1",
            name: "Main",
            startTime: { value: 0, timescale: 24 },
            duration: null,
            frameDuration: { value: "1", timescale: "24" },
          },
        }],
      }],
    }],
  });

  const result = parseFinalCutLibraryInspectionResponse(partial);

  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  const sequence = result.catalog.libraries[0]!.events[0]!.projects[0]!.sequences[0]!;
  assert.deepEqual(sequence.startTime, {
    status: "available",
    value: { value: "0", timescale: "24" },
  });
  assert.equal(sequence.duration.status, "unavailable");
  assert.equal(sequence.duration.issue.code, "FINAL_CUT_LIBRARY_FIELD_UNAVAILABLE");
  assert.equal(sequence.duration.issue.path, "libraries[0].events[0].projects[0].sequence.duration");
});

test("returns an actionable unavailable result when Apple Events fail", async () => {
  const provider = new FinalCutLibraryInspectionProvider({
    executor: async () => {
      throw new Error("osascript: Not authorized to send Apple events (-1743)");
    },
  });

  const result = await provider.inspect();

  assert.equal(result.status, "unavailable");
  if (result.status !== "unavailable") return;
  assert.equal(result.error.code, "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /Automation permission/);
});

test("builds a direct read-only Final Cut Apple Event script", () => {
  const script = buildFinalCutLibraryInspectionScript();

  assert.match(script, /Application\("com\.apple\.FinalCut"\)/);
  assert.match(script, /typeof member === "function"/);
  assert.match(script, /libraries/);
  assert.match(script, /events/);
  assert.match(script, /projects/);
  assert.match(script, /sequence/);
  assert.doesNotMatch(script, /System Events/);
  assert.doesNotMatch(script, /frontmost|activate|keystroke|click|AXPress/);
});

test("maps the rich inspection result to a project catalog", async () => {
  const provider = new FinalCutLibraryInspectionProvider({ executor: async () => validResponse });

  const catalog = await provider.listProjects();

  assert.deepEqual(catalog, {
    projects: [{
      id: "project-1",
      name: "Project",
      sequences: [{ id: "sequence-1", name: "Main" }],
    }],
  });
});

test("rejects duplicate stable project identities", async () => {
  const duplicate = JSON.parse(validResponse) as {
    libraries: Array<{ events: Array<{ projects: unknown[] }> }>;
  };
  duplicate.libraries[0]!.events[0]!.projects.push(
    duplicate.libraries[0]!.events[0]!.projects[0],
  );
  const provider = new FinalCutLibraryInspectionProvider({
    executor: async () => JSON.stringify(duplicate),
  });

  await assert.rejects(
    provider.listProjects(),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "FINAL_CUT_LIBRARY_RESPONSE_INVALID",
  );
});

test("marks a missing project sequence as partial", () => {
  const response = JSON.parse(validResponse) as {
    libraries: Array<{ events: Array<{ projects: Array<Record<string, unknown>> }> }>;
  };
  delete response.libraries[0]!.events[0]!.projects[0]!.sequence;

  const result = parseFinalCutLibraryInspectionResponse(JSON.stringify(response));

  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  assert.equal(result.catalog.libraries[0]!.events[0]!.projects[0]!.sequences.length, 0);
  assert.equal(result.issues[0]?.path, "libraries[0].events[0].projects[0].sequence");
});

test("routes live project listing through background inspection", async () => {
  const identity: EditorIdentity = {
    name: "Final Cut Pro",
    version: "10.7.1",
    backend: "workflow-extension-ipc",
  };
  const capabilities: RuntimeCapabilities = {
    editor: {
      projectRead: false,
      timelineSnapshotRead: false,
      timelineWrite: false,
      timelineArtifactWrite: false,
      readAfterWrite: false,
      incrementalChanges: true,
      rollback: false,
      assetDiscovery: false,
      liveStateRead: true,
      playheadWrite: false,
      frameCapture: false,
      projectCatalogRead: false,
      projectSelection: false,
    },
    analyzers: {
      speechTranscribe: false,
      speechVad: false,
      audioLoudness: false,
      visualTrack: false,
    },
  };
  const live = {
    getIdentity: async () => identity,
    getCapabilities: async () => capabilities,
    readLiveState: async (): Promise<EditorLiveState> => ({
      project: { id: "project-1", name: "Project" },
      sequence: {
        id: "sequence-1",
        name: "Main",
        startTime: { value: "0", timescale: "24" },
        duration: { value: "240", timescale: "24" },
        frameDuration: { value: "1", timescale: "24" },
      },
      revision: { id: "live-1", sequence: 1, timestamp: new Date(1).toISOString() },
    }),
    liveChangesSince: async (_revision: ContextRevision, _waitMs?: number): Promise<EditorChange[]> => [],
  };
  const session = new FinalCutSessionAdapter({
    live,
    backgroundCatalog: new FinalCutLibraryInspectionProvider({ executor: async () => validResponse }),
  });

  const catalog = await session.listProjects();
  const sessionCapabilities = await session.getCapabilities();

  assert.equal(catalog.projects[0]?.id, "project-1");
  assert.equal(catalog.activeProjectId, "project-1");
  assert.equal(catalog.activeSequenceId, "sequence-1");
  assert.equal(catalog.provenance?.catalog.source, "background-library");
  assert.equal(sessionCapabilities.editor.projectCatalogRead, true);
  assert.equal(sessionCapabilities.editor.projectSelection, false);
});

test("MCP project.list returns structured background inspection failures", async () => {
  const session = new FinalCutSessionAdapter({
    backgroundCatalog: new FinalCutLibraryInspectionProvider({
      executor: async () => {
        throw new Error("Final Cut library Apple Events are unavailable: app is not running");
      },
    }),
  });
  const server = createMcpServer(new AgentVideoRuntime(session));
  const client = new Client({ name: "library-inspection-mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "project.list", arguments: {} });
    assert.equal(result.isError, true);
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    if (!content || content.type !== "text" || typeof content.text !== "string") return;
    const payload = JSON.parse(content.text) as { code?: string; message?: string; retryable?: boolean };
    assert.equal(payload.code, "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE");
    assert.match(payload.message ?? "", /Apple Events are unavailable/);
    assert.equal(payload.retryable, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("documents the background library inspection safety boundary", async () => {
  const documentation = await readFile(join(repositoryRoot, "docs/final-cut/background-library-inspection.md"), "utf8");
  const finalCutGuide = await readFile(join(repositoryRoot, "docs/final-cut/README.md"), "utf8");
  const liveGuide = await readFile(join(repositoryRoot, "docs/mcp/final-cut-live.md"), "utf8");
  const compatibility = await readFile(join(repositoryRoot, "docs/COMPATIBILITY.md"), "utf8");

  assert.match(documentation, /com\.apple\.FinalCut\.library\.inspection/);
  assert.match(documentation, /direct Apple Events/);
  assert.match(documentation, /System Events/);
  assert.match(documentation, /metadata-only/);
  assert.match(documentation, /FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE/);
  assert.match(documentation, /Final Cut Pro 10\.7\.1/);
  assert.match(finalCutGuide, /background-library-inspection\.md/);
  assert.match(liveGuide, /background library inspection contract/);
  assert.match(compatibility, /bundled Workflow Extension \+ background library/);
});

const headedLibraryInspectionTest = process.env.FRAMEKIT_FINAL_CUT_LIBRARY_HEADED === "1" ? test : test.skip;

headedLibraryInspectionTest("read-only library inspection preserves frontmost application", async () => {
  const before = await frontmostBundleIdentifier();
  const result = await new FinalCutLibraryInspectionProvider().inspect();
  const after = await frontmostBundleIdentifier();

  assert.notEqual(result.status, "unavailable");
  assert.notEqual(result.status, "error");
  assert.equal(after, before);
});

async function frontmostBundleIdentifier(): Promise<string> {
  const source = [
    "import AppKit",
    "print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? \"\")",
  ].join(";");
  const result = await execFile("swift", ["-e", source], { maxBuffer: 10_000 });
  return result.stdout.trim();
}
