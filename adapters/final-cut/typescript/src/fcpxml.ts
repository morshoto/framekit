import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type {
  Caption,
  Clip,
  ContextRevision,
  EditOperation,
  EditorAsset,
  EditorCapabilities,
  EditorIdentity,
  EditorPort,
  Marker,
  ProjectSnapshot,
  RationalTime,
  RuntimeCapabilities,
  StoryElement,
} from "@framekit/runtime";

type XmlNode = Record<string, any>;
type OrderedXml = XmlNode[];

const CLIP_KINDS = new Set(["asset-clip", "clip", "ref-clip", "sync-clip", "audio", "video"]);

/**
 * FCPXML document interchange adapter. It edits the artifact on disk; it does
 * not claim that the currently open Final Cut session changed.
 */
export class FcpxmlDocumentAdapter implements EditorPort {
  private readonly parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  private readonly builder = new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    indentBy: "  ",
  });
  private xml?: OrderedXml;
  private sequence = 0;
  private fileSignature?: string;
  private readonly history = new Map<string, OrderedXml>();

  public constructor(private readonly filePath: string) {}

  public async getIdentity(): Promise<EditorIdentity> {
    return { name: "Final Cut Pro", version: "FCPXML", backend: "fcpxml-document" };
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      editor: {
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: false,
        timelineArtifactWrite: true,
        readAfterWrite: true,
        incrementalChanges: false,
        rollback: true,
        assetDiscovery: false,
        liveStateRead: false,
        playheadWrite: false,
      },
      analyzers: emptyAnalyzerCapabilities(),
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
    const sequence = findElement(project, "sequence") ?? {};
    const spine = findElement(sequence, "spine") ?? {};
    const projectName = String(attribute(project, "name") ?? "Final Cut Project");
    const timelineId = `timeline:${projectName}`;
    const elements = storyEntries(spine);
    const storyElements = elements
      .map(({ kind, node }, index) => ({ kind, element: this.storyElementFromXml(node, kind, index, timelineId) }))
      .filter(({ kind }) => kind !== "marker" && kind !== "caption")
      .map(({ element }) => element);
    const clips = elements
      .map(({ kind, node }, index) => ({ kind, node, index }))
      .filter(({ kind }) => CLIP_KINDS.has(kind))
      .map(({ kind, node, index }) => this.clipFromXml(node, kind, index, timelineId));
    const durationValue = attribute(sequence, "duration")
      ?? formatSeconds(Math.max(0, ...storyElements.map((element) => element.start + element.duration)));
    return {
      projectId: `fcpxml:${this.filePath}`,
      projectName,
      timeline: {
        id: timelineId,
        name: projectName,
        duration: parseSeconds(durationValue),
        durationTime: parseRational(durationValue),
        clips,
        storyElements,
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
      throw new Error("STALE_CONTEXT: FCPXML document changed before write");
    }
    this.history.set(expectedRevision.id, structuredClone(this.xml!));
    const project = this.projectNode();
    const sequence = findElement(project, "sequence") ?? {};
    const spine = findElement(sequence, "spine") ?? {};

    switch (operation.type) {
      case "rename-clip": {
        const node = this.findClipNode(spine, operation.clipId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (operation.name.trim().length === 0) throw new Error("INVALID_OPERATION: clip name cannot be empty");
        setAttribute(node, "name", operation.name);
        break;
      }
      case "trim-clip": {
        const node = this.findClipNode(spine, operation.clipId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if ((!Number.isFinite(operation.duration) || operation.duration <= 0) && !operation.durationTime) {
          throw new Error("INVALID_OPERATION: clip duration must be positive");
        }
        setAttribute(node, "duration", operation.durationTime ? formatRational(operation.durationTime) : formatSeconds(operation.duration));
        break;
      }
      case "set-gain": {
        const node = this.findClipNode(spine, operation.clipId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
        this.setAdjustVolume(node, operation.gainDb);
        break;
      }
      case "ripple-delete":
        throw new Error("CAPABILITY_UNAVAILABLE: FCPXML ripple-delete requires story-element source-range transforms");
      case "add-marker": {
        if (operation.timelineId !== `timeline:${attribute(project, "name") ?? "Final Cut Project"}`) {
          throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
        }
        appendChild(spine, "marker", {
          ":@": {
            "@_id": operation.marker.id,
            "@_start": formatSeconds(operation.marker.start),
            "@_duration": formatSeconds(operation.marker.duration),
            "@_value": operation.marker.name,
          },
        });
        break;
      }
    }
    this.updateSequenceDuration(sequence, spine);
    this.sequence += 1;
    await this.persist();
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: FCPXML document changed before rollback");
    }
    const previous = this.history.get(snapshot.revision.id);
    if (!previous) throw new Error("ROLLBACK_FAILED: no FCPXML snapshot available");
    this.xml = structuredClone(previous);
    this.sequence += 1;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    const content = await readFile(this.filePath, "utf8");
    const signature = hash(content);
    if (!this.xml || this.fileSignature !== signature) {
      if (this.xml) this.sequence += 1;
      this.xml = this.parser.parse(content) as OrderedXml;
      this.fileSignature = signature;
    }
  }

  private async persist(): Promise<void> {
    const content = this.builder.build(this.xml);
    await writeFile(this.filePath, content, "utf8");
    this.fileSignature = hash(content);
  }

  private projectNode(): XmlNode {
    return findElement(this.xml ?? [], "project") ?? {};
  }

  private storyElementFromXml(node: XmlNode, kind: string, index: number, timelineId: string): StoryElement {
    const startValue = attribute(node, "offset") ?? attribute(node, "start") ?? "0s";
    const durationValue = attribute(node, "duration") ?? "0s";
    return {
      id: this.instanceId(node, kind, index, timelineId),
      kind,
      start: parseSeconds(startValue),
      duration: parseSeconds(durationValue),
      startTime: parseRational(startValue),
      durationTime: parseRational(durationValue),
      ...(attribute(node, "lane") !== undefined ? { lane: Number(attribute(node, "lane")) } : {}),
      ...(attribute(node, "ref") !== undefined ? { mediaId: String(attribute(node, "ref")) } : {}),
    };
  }

  private clipFromXml(node: XmlNode, kind: string, index: number, timelineId: string): Clip {
    const startValue = attribute(node, "offset") ?? attribute(node, "start") ?? "0s";
    const durationValue = attribute(node, "duration") ?? "0s";
    const gain = firstChild(node, "adjust-volume");
    return {
      id: this.instanceId(node, kind, index, timelineId),
      mediaId: attribute(node, "ref") === undefined ? undefined : String(attribute(node, "ref")),
      name: String(attribute(node, "name") ?? attribute(node, "ref") ?? `Clip ${index + 1}`),
      start: parseSeconds(startValue),
      duration: parseSeconds(durationValue),
      track: Number(attribute(node, "lane") ?? 0),
      startTime: parseRational(startValue),
      durationTime: parseRational(durationValue),
      ...(gain ? { gainDb: parseDb(attribute(gain, "amount") ?? "0dB") } : {}),
    };
  }

  private instanceId(node: XmlNode, kind: string, index: number, timelineId: string): string {
    const explicit = attribute(node, "id") ?? attribute(node, "uid");
    return String(explicit ?? `${timelineId}:spine:${index}:${kind}`);
  }

  private findClipNode(spine: XmlNode, clipId: string): XmlNode | undefined {
    return storyEntries(spine)
      .map(({ kind, node }, index) => ({ kind, node, index }))
      .filter(({ kind }) => CLIP_KINDS.has(kind))
      .find(({ kind, node, index }) => this.instanceId(node, kind, index, `timeline:${attribute(this.projectNode(), "name") ?? "Final Cut Project"}`) === clipId)
      ?.node;
  }

  private setAdjustVolume(node: XmlNode, gainDb: number): void {
    const existing = firstChild(node, "adjust-volume");
    if (existing) {
      setAttribute(existing, "amount", formatDb(gainDb));
      return;
    }
    appendChild(node, "adjust-volume", { ":@": { "@_amount": formatDb(gainDb) } });
  }

  private markersFromXml(spine: XmlNode): Marker[] {
    return storyEntries(spine)
      .filter(({ kind }) => kind === "marker")
      .map(({ node }, index) => {
        const start = attribute(node, "start") ?? "0s";
        const duration = attribute(node, "duration") ?? "0s";
        return {
          id: String(attribute(node, "id") ?? `marker-${index + 1}`),
          start: parseSeconds(start),
          duration: parseSeconds(duration),
          startTime: parseRational(start),
          durationTime: parseRational(duration),
          name: String(attribute(node, "value") ?? attribute(node, "name") ?? `Marker ${index + 1}`),
        };
      });
  }

  private captionsFromXml(spine: XmlNode): Caption[] {
    return storyEntries(spine)
      .filter(({ kind }) => kind === "caption")
      .map(({ node }, index) => {
        const start = attribute(node, "start") ?? "0s";
        const duration = attribute(node, "duration") ?? "0s";
        return {
          id: String(attribute(node, "id") ?? `caption-${index + 1}`),
          start: parseSeconds(start),
          duration: parseSeconds(duration),
          startTime: parseRational(start),
          durationTime: parseRational(duration),
          text: String(attribute(node, "text") ?? attribute(node, "name") ?? ""),
        };
      });
  }

  private updateSequenceDuration(sequence: XmlNode, spine: XmlNode): void {
    const duration = Math.max(0, ...storyEntries(spine)
      .filter(({ kind }) => kind !== "marker" && kind !== "caption")
      .map(({ node }) => parseSeconds(attribute(node, "offset") ?? attribute(node, "start") ?? "0s") + parseSeconds(attribute(node, "duration") ?? "0s")));
    setAttribute(sequence, "duration", formatSeconds(duration));
  }

  private mediaFromResources() {
    const resources = findElement(this.xml ?? [], "resources");
    return storyEntries(resources ?? {})
      .filter(({ kind }) => kind === "asset" || kind === "media" || kind === "effect")
      .map(({ node }) => ({
        mediaId: String(attribute(node, "id") ?? ""),
        source: String(attribute(node, "src") ?? attribute(node, "name") ?? attribute(node, "id") ?? ""),
      }))
      .filter((media) => media.mediaId.length > 0);
  }

  private revision(): ContextRevision {
    return { id: `rev-${this.sequence}`, sequence: this.sequence, timestamp: new Date(this.sequence).toISOString() };
  }
}

function storyEntries(node: XmlNode): Array<{ kind: string; node: XmlNode }> {
  return Object.entries(node)
    .filter(([kind]) => kind !== ":@")
    .flatMap(([kind, value]) => Array.isArray(value)
      ? value.filter((child): child is XmlNode => typeof child === "object" && child !== null)
        .map((child) => ({ kind: Object.keys(child).find((key) => key !== ":@") ?? kind, node: child }))
      : []);
}

function findElement(nodes: OrderedXml | XmlNode, kind: string): XmlNode | undefined {
  const containers = Array.isArray(nodes) ? nodes : [nodes];
  for (const container of containers) {
    if (Object.prototype.hasOwnProperty.call(container, kind)) return container;
    for (const entry of storyEntries(container)) {
      const nested = findElement(entry.node, kind);
      if (nested) return nested;
    }
  }
  return undefined;
}

function firstChild(node: XmlNode, kind: string): XmlNode | undefined {
  return storyEntries(node).find((entry) => entry.kind === kind)?.node;
}

function appendChild(node: XmlNode, kind: string, child: XmlNode): void {
  const elementKey = Object.keys(node).find((key) => key !== ":@");
  const wrapper = Object.prototype.hasOwnProperty.call(child, kind)
    ? child
    : { [kind]: [], ...child };
  if (elementKey) {
    node[elementKey] = [...(Array.isArray(node[elementKey]) ? node[elementKey] : []), wrapper];
  } else {
    node[kind] = [...(Array.isArray(node[kind]) ? node[kind] : []), wrapper];
  }
}

function attributes(node: XmlNode): XmlNode {
  return (node[":@"] ?? {}) as XmlNode;
}

function attribute(node: XmlNode, name: string): unknown {
  return attributes(node)[`@_${name}`];
}

function setAttribute(node: XmlNode, name: string, value: string): void {
  node[":@"] = { ...attributes(node), [`@_${name}`]: value };
}

function parseSeconds(value: unknown): number {
  const normalized = String(value).replace(/s$/, "");
  if (normalized.includes("/")) {
    const [numerator, denominator] = normalized.split("/").map(Number);
    return denominator === 0 ? 0 : numerator / denominator;
  }
  return Number(normalized) || 0;
}

function parseDb(value: unknown): number {
  return Number(String(value).replace(/dB$/i, ""));
}

function parseRational(value: unknown): RationalTime {
  const normalized = String(value).replace(/s$/, "");
  const [numerator, denominator = "1"] = normalized.split("/");
  return { value: numerator, timescale: denominator };
}

function formatRational(value: RationalTime): string {
  if (!/^[-+]?\d+$/.test(value.value) || !/^\d+$/.test(value.timescale) || Number(value.timescale) <= 0) {
    throw new Error("INVALID_OPERATION: rational time must use integer value and positive timescale");
  }
  return `${value.value}/${value.timescale}s`;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_OPERATION: time must be finite and non-negative");
  const rational = decimalToRational(value);
  return `${rational.value}/${rational.timescale}s`;
}

function decimalToRational(value: number): RationalTime {
  const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (!text.includes(".")) return { value: text, timescale: "1" };
  const decimals = text.split(".")[1].length;
  const scale = 10 ** decimals;
  return { value: String(Math.round(value * scale)), timescale: String(scale) };
}

function formatDb(value: number): string {
  return `${value}dB`;
}

function emptyAnalyzerCapabilities() {
  return { speechTranscribe: false, speechVad: false, audioLoudness: false, visualTrack: false };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
