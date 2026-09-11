import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AssetSearchQuery, EditorAsset } from "@framekit/runtime";
import type { NativeFinalCutTitleMatch, NativeFinalCutTransitionMatch } from "./native.js";

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
  nativeTransitionProvider?: Pick<NativeTransitionProvider, "searchTransitions">;
}

export interface NativeTitleProvider {
  searchTitles(query: string): Promise<NativeFinalCutTitleMatch[]>;
}

export interface NativeTransitionProvider {
  searchTransitions(query: string): Promise<NativeFinalCutTransitionMatch[]>;
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
  private readonly nativeTransitionProvider?: Pick<NativeTransitionProvider, "searchTransitions">;
  private cached?: EditorAsset[];

  public constructor(options: FinalCutAssetRegistryOptions = {}) {
    this.roots = (options.roots ?? defaultFinalCutAssetRoots()).map((root) => resolve(root));
    this.nativeTitleProvider = options.nativeTitleProvider;
    this.nativeTransitionProvider = options.nativeTransitionProvider;
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    if (!this.cached) this.cached = await this.scan();
    const filesystemAssets = filterAssets(this.cached, query);
    let nativeTitleAssets: EditorAsset[] = [];
    let nativeTransitionAssets: EditorAsset[] = [];
    let nativeTitleError: unknown;
    let nativeTransitionError: unknown;
    if (this.nativeTitleProvider && (!query?.kind || query.kind === "title")) {
      let nativeTitles: NativeFinalCutTitleMatch[];
      try {
        nativeTitles = await this.nativeTitleProvider.searchTitles(query?.query ?? "");
        if (nativeTitles.length === 0) {
          throw new Error("FINAL_CUT_NATIVE_TITLE_DISCOVERY_EMPTY: native title provider returned no title assets");
        }
      } catch (error) {
        nativeTitleError = error;
        nativeTitles = [];
      }
      nativeTitleAssets = nativeTitles.map(nativeTitleAsset);
    }

    const nativeTransitionProvider = this.nativeTransitionProvider;
    const shouldSearchNativeTransitions = nativeTransitionProvider
      && (!query?.kind || query.kind === "transition");
    if (shouldSearchNativeTransitions) {
      let nativeTransitions: NativeFinalCutTransitionMatch[];
      try {
        nativeTransitions = await nativeTransitionProvider.searchTransitions(query?.query ?? "");
      } catch (error) {
        nativeTransitionError = error;
        nativeTransitions = [];
      }
      nativeTransitionAssets = nativeTransitions.map(nativeTransitionAsset);
    }

    const nativeError = nativeTransitionError ?? nativeTitleError;
    const filesystemResults = nativeError && filesystemAssets.length > 0
      ? withNativeDiscoveryDiagnostic(filesystemAssets, nativeError)
      : filesystemAssets;
    const assets = filterAssets(dedupeAssets([
      ...filesystemResults,
      ...nativeTitleAssets,
      ...nativeTransitionAssets,
    ]), query);
    if (assets.length === 0 && nativeError) throw nativeError;
    return assets;
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

function nativeTransitionAsset(match: NativeFinalCutTransitionMatch): EditorAsset {
  if (!match.id.startsWith("final-cut:transition:") || !match.identity.trim() || !match.name.trim()) {
    throw new Error("FINAL_CUT_NATIVE_TRANSITION_ID_UNAVAILABLE: native transition provider returned an unstable identity");
  }
  return {
    id: match.id,
    kind: "transition",
    name: match.name,
    vendor: match.vendor,
    metadata: {
      identity: match.identity,
      provider: "final-cut-accessibility",
      source: "final-cut-transitions-browser",
      discovery: {
        backend: "final-cut-accessibility",
        guarantee: "observed",
      },
      placement: {
        backend: "final-cut-accessibility",
        guarantee: "native-verified",
        operation: "editor.native.transition.add.preview",
      },
    },
  };
}

function dedupeAssets(assets: EditorAsset[]): EditorAsset[] {
  return assets
    .sort((left, right) => `${left.kind}:${left.name}:${left.id}`.localeCompare(`${right.kind}:${right.name}:${right.id}`))
    .filter((asset, index, all) => index === all.findIndex((candidate) => candidate.id === asset.id));
}

function withNativeDiscoveryDiagnostic(assets: EditorAsset[], error: unknown): EditorAsset[] {
  const native = {
    backend: "final-cut-accessibility",
    guarantee: "none",
    unavailableReason: error instanceof Error ? error.message : String(error),
  };
  return assets.map((asset) => {
    const discovery = asset.metadata.discovery;
    return {
      ...asset,
      metadata: {
        ...asset.metadata,
        discovery: {
          ...(typeof discovery === "object" && discovery !== null ? discovery : {}),
          native: { ...native },
        },
      },
    };
  });
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
