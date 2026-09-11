import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FinalCutAssetRegistry, FinalCutSessionAdapter } from "@framekit/final-cut";
import type { NativeFinalCutTitleMatch, NativeFinalCutTransitionMatch } from "@framekit/final-cut";
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

test("Final Cut asset discovery composes stable filesystem and native transition identities", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-transition-assets-"));
  const bundle = join(root, "Transitions.localized", "Cross Dissolve.motr");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Cross Dissolve</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const nativeTransition: NativeFinalCutTransitionMatch = {
    id: "final-cut:transition:fcp://transition/cross",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Final Cut Pro",
    identity: "fcp://transition/cross",
  };

  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTransitionProvider: {
      searchTransitions: async () => [nativeTransition, { ...nativeTransition }],
    },
  });

  const assets = await registry.listAssets({ kind: "transition", query: "dissolve" });

  assert.deepEqual(assets.map((asset) => asset.id), [
    `filesystem:transition:${bundle}`,
    nativeTransition.id,
  ]);
  assert.deepEqual(assets.map((asset) => asset.metadata.provider), [
    "filesystem-motion-template",
    "final-cut-accessibility",
  ]);
  assert.equal(assets[0]?.metadata.path, bundle);
  assert.equal(assets[1]?.metadata.identity, nativeTransition.identity);
  assert.deepEqual(assets[1]?.metadata.discovery, {
    backend: "final-cut-accessibility",
    guarantee: "observed",
  });
  assert.deepEqual(assets[1]?.metadata.placement, {
    backend: "final-cut-accessibility",
    guarantee: "native-verified",
    operation: "editor.native.transition.add.preview",
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

test("Final Cut asset discovery fails closed on empty native title results", async () => {
  const registry = new FinalCutAssetRegistry({
    roots: [],
    nativeTitleProvider: {
      searchTitles: async () => [],
    },
  });

  await assert.rejects(
    registry.listAssets({ kind: "title" }),
    /FINAL_CUT_NATIVE_TITLE_DISCOVERY_EMPTY/,
  );
});

test("Final Cut asset discovery preserves filesystem titles when native discovery is empty", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-title-assets-empty-native-"));
  const bundle = join(root, "Titles.localized", "Lower Third.moti");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Lower Third</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTitleProvider: {
      searchTitles: async () => [],
    },
  });

  const assets = await registry.listAssets({ kind: "title" });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0]?.metadata.discovery, {
    backend: "filesystem-motion-template",
    guarantee: "observed",
    native: {
      backend: "final-cut-accessibility",
      guarantee: "none",
      unavailableReason: "FINAL_CUT_NATIVE_TITLE_DISCOVERY_EMPTY: native title provider returned no title assets",
    },
  });
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

test("Final Cut transition discovery reports native unavailability with filesystem results", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-transition-assets-diagnostic-"));
  const bundle = join(root, "Transitions.localized", "Cross Dissolve.motr");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Cross Dissolve</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTransitionProvider: {
      searchTransitions: async () => {
        throw new Error("FINAL_CUT_NATIVE_TRANSITION_BROWSER_PERMISSION: Accessibility permission is required");
      },
    },
  });

  const assets = await registry.listAssets({ kind: "transition", query: "dissolve" });

  assert.equal(assets.length, 1);
  assert.deepEqual(assets[0]?.metadata.discovery, {
    backend: "filesystem-motion-template",
    guarantee: "observed",
    native: {
      backend: "final-cut-accessibility",
      guarantee: "none",
      unavailableReason: "FINAL_CUT_NATIVE_TRANSITION_BROWSER_PERMISSION: Accessibility permission is required",
    },
  });
});

test("Final Cut native-only transition discovery fails closed", async () => {
  const registry = new FinalCutAssetRegistry({
    roots: [],
    nativeTransitionProvider: {
      searchTransitions: async () => {
        throw new Error("FINAL_CUT_NATIVE_TRANSITION_BROWSER_PERMISSION: Accessibility permission is required");
      },
    },
  });

  await assert.rejects(
    registry.listAssets({ kind: "transition", query: "dissolve" }),
    /FINAL_CUT_NATIVE_TRANSITION_BROWSER_PERMISSION/,
  );
});

test("Final Cut transition discovery continues after a title-provider failure", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "framekit-transition-after-title-failure-"));
  const bundle = join(root, "Transitions.localized", "Cross Dissolve.motr");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><key>CFBundleDisplayName</key><string>Cross Dissolve</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></plist>",
  );
  const nativeTransition: NativeFinalCutTransitionMatch = {
    id: "final-cut:transition:fcp://transition/cross",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Final Cut Pro",
    identity: "fcp://transition/cross",
  };
  const registry = new FinalCutAssetRegistry({
    roots: [root],
    nativeTitleProvider: {
      searchTitles: async () => {
        throw new Error("FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION: Accessibility permission is required");
      },
    },
    nativeTransitionProvider: {
      searchTransitions: async () => [nativeTransition],
    },
  });

  const assets = await registry.listAssets({ query: "dissolve" });

  assert.deepEqual(assets.map((asset) => asset.id), [
    `filesystem:transition:${bundle}`,
    nativeTransition.id,
  ]);
  assert.deepEqual(assets[0]?.metadata.discovery, {
    backend: "filesystem-motion-template",
    guarantee: "observed",
    native: {
      backend: "final-cut-accessibility",
      guarantee: "none",
      unavailableReason: "FINAL_CUT_NATIVE_TITLE_BROWSER_PERMISSION: Accessibility permission is required",
    },
  });
  assert.deepEqual(assets[1]?.metadata.discovery, {
    backend: "final-cut-accessibility",
    guarantee: "observed",
  });
});

test("Final Cut transition discovery supports vendor-only and unfiltered queries", async () => {
  const nativeTransition: NativeFinalCutTransitionMatch = {
    id: "final-cut:transition:fcp://transition/cross",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Final Cut Pro",
    identity: "fcp://transition/cross",
  };
  const queries: string[] = [];
  const registry = new FinalCutAssetRegistry({
    roots: [],
    nativeTransitionProvider: {
      searchTransitions: async (query) => {
        queries.push(query);
        return [nativeTransition];
      },
    },
  });

  assert.deepEqual((await registry.listAssets({ vendor: "Final Cut Pro" })).map((asset) => asset.id), [nativeTransition.id]);
  assert.deepEqual((await registry.listAssets({})).map((asset) => asset.id), [nativeTransition.id]);
  assert.deepEqual(queries, ["", ""]);
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

test("MCP editor.assets exposes native transition provenance", async () => {
  const nativeTransition: NativeFinalCutTransitionMatch = {
    id: "final-cut:transition:fcp://transition/cross",
    kind: "transition",
    name: "Cross Dissolve",
    vendor: "Final Cut Pro",
    identity: "fcp://transition/cross",
  };
  const editor = new FinalCutSessionAdapter({
    snapshot: new InMemoryEditorAdapter({
      projectId: "project-1",
      projectName: "Transition Asset MCP Fixture",
      timelineId: "timeline-1",
      timelineName: "Main",
      clips: [],
    }),
    assets: new FinalCutAssetRegistry({
      roots: [],
      nativeTransitionProvider: { searchTransitions: async () => [nativeTransition] },
    }),
  });
  const server = createMcpServer(new AgentVideoRuntime(editor));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "transition-asset-mcp-test", version: "0.1.0" });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const assets = JSON.parse(textFrom(await client.callTool({
      name: "editor.assets",
      arguments: { kind: "transition", query: "dissolve" },
    })));
    assert.equal(assets[0].id, nativeTransition.id);
    assert.equal(assets[0].name, nativeTransition.name);
    assert.equal(assets[0].vendor, nativeTransition.vendor);
    assert.equal(assets[0].metadata.identity, nativeTransition.identity);
    assert.deepEqual(assets[0].metadata.discovery, {
      backend: "final-cut-accessibility",
      guarantee: "observed",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
