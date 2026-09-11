import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FinalCutAssetRegistry, FinalCutSessionAdapter } from "@framekit/final-cut";
import type { NativeFinalCutTitleMatch } from "@framekit/final-cut";
import { AgentVideoRuntime } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  if (typeof first?.text !== "string") throw new Error("MCP result did not contain text");
  return first.text;
}

test("Final Cut asset discovery composes stable filesystem and native title identities", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-title-assets-"));
  const bundle = join(root, "Titles.localized", "Lower Third.moti");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Lower Third</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const nativeTitle: NativeFinalCutTitleMatch = {
    id: "final-cut:title:fcp://title/lower-third",
    kind: "title",
    name: "Lower Third",
    vendor: "Final Cut Pro",
    identity: "fcp://title/lower-third",
  };

  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTitleProvider: {
      searchTitles: async () => [nativeTitle, { ...nativeTitle }],
    },
  });

  const assets = await registry.listAssets({ kind: "title", query: "lower" });

  assert.deepEqual(assets.map((asset) => asset.id), [
    `filesystem:title:${bundle}`,
    nativeTitle.id,
  ]);
  assert.deepEqual(assets.map((asset) => asset.metadata.provider), [
    "filesystem-motion-template",
    "final-cut-accessibility",
  ]);
  assert.equal(assets[0]?.metadata.path, bundle);
  assert.equal(assets[1]?.metadata.identity, nativeTitle.identity);
  assert.deepEqual(assets[0]?.metadata.discovery, {
    backend: "filesystem-motion-template",
    guarantee: "observed",
  });
  assert.deepEqual(assets[1]?.metadata.discovery, {
    backend: "final-cut-accessibility",
    guarantee: "observed",
  });
  assert.deepEqual(assets[1]?.metadata.placement, {
    backend: "final-cut-accessibility",
    guarantee: "native-verified",
    operation: "editor.native.title.add",
  });
});

test("Final Cut asset discovery propagates native browser unavailability", async () => {
  const registry = new FinalCutAssetRegistry({
    roots: [],
    nativeTitleProvider: {
      searchTitles: async () => {
        throw new Error("FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION: Accessibility permission is required");
      },
    },
  });

  await assert.rejects(
    registry.listAssets({ kind: "title" }),
    /FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION/,
  );
});

test("Final Cut asset discovery reports native unavailability with filesystem results", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-title-assets-diagnostic-"));
  const bundle = join(root, "Titles.localized", "Lower Third.moti");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Lower Third</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTitleProvider: {
      searchTitles: async () => {
        throw new Error("FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION: Accessibility permission is required");
      },
    },
  });

  const assets = await registry.listAssets({ kind: "title", query: "lower" });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0]?.metadata.discovery, {
    backend: "filesystem-motion-template",
    guarantee: "observed",
    native: {
      backend: "final-cut-accessibility",
      guarantee: "none",
      unavailableReason: "FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION: Accessibility permission is required",
    },
  });
});

test("MCP editor.assets exposes native title provenance", async () => {
  const nativeTitle: NativeFinalCutTitleMatch = {
    id: "final-cut:title:fcp://title/lower-third",
    kind: "title",
    name: "Lower Third",
    vendor: "Final Cut Pro",
    identity: "fcp://title/lower-third",
  };
  const editor = new FinalCutSessionAdapter({
    snapshot: new InMemoryEditorAdapter({
      projectId: "project-1",
      projectName: "Asset MCP Fixture",
      timelineId: "timeline-1",
      timelineName: "Main",
      clips: [],
    }),
    assets: new FinalCutAssetRegistry({
      roots: [],
      nativeTitleProvider: { searchTitles: async () => [nativeTitle] },
    }),
  });
  const server = createMcpServer(new AgentVideoRuntime(editor));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "asset-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const assets = JSON.parse(textFrom(await client.callTool({
      name: "editor.assets",
      arguments: { kind: "title", query: "lower" },
    })));
    assert.equal(assets[0].id, nativeTitle.id);
    assert.deepEqual(assets[0].metadata.discovery, {
      backend: "final-cut-accessibility",
      guarantee: "observed",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
