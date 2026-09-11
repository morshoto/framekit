import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AssetSearchQuery, EditorAsset } from "@framekit/runtime";
import type { NativeFinalCutTitleMatch } from "./native.js";

const CATEGORY_BY_DIRECTORY: Record<string, EditorAsset["kind"]> = {
  "Audio Effects.localized": "audio-effect",
  "Effects.localized": "effect",
  "Generators.localized": "generator",
  "Titles.localized": "title",
  "Transitions.localized": "transition",
  "Templates.localized": "template",
};

const BUNDLE_SUFFIXES = new Set([".moef", ".moti", ".motn", ".motr"]);

export interface FinalCutAssetRegistryOptions {
  roots?: string[];
  nativeTitleProvider?: Pick<NativeTitleProvider, "searchTitles">;
}

export interface NativeTitleProvider {
  searchTitles(query: string): Promise<NativeFinalCutTitleMatch[]>;
}

export function defaultFinalCutAssetRoots(): string[] {
  return [
    join(homedir(), "Movies", "Motion Templates.localized"),
    join(homedir(), "Library", "Application Support", "Final Cut Pro", "Motion Templates.localized"),
    "/Library/Application Support/Final Cut Pro/Motion Templates.localized",
  ];
}

export class FinalCutAssetRegistry {
  private readonly roots: string[];
  private readonly nativeTitleProvider?: Pick<NativeTitleProvider, "searchTitles">;
  private cached?: EditorAsset[];

  public constructor(options: FinalCutAssetRegistryOptions = {}) {
    this.roots = (options.roots ?? defaultFinalCutAssetRoots()).map((root) => resolve(root));
    this.nativeTitleProvider = options.nativeTitleProvider;
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    if (!this.cached) this.cached = await this.scan();
    const filesystemAssets = filterAssets(this.cached, query);
    if (!this.nativeTitleProvider || (query?.kind && query.kind !== "title")) return filesystemAssets;
    let nativeTitles: NativeFinalCutTitleMatch[];
    try {
      nativeTitles = await this.nativeTitleProvider.searchTitles(query?.query ?? "");
    } catch (error) {
      // Filesystem assets remain truthful when the optional native browser is
      // unavailable; native-only queries still fail closed below.
      if (filesystemAssets.length > 0) return filesystemAssets;
      throw error;
    }
    const composed = [...filesystemAssets, ...nativeTitles.map(nativeTitleAsset)];
    return filterAssets(dedupeAssets(composed), query);
  }

  public refresh(): void {
    this.cached = undefined;
  }

  private async scan(): Promise<EditorAsset[]> {
    const assets: EditorAsset[] = [];
    for (const root of this.roots) {
      await scanDirectory(root, assets);
    }
    return assets
      .sort((left, right) => `${left.kind}:${left.name}:${left.id}`.localeCompare(`${right.kind}:${right.name}:${right.id}`))
      .filter((asset, index, all) => index === all.findIndex((candidate) => candidate.id === asset.id));
  }
}

async function scanDirectory(directory: string, assets: EditorAsset[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && CATEGORY_BY_DIRECTORY[entry.name]) {
      await scanCategory(path, CATEGORY_BY_DIRECTORY[entry.name], assets);
    } else if (entry.isDirectory()) {
      await scanDirectory(path, assets);
    }
  }
}

async function scanCategory(directory: string, kind: EditorAsset["kind"], assets: EditorAsset[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !BUNDLE_SUFFIXES.has(extension(entry.name))) continue;
    const path = join(directory, entry.name);
    const metadata = await readMetadata(path);
    assets.push({
      id: `filesystem:${kind}:${path}`,
      kind,
      name: metadata.name ?? basename(entry.name, extension(entry.name)),
      vendor: metadata.vendor ?? "Unknown",
      metadata: {
        path,
        ...metadata,
        identity: path,
        provider: "filesystem-motion-template",
        source: "filesystem",
        discovery: {
          backend: "filesystem-motion-template",
          guarantee: "observed",
        },
        ...(kind === "title"
          ? {
              placement: {
                backend: "final-cut-accessibility",
                guarantee: "native-verified",
                operation: "editor.native.title.add",
              },
            }
          : {}),
      },
    });
  }
}

function nativeTitleAsset(match: NativeFinalCutTitleMatch): EditorAsset {
  if (!match.id.startsWith("final-cut:title:") || !match.identity.trim() || !match.name.trim()) {
    throw new Error("FINAL_CUT_NATIVE_TITLE_ID_UNAVAILABLE: native title provider returned an unstable identity");
  }
  return {
    id: match.id,
    kind: "title",
    name: match.name,
    vendor: match.vendor,
    metadata: {
      identity: match.identity,
      provider: "final-cut-accessibility",
      source: "final-cut-titles-browser",
      discovery: {
        backend: "final-cut-accessibility",
        guarantee: "observed",
      },
      placement: {
        backend: "final-cut-accessibility",
        guarantee: "native-verified",
        operation: "editor.native.title.add",
      },
    },
  };
}

function dedupeAssets(assets: EditorAsset[]): EditorAsset[] {
  return assets
    .sort((left, right) => `${left.kind}:${left.name}:${left.id}`.localeCompare(`${right.kind}:${right.name}:${right.id}`))
    .filter((asset, index, all) => index === all.findIndex((candidate) => candidate.id === asset.id));
}

async function readMetadata(bundlePath: string): Promise<{ name?: string; vendor?: string; [key: string]: unknown }> {
  try {
    const infoPath = join(bundlePath, "Contents", "Info.plist");
    const contents = await readFile(infoPath, "utf8");
    const name = contents.match(/<key>(?:CFBundleDisplayName|CFBundleName)<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    const vendor = contents.match(/<key>(?:Vendor|CFBundleIdentifier)<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    return { ...(name ? { name } : {}), ...(vendor ? { vendor } : {}) };
  } catch {
    return {};
  }
}

function filterAssets(assets: EditorAsset[], query?: AssetSearchQuery): EditorAsset[] {
  const text = query?.query?.trim().toLowerCase();
  const vendor = query?.vendor?.trim().toLowerCase();
  return assets.filter((asset) => {
    if (text && ![asset.id, asset.name, asset.vendor].some((value) => value.toLowerCase().includes(text))) return false;
    if (query?.kind && asset.kind !== query.kind) return false;
    if (vendor && asset.vendor.toLowerCase() !== vendor) return false;
    return true;
  }).map((asset) => structuredClone(asset));
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}
