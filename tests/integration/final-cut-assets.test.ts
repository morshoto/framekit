import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalCutAssetRegistry } from "@framekit/final-cut";
import type { NativeFinalCutTitleMatch } from "@framekit/final-cut";

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
    nativeTitle.id,
    `filesystem:title:${bundle}`,
  ]);
  assert.deepEqual(assets.map((asset) => asset.metadata.provider), [
    "final-cut-accessibility",
    "filesystem-motion-template",
  ]);
  assert.equal(assets[0]?.metadata.identity, nativeTitle.identity);
  assert.equal(assets[1]?.metadata.path, bundle);
});
