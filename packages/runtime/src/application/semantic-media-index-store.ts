import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaSourceIdentity, MediaUnderstanding } from "../domain/media.js";
import { sameMediaSourceIdentity } from "../domain/media.js";

export const SEMANTIC_MEDIA_INDEX_SCHEMA_VERSION = 1 as const;

export interface SemanticMediaIndexDocument {
  schemaVersion: typeof SEMANTIC_MEDIA_INDEX_SCHEMA_VERSION;
  entries: MediaUnderstanding[];
}

/** Persistent, provider-neutral source-media analysis storage. */
export interface SemanticMediaIndexStore {
  load(source: MediaSourceIdentity): Promise<MediaUnderstanding | undefined>;
  list(): Promise<MediaUnderstanding[]>;
  save(understanding: MediaUnderstanding): Promise<void>;
}

/** Deterministic store for runtime and integration tests. */
export class InMemorySemanticMediaIndexStore implements SemanticMediaIndexStore {
  private readonly entries: MediaUnderstanding[] = [];

  public async load(source: MediaSourceIdentity): Promise<MediaUnderstanding | undefined> {
    const entry = this.entries.find((candidate) => sameMediaSourceIdentity(candidate.sourceIdentity, source));
    return entry ? structuredClone(entry) : undefined;
  }

  public async list(): Promise<MediaUnderstanding[]> {
    return structuredClone(this.entries);
  }

  public async save(understanding: MediaUnderstanding): Promise<void> {
    const retained = this.entries.filter((candidate) => candidate.mediaId !== understanding.mediaId);
    retained.push(structuredClone(understanding));
    retained.sort((left, right) => left.mediaId.localeCompare(right.mediaId));
    this.entries.splice(0, this.entries.length, ...retained);
  }
}

/** Atomic JSON persistence for a local semantic media index. */
export class JsonSemanticMediaIndexStore implements SemanticMediaIndexStore {
  public constructor(private readonly path: string) {}

  public async load(source: MediaSourceIdentity): Promise<MediaUnderstanding | undefined> {
    const document = await this.readDocument();
    const entry = document.entries.find((candidate) => sameMediaSourceIdentity(candidate.sourceIdentity, source));
    return entry ? structuredClone(entry) : undefined;
  }

  public async list(): Promise<MediaUnderstanding[]> {
    return structuredClone((await this.readDocument()).entries);
  }

  public async save(understanding: MediaUnderstanding): Promise<void> {
    const document = await this.readDocument();
    document.entries = [
      ...document.entries.filter((candidate) => candidate.mediaId !== understanding.mediaId),
      structuredClone(understanding),
    ].sort((left, right) => left.mediaId.localeCompare(right.mediaId));
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
  }

  private async readDocument(): Promise<SemanticMediaIndexDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { schemaVersion: SEMANTIC_MEDIA_INDEX_SCHEMA_VERSION, entries: [] };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`SEMANTIC_INDEX_CORRUPT: index JSON is malformed (${String(error)})`);
    }
    if (!value || typeof value !== "object"
      || (value as { schemaVersion?: unknown }).schemaVersion !== SEMANTIC_MEDIA_INDEX_SCHEMA_VERSION
      || !Array.isArray((value as { entries?: unknown }).entries)) {
      throw new Error("SEMANTIC_INDEX_CORRUPT: unsupported semantic index document");
    }
    return structuredClone(value as SemanticMediaIndexDocument);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
