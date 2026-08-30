import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
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
  ManagedArtifact,
  ProjectSnapshot,
  ProjectCatalog,
  ProjectSelection,
  RationalTime,
  RuntimeCapabilities,
  StoryElement,
} from "@framekit/runtime";

type XmlNode = Record<string, any>;
type OrderedXml = XmlNode[];
type TimelineEntry = {
  kind: string;
  node: XmlNode;
  path: string;
  startTime: RationalTime;
  durationTime: RationalTime;
};

const CLIP_KINDS = new Set(["asset-clip", "clip", "ref-clip", "sync-clip", "mc-clip", "audio", "video"]);
const TIMELINE_KINDS = new Set([
  ...CLIP_KINDS,
  "gap",
  "title",
  "transition",
  "caption",
  "marker",
  "audition",
  "live-drawing",
]);

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

  public async getManagedArtifact(): Promise<ManagedArtifact> {
    return { id: `fcpxml:${this.filePath}`, path: this.filePath, format: "fcpxml" };
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
        frameCapture: false,
        projectCatalogRead: true,
        projectSelection: true,
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
    const sequenceNode = findElement(project, "sequence");
    const sequence = sequenceNode ?? {};
    const spine = findElement(sequence, "spine") ?? {};
    const projectName = String(attribute(project, "name") ?? "Final Cut Project");
    const projectId = stableProjectId(project);
    const sequenceName = String(attribute(sequenceNode ?? {}, "name") ?? projectName);
    const timelineId = stableTimelineId(project, sequenceNode);
    const elements = timelineEntries(spine);
    const storyElements = elements
      .map((entry) => ({ kind: entry.kind, element: this.storyElementFromXml(entry, timelineId) }))
      .filter(({ kind }) => kind !== "marker" && kind !== "caption")
      .map(({ element }) => element);
    const clips = elements
      .filter(({ kind }) => CLIP_KINDS.has(kind))
      .map((entry) => this.clipFromXml(entry, timelineId));
    const durationValue = attribute(sequence, "duration")
      ?? formatSeconds(Math.max(0, ...storyElements.map((element) => element.start + element.duration)));
    return {
      projectId,
      projectName,
      timeline: {
        id: timelineId,
        name: sequenceName,
        duration: parseSeconds(durationValue),
        durationTime: parseRational(durationValue),
        clips,
        storyElements,
        markers: this.markersFromXml(elements),
        captions: this.captionsFromXml(elements),
      },
      media: this.mediaFromResources(),
      revision: this.revision(),
    };
  }

  public async listProjects(): Promise<ProjectCatalog> {
    await this.ensureLoaded();
    const project = this.projectNode();
    const projectName = String(attribute(project, "name") ?? "Final Cut Project");
    const projectId = stableProjectId(project);
    const sequence = findElement(project, "sequence");
    const sequenceName = String(attribute(sequence ?? {}, "name") ?? projectName);
    const sequenceId = stableSequenceId(sequence);
    return {
      projects: [{
        id: projectId,
        name: projectName,
        sequences: [{ id: sequenceId, name: sequenceName }],
      }],
      activeProjectId: projectId,
      activeSequenceId: sequenceId,
    };
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const catalog = await this.listProjects();
    const project = catalog.projects.find((candidate) => candidate.id === selection.projectId);
    if (!project) throw new Error(`PROJECT_NOT_FOUND: ${selection.projectId}`);
    const sequenceId = selection.sequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
    if (!sequenceId) throw new Error(`AMBIGUOUS_PROJECT_TARGET: ${selection.projectId} has multiple sequences`);
    if (!project.sequences.some((sequence) => sequence.id === sequenceId)) {
      throw new Error(`SEQUENCE_NOT_FOUND: ${sequenceId}`);
    }
    return { ...catalog, activeProjectId: project.id, activeSequenceId: sequenceId };
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: FCPXML document changed before write");
    }
    this.history.set(expectedRevision.id, structuredClone(this.xml!));
    const project = this.projectNode();
    const sequenceNode = findElement(project, "sequence");
    const sequence = sequenceNode ?? {};
    const spine = findElement(sequence, "spine") ?? {};
    const timelineId = stableTimelineId(project, sequenceNode);

    switch (operation.type) {
      case "rename-clip": {
        const node = this.findClipNode(spine, operation.clipId, timelineId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (operation.name.trim().length === 0) throw new Error("INVALID_OPERATION: clip name cannot be empty");
        setAttribute(node, "name", operation.name);
        break;
      }
      case "trim-clip": {
        const node = this.findClipNode(spine, operation.clipId, timelineId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if ((!Number.isFinite(operation.duration) || operation.duration <= 0) && !operation.durationTime) {
          throw new Error("INVALID_OPERATION: clip duration must be positive");
        }
        setAttribute(node, "duration", operation.durationTime ? formatRational(operation.durationTime) : formatSeconds(operation.duration));
        break;
      }
      case "set-gain": {
        const node = this.findClipNode(spine, operation.clipId, timelineId);
        if (!node) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
        this.setAdjustVolume(node, operation.gainDb);
        break;
      }
      case "ripple-delete":
        throw new Error("CAPABILITY_UNAVAILABLE: FCPXML ripple-delete requires story-element source-range transforms");
      case "add-marker": {
        if (operation.timelineId !== timelineId) {
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
    return this.revision();
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

  private storyElementFromXml(entry: TimelineEntry, timelineId: string): StoryElement {
    const { node, kind, path, startTime, durationTime } = entry;
    return {
      id: this.instanceId(node, kind, path, timelineId),
      kind,
      start: rationalSeconds(startTime),
      duration: rationalSeconds(durationTime),
      startTime,
      durationTime,
      ...(attribute(node, "lane") !== undefined ? { lane: Number(attribute(node, "lane")) } : {}),
      ...(attribute(node, "ref") !== undefined ? { mediaId: String(attribute(node, "ref")) } : {}),
    };
  }

  private clipFromXml(entry: TimelineEntry, timelineId: string): Clip {
    const { node, kind, path, startTime, durationTime } = entry;
    const gain = firstChild(node, "adjust-volume");
    return {
      id: this.instanceId(node, kind, path, timelineId),
      mediaId: attribute(node, "ref") === undefined ? undefined : String(attribute(node, "ref")),
      name: String(attribute(node, "name") ?? attribute(node, "ref") ?? `Clip ${path.includes(".") ? path : path + 1}`),
      start: rationalSeconds(startTime),
      duration: rationalSeconds(durationTime),
      track: Number(attribute(node, "lane") ?? 0),
      startTime,
      durationTime,
      ...(gain ? { gainDb: parseDb(attribute(gain, "amount") ?? "0dB") } : {}),
    };
  }

  private instanceId(node: XmlNode, kind: string, path: string, timelineId: string): string {
    const explicit = attribute(node, "id") ?? attribute(node, "uid");
    return String(explicit ?? `${timelineId}:spine:${path}:${kind}`);
  }

  private findClipNode(spine: XmlNode, clipId: string, timelineId: string): XmlNode | undefined {
    return timelineEntries(spine)
      .filter(({ kind }) => CLIP_KINDS.has(kind))
      .find(({ kind, node, path }) => this.instanceId(node, kind, path, timelineId) === clipId)
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

  private markersFromXml(elements: TimelineEntry[]): Marker[] {
    return elements
      .filter(({ kind }) => kind === "marker")
      .map(({ node, startTime, durationTime }, index) => {
        return {
          id: String(attribute(node, "id") ?? `marker-${index + 1}`),
          start: rationalSeconds(startTime),
          duration: rationalSeconds(durationTime),
          startTime,
          durationTime,
          name: String(attribute(node, "value") ?? attribute(node, "name") ?? `Marker ${index + 1}`),
        };
      });
  }

  private captionsFromXml(elements: TimelineEntry[]): Caption[] {
    return elements
      .filter(({ kind }) => kind === "caption")
      .map(({ node, startTime, durationTime }, index) => {
        return {
          id: String(attribute(node, "id") ?? `caption-${index + 1}`),
          start: rationalSeconds(startTime),
          duration: rationalSeconds(durationTime),
          startTime,
          durationTime,
          text: String(attribute(node, "text") ?? attribute(node, "name") ?? ""),
        };
      });
  }

  private updateSequenceDuration(sequence: XmlNode, spine: XmlNode): void {
    const duration = Math.max(0, ...timelineEntries(spine)
      .filter(({ kind }) => kind !== "marker" && kind !== "caption")
      .map(({ startTime, durationTime }) => rationalSeconds(startTime) + rationalSeconds(durationTime)));
    setAttribute(sequence, "duration", formatSeconds(duration));
  }

  private mediaFromResources() {
    const resources = findElement(this.xml ?? [], "resources");
    return storyEntries(resources ?? {})
      .filter(({ kind }) => kind === "asset" || kind === "media" || kind === "effect")
      .map(({ node }) => ({
        mediaId: String(attribute(node, "id") ?? ""),
        source: resolveMediaSource(
          String(attribute(node, "src") ?? attribute(node, "name") ?? attribute(node, "id") ?? ""),
          this.filePath,
        ),
      }))
      .filter((media) => media.mediaId.length > 0);
  }

  private revision(): ContextRevision {
    return { id: `rev-${this.sequence}`, sequence: this.sequence, timestamp: new Date(this.sequence).toISOString() };
  }
}

export function resolveMediaSource(source: string, documentPath: string): string {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }
  if (isAbsolute(source)) return source;
  return resolve(dirname(documentPath), source);
}

function storyEntries(node: XmlNode): Array<{ kind: string; node: XmlNode }> {
  return Object.entries(node)
    .filter(([kind]) => kind !== ":@")
    .flatMap(([kind, value]) => Array.isArray(value)
      ? value.filter((child): child is XmlNode => typeof child === "object" && child !== null)
        .map((child) => ({ kind: Object.keys(child).find((key) => key !== ":@") ?? kind, node: child }))
      : []);
}

function timelineEntries(spine: XmlNode): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  const visit = (node: XmlNode, parentStart: RationalTime, parentPath: string): void => {
    storyEntries(node).forEach(({ kind, node: child }, index) => {
      const path = parentPath.length === 0 ? String(index) : `${parentPath}.${index}`;
      const localStart = parseRational(
        attribute(child, "offset")
          ?? ((kind === "marker" || kind === "caption") ? attribute(child, "start") : undefined)
          ?? "0s",
      );
      const durationTime = parseRational(attribute(child, "duration") ?? "0s");
      const startTime = addRational(parentStart, localStart);
      if (TIMELINE_KINDS.has(kind)) {
        entries.push({ kind, node: child, path, startTime, durationTime });
      }
      visit(child, startTime, path);
    });
  };

  visit(spine, { value: "0", timescale: "1" }, "");
  return entries;
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
  return rationalSeconds(parseRational(value));
}

function parseDb(value: unknown): number {
  return Number(String(value).replace(/dB$/i, ""));
}

function parseRational(value: unknown): RationalTime {
  return rationalTime(rationalParts(value));
}

function rationalSeconds(value: RationalTime): number {
  const seconds = Number(value.value) / Number(value.timescale);
  if (!Number.isFinite(seconds)) throw new Error("FCPXML_INVALID_TIME: rational time is not finite");
  return seconds;
}

function rationalParts(value: unknown): { numerator: bigint; denominator: bigint } {
  const normalized = String(value).replace(/s$/, "");
  const parts = normalized.split("/");
  if (parts.length > 2) throw new Error(`FCPXML_INVALID_TIME: ${String(value)}`);
  const [numeratorText, denominatorText = "1"] = parts;
  if (!/^-?\d+$/.test(numeratorText) || !/^\d+$/.test(denominatorText)) {
    throw new Error(`FCPXML_INVALID_TIME: ${String(value)}`);
  }
  const numerator = BigInt(numeratorText);
  const denominator = BigInt(denominatorText);
  if (denominator <= 0n) throw new Error(`FCPXML_INVALID_TIME: ${String(value)}`);
  return { numerator, denominator };
}

function rationalTime(parts: { numerator: bigint; denominator: bigint }): RationalTime {
  const divisor = greatestCommonDivisor(parts.numerator, parts.denominator);
  return {
    value: String(parts.numerator / divisor),
    timescale: String(parts.denominator / divisor),
  };
}

function addRational(left: RationalTime, right: RationalTime): RationalTime {
  return rationalTime({
    numerator: BigInt(left.value) * BigInt(right.timescale) + BigInt(right.value) * BigInt(left.timescale),
    denominator: BigInt(left.timescale) * BigInt(right.timescale),
  });
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
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

function stableProjectId(project: XmlNode): string {
  return `fcpxml:project:${immutableUid(project, "PROJECT")}`;
}

function stableSequenceId(sequence: XmlNode | undefined): string {
  return `fcpxml:sequence:${immutableUid(sequence, "SEQUENCE")}`;
}

function immutableUid(node: XmlNode | undefined, kind: "PROJECT" | "SEQUENCE"): string {
  const uid = node ? attribute(node, "uid") : undefined;
  if (uid === undefined || String(uid).trim().length === 0) {
    throw new Error(`FCPXML_${kind}_IDENTITY_UNAVAILABLE: ${kind.toLowerCase()} has no immutable uid`);
  }
  return String(uid);
}

function stableTimelineId(project: XmlNode, sequence: XmlNode | undefined): string {
  stableProjectId(project);
  return stableSequenceId(sequence);
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
