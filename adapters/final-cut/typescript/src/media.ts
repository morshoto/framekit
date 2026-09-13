import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { MediaContext, MediaSearchQuery } from "@framekit/runtime";

const MEDIA_KIND_BY_EXTENSION: Record<string, "video" | "audio"> = {
  ".avi": "video",
  ".m2ts": "video",
  ".m4v": "video",
  ".mkv": "video",
  ".mov": "video",
  ".mp4": "video",
  ".mts": "video",
  ".webm": "video",
  ".aac": "audio",
  ".aif": "audio",
  ".aiff": "audio",
  ".caf": "audio",
  ".flac": "audio",
  ".m4a": "audio",
  ".mp3": "audio",
  ".ogg": "audio",
  ".wav": "audio",
};

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".avi": "video/x-msvideo",
  ".caf": "audio/x-caf",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".m4v": "video/x-m4v",
  ".m2ts": "video/mp2t",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mts": "video/mp2t",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

export interface FinalCutMediaRegistryOptions {
  roots?: string[];
}

interface DiscoveredFile {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
}

interface MediaCache {
  signature: string;
  media: MediaContext[];
}

/** Read-only local media discovery that never contacts or activates Final Cut. */
export class FinalCutMediaRegistry {
  private readonly roots: string[];
  private cached?: MediaCache;

  public constructor(options: FinalCutMediaRegistryOptions = {}) {
    this.roots = (options.roots ?? []).map((root) => resolve(root));
  }

  public async listMedia(query?: MediaSearchQuery): Promise<MediaContext[]> {
    const files = await discoverFiles(this.roots);
    const signature = files.map((file) => `${file.path}:${file.sizeBytes}:${file.modifiedAt}`).join("\n");
    if (!this.cached || this.cached.signature !== signature) {
      this.cached = {
        signature,
        media: await Promise.all(files.map((file) => mediaFromFile(file))),
      };
    }
    return filterMedia(this.cached.media, query);
  }

  public refresh(): void {
    this.cached = undefined;
  }
}

async function discoverFiles(roots: string[]): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  for (const root of roots) await walk(root, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(path: string, files: DiscoveredFile[]): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    return;
  }
  if (details.isFile()) {
    const extension = extname(path).toLowerCase();
    if (MEDIA_KIND_BY_EXTENSION[extension]) {
      files.push({ path: resolve(path), sizeBytes: details.size, modifiedAt: details.mtimeMs });
    }
    return;
  }
  if (!details.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    await walk(resolve(path, entry.name), files);
  }
}

async function mediaFromFile(file: DiscoveredFile): Promise<MediaContext> {
  const extension = extname(file.path).toLowerCase();
  const contents = await readFile(file.path);
  return {
    mediaId: `filesystem:media:${file.path}`,
    source: file.path,
    mediaKind: MEDIA_KIND_BY_EXTENSION[extension],
    sourceDigest: createHash("sha256").update(contents).digest("hex"),
    sourceMetadata: {
      fileName: basename(file.path),
      extension,
      sizeBytes: file.sizeBytes,
      mimeType: MIME_TYPE_BY_EXTENSION[extension],
      modifiedAt: new Date(file.modifiedAt).toISOString(),
    },
    discovery: {
      backend: "filesystem-media",
      guarantee: "observed",
      source: "filesystem",
    },
  };
}

function filterMedia(media: MediaContext[], query?: MediaSearchQuery): MediaContext[] {
  const text = query?.query?.trim().toLowerCase();
  return media
    .filter((candidate) => {
      if (query?.mediaKind && candidate.mediaKind !== query.mediaKind) return false;
      if (text && ![candidate.mediaId, candidate.source, candidate.sourceMetadata?.fileName ?? ""]
        .some((value) => value.toLowerCase().includes(text))) return false;
      return true;
    })
    .map((candidate) => structuredClone(candidate));
}
