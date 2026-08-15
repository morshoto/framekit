import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type {
  Clip,
  ContextRevision,
  EditOperation,
  EditorCapabilities,
  EditorAsset,
  EditorIdentity,
  EditorPort,
  Marker,
  ProjectSnapshot,
  RationalTime,
} from "../core/types.js";

type XmlObject = Record<string, any>;

export class FinalCutAdapter implements EditorPort {
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  private readonly builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    indentBy: "  ",
  });
  private xml?: XmlObject;
  private sequence = 0;
  private fileSignature?: string;
  private readonly history = new Map<string, string>();

  public constructor(private readonly filePath: string) {}

  public async getIdentity(): Promise<EditorIdentity> {
    return { name: "Final Cut Pro", version: "FCPXML", backend: "fcpxml" };
  }

  public async getCapabilities(): Promise<EditorCapabilities> {
    return {
      projectRead: true,
      timelineRead: true,
      timelineWrite: true,
      readAfterWrite: true,
      incrementalChanges: false,
      speechAnalysis: false,
      audioAnalysis: false,
      rollback: true,
      visualAnalysis: false,
      assetDiscovery: false,
    };
  }

  public async listAssets(): Promise<EditorAsset[]> {
    return [];
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    await this.ensureLoaded();
    const project = this.projectNode();
    const sequence = project.sequence ?? {};
    const spine = sequence.spine ?? {};
    const rawClips = asArray(spine["asset-clip"]);
    const clips = rawClips.map((node, index) => this.clipFromXml(node, index));
    const projectName = String(project["@_name"] ?? "Final Cut Project");
    return {
      projectId: `fcpxml:${this.filePath}`,
      projectName,
      timeline: {
        id: `timeline:${projectName}`,
        name: projectName,
        duration: parseSeconds(sequence["@_duration"] ?? String(Math.max(0, ...clips.map((clip) => clip.start + clip.duration))) + "s"),
        clips,
        markers: this.markersFromXml(spine),
        captions: this.captionsFromXml(spine),
      },
      media: this.mediaFromResources(),
      revision: this.revision(),
    };
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<void> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: Final Cut project revision changed before write");
    }
    this.history.set(expectedRevision.id, this.builder.build(this.xml));
    switch (operation.type) {
      case "rename-clip":
      case "trim-clip":
      case "set-gain": {
        const node = asArray(this.projectNode().sequence?.spine?.["asset-clip"]).find(
          (candidate) => String(candidate["@_ref"]) === operation.clipId,
        );
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (operation.type === "rename-clip") {
        if (operation.name.trim().length === 0) throw new Error("INVALID_OPERATION: clip name cannot be empty");
        node["@_name"] = operation.name;
        } else if (operation.type === "trim-clip") {
          if ((!Number.isFinite(operation.duration) || operation.duration <= 0) && !operation.durationTime) {
            throw new Error("INVALID_OPERATION: clip duration must be positive");
          }
          node["@_duration"] = operation.durationTime
            ? formatRational(operation.durationTime)
            : `${operation.duration}s`;
        } else {
          if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
          node["@_audio-volume"] = `${operation.gainDb}dB`;
        }
        break;
      }
      case "ripple-delete":
        this.applyRippleDelete(operation.timelineId, operation.range.start, operation.range.end);
        break;
      case "add-marker": {
        const spine = this.projectNode().sequence?.spine;
        if (operation.timelineId !== `timeline:${this.projectNode()["@_name"]}`) {
          throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
        }
        spine.marker = [...asArray(spine.marker), {
          "@_id": operation.marker.id,
          "@_start": `${operation.marker.start}s`,
          "@_duration": `${operation.marker.duration}s`,
          "@_value": operation.marker.name,
        }];
        break;
      }
    }
    this.updateSequenceDuration();
    this.sequence += 1;
    await this.persist();
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: Final Cut project revision changed before rollback");
    }
    const previous = this.history.get(snapshot.revision.id);
    if (!previous) throw new Error("ROLLBACK_FAILED: no FCPXML snapshot available");
    this.xml = this.parser.parse(previous);
    this.sequence += 1;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    const content = await readFile(this.filePath, "utf8");
    const signature = hash(content);
    if (!this.xml || this.fileSignature !== signature) {
      if (this.xml) this.sequence += 1;
      this.xml = this.parser.parse(content);
      this.fileSignature = signature;
    }
  }

  private async persist(): Promise<void> {
    const content = this.builder.build(this.xml);
    await writeFile(this.filePath, content, "utf8");
    this.fileSignature = hash(content);
  }

  private projectNode(): XmlObject {
    const library = this.xml?.fcpxml?.library;
    const event = asArray(library?.event)[0] ?? {};
    return asArray(event.project)[0] ?? {};
  }

  private clipFromXml(node: XmlObject, index: number): Clip {
    return {
      id: String(node["@_ref"] ?? `clip-${index + 1}`),
      mediaId: String(node["@_ref"] ?? `media-${index + 1}`),
      name: String(node["@_name"] ?? node["@_ref"] ?? `Clip ${index + 1}`),
      start: parseSeconds(node["@_offset"] ?? node["@_start"] ?? "0s"),
      duration: parseSeconds(node["@_duration"] ?? "0s"),
      track: Number(node["@_lane"] ?? 0),
      startTime: parseRational(node["@_offset"] ?? node["@_start"] ?? "0s"),
      durationTime: parseRational(node["@_duration"] ?? "0s"),
      ...(node["@_audio-volume"] !== undefined ? { gainDb: parseDb(node["@_audio-volume"]) } : {}),
    };
  }

  private markersFromXml(spine: XmlObject): Marker[] {
    return asArray(spine.marker).map((marker, index) => ({
      id: String(marker["@_id"] ?? `marker-${index + 1}`),
      start: parseSeconds(marker["@_start"] ?? "0s"),
      duration: parseSeconds(marker["@_duration"] ?? "0s"),
      name: String(marker["@_value"] ?? marker["@_name"] ?? `Marker ${index + 1}`),
    }));
  }

  private captionsFromXml(spine: XmlObject) {
    return asArray(spine.caption).map((caption, index) => ({
      id: String(caption["@_id"] ?? `caption-${index + 1}`),
      start: parseSeconds(caption["@_start"] ?? "0s"),
      duration: parseSeconds(caption["@_duration"] ?? "0s"),
      text: String(caption["@_text"] ?? caption["@_name"] ?? ""),
    }));
  }

  private applyRippleDelete(timelineId: string, start: number, end: number): void {
    if (timelineId !== `timeline:${this.projectNode()["@_name"]}`) {
      throw new Error(`TIMELINE_NOT_FOUND: ${timelineId}`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error("INVALID_OPERATION: ripple delete range must be positive");
    }
    const delta = end - start;
    const spine = this.projectNode().sequence?.spine;
    const clips = asArray(spine["asset-clip"]).flatMap((node) => {
      const clipStart = parseSeconds(node["@_offset"] ?? "0s");
      const duration = parseSeconds(node["@_duration"] ?? "0s");
      const clipEnd = clipStart + duration;
      if (clipEnd <= start) return [node];
      if (clipStart >= end) {
        node["@_offset"] = `${clipStart - delta}s`;
        return [node];
      }
      const overlap = Math.min(clipEnd, end) - Math.max(clipStart, start);
      const nextDuration = duration - overlap;
      if (nextDuration <= 0) return [];
      node["@_duration"] = `${nextDuration}s`;
      return [node];
    });
    spine["asset-clip"] = clips;
  }

  private updateSequenceDuration(): void {
    const sequence = this.projectNode().sequence;
    const duration = Math.max(0, ...asArray(sequence?.spine?.["asset-clip"]).map((node) =>
      parseSeconds(node["@_offset"] ?? "0s") + parseSeconds(node["@_duration"] ?? "0s"),
    ));
    sequence["@_duration"] = `${duration}s`;
  }

  private mediaFromResources() {
    const assets = asArray(this.xml?.fcpxml?.resources?.asset);
    return assets.map((asset) => ({
      mediaId: String(asset["@_id"]),
      source: String(asset["@_src"] ?? asset["@_name"] ?? asset["@_id"]),
    }));
  }

  private revision(): ContextRevision {
    return {
      id: `rev-${this.sequence}`,
      sequence: this.sequence,
      timestamp: new Date(0 + this.sequence).toISOString(),
    };
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseSeconds(value: string): number {
  const normalized = String(value).replace(/s$/, "");
  if (normalized.includes("/")) {
    const [numerator, denominator] = normalized.split("/").map(Number);
    return numerator / denominator;
  }
  return Number(normalized);
}

function parseDb(value: string): number {
  return Number(String(value).replace(/dB$/i, ""));
}

function parseRational(value: string): RationalTime {
  const normalized = String(value).replace(/s$/, "");
  const [numerator, denominator = "1"] = normalized.split("/");
  return { value: numerator, timescale: denominator };
}

function formatRational(value: RationalTime): string {
  return `${value.value}/${value.timescale}s`;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
