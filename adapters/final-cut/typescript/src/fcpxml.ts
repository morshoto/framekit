import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type {
  Caption,
  Clip,
  ContextRevision,
  AddPictureInPictureOperation,
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
  WorkflowOperation,
} from "@framekit/runtime";
import { withCapabilityFamilies } from "@framekit/runtime";

type XmlNode = Record<string, any>;
type OrderedXml = XmlNode[];
type TimelineEntry = {
  kind: string;
  node: XmlNode;
  path: string;
  startTime: RationalTime;
  durationTime: RationalTime;
  parent: XmlNode;
  parentStartTime: RationalTime;
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

  public async getManagedArtifactDigest(): Promise<string> {
    return hash(await readFile(this.filePath, "utf8"));
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    let hasStableEffects = false;
    try {
      await this.ensureLoaded();
      hasStableEffects = effectResources(this.xml ?? []).some((resource) => stableEffectIdentity(resource) !== undefined);
    } catch {
      // Capability inspection remains useful before an artifact is created.
    }
    return withCapabilityFamilies({
      editor: {
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: false,
        timelineArtifactWrite: true,
        readAfterWrite: true,
        incrementalChanges: false,
        rollback: true,
        liveStateRead: false,
        playheadWrite: false,
        frameCapture: false,
        projectCatalogRead: true,
        projectSelection: true,
        compositeTransactions: true,
        assetDiscovery: hasStableEffects,
        mediaImport: false,
        mediaPlacement: true,
        pictureInPicture: true,
        titlePlacement: hasStableEffects,
        clipMove: true,
        clipReplace: true,
        clipRemoval: true,
        transitionPlacement: hasStableEffects,
        audioAttachment: true,
        audioMixing: true,
        masking: false,
        personCutout: false,
        semanticOperations: { "add-marker": true, "set-gain": true, "timeline.picture-in-picture.add": true },
      },
      analyzers: emptyAnalyzerCapabilities(),
    }, { backend: "fcpxml-document" });
  }

  public async listAssets(): Promise<EditorAsset[]> {
    await this.ensureLoaded();
    return effectResources(this.xml ?? [])
      .map((resource): EditorAsset | undefined => {
        const identity = stableEffectIdentity(resource);
        const localId = String(attribute(resource, "id") ?? "");
        if (!identity || !localId) return undefined;
        return {
          id: `fcpxml:effect:${identity}`,
          kind: "effect" as const,
          name: String(attribute(resource, "name") ?? identity),
          vendor: "Final Cut Pro",
          metadata: {
            identity,
            localId,
            provider: "fcpxml-document",
            source: "fcpxml-resources",
            discovery: { backend: "fcpxml-document", guarantee: "canonical-read" },
          },
        } satisfies EditorAsset;
      })
      .filter((asset): asset is EditorAsset => asset !== undefined);
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
    const frameDuration = sequenceFrameDuration(sequence, this.xml ?? []);
    const durationTime = attribute(sequence, "duration") === undefined
      ? timelineDuration(elements)
      : parseRational(attribute(sequence, "duration"));
    return {
      projectId,
      projectName,
      timeline: {
        id: timelineId,
        name: sequenceName,
        duration: rationalSeconds(durationTime),
        durationTime,
        ...(frameDuration ? { frameDuration } : {}),
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
    const originalXml = structuredClone(this.xml!);
    const originalSequence = this.sequence;
    const originalSignature = this.fileSignature;
    this.history.set(expectedRevision.id, structuredClone(this.xml!));
    try {
      this.applyOperation(operation);
      this.sequence += 1;
      await this.persist();
      return this.revision();
    } catch (error) {
      this.xml = originalXml;
      this.sequence = originalSequence;
      this.fileSignature = originalSignature;
      throw error;
    }
  }

  public async previewTransaction(
    operations: import("@framekit/runtime").WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<ProjectSnapshot> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: FCPXML document changed before preview");
    }
    const originalXml = structuredClone(this.xml!);
    const originalSequence = this.sequence;
    const originalSignature = this.fileSignature;
    try {
      for (const operation of operations) {
        this.assertArtifactOperationSupported(operation, "preview");
        this.applyOperation(operation);
      }
      const preview = await this.readProject();
      return preview;
    } finally {
      this.xml = originalXml;
      this.sequence = originalSequence;
      this.fileSignature = originalSignature;
    }
  }

  public async applyTransaction(
    operations: import("@framekit/runtime").WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<void> {
    await this.ensureLoaded();
    if (!sameRevision(expectedRevision, this.revision())) {
      throw new Error("STALE_CONTEXT: FCPXML document changed before transaction");
    }
    const originalXml = structuredClone(this.xml!);
    const originalSequence = this.sequence;
    const originalSignature = this.fileSignature;
    this.history.set(expectedRevision.id, structuredClone(this.xml!));
    try {
      for (const operation of operations) {
        this.assertArtifactOperationSupported(operation, "transaction");
        this.applyOperation(operation);
      }
      this.sequence += 1;
      await this.persist();
    } catch (error) {
      this.xml = originalXml;
      this.sequence = originalSequence;
      this.fileSignature = originalSignature;
      throw error;
    }
  }

  private assertArtifactOperationSupported(operation: WorkflowOperation, phase: "preview" | "transaction"): void {
    const supported = new Set([
      "rename-clip",
      "trim-clip",
      "set-gain",
      "ripple-delete",
      "add-marker",
      "timeline.media.add",
      "timeline.picture-in-picture.add",
      "timeline.audio.fades",
      "timeline.title.add",
      "timeline.media.move",
      "timeline.media.replace",
      "timeline.media.remove",
      "timeline.transition.add",
      "timeline.audio.attach",
      "timeline.audio.mix",
    ]);
    if (!supported.has(operation.type)) {
      throw new Error(`CAPABILITY_UNAVAILABLE: FCPXML ${phase} does not support ${operation.type}`);
    }
  }

  private applyOperation(operation: WorkflowOperation): void {
    const project = this.projectNode();
    const sequenceNode = findElement(project, "sequence");
    if (!sequenceNode) throw new Error("FCPXML_SCHEMA_UNSUPPORTED: project sequence is required");
    const spine = findElement(sequenceNode, "spine");
    if (!spine) throw new Error("FCPXML_SCHEMA_UNSUPPORTED: sequence spine is required");
    const sequence = sequenceNode;
    const timelineId = stableTimelineId(project, sequenceNode);

    if (operation.type === "timeline.picture-in-picture.add") {
      this.applyPictureInPicture(spine, timelineId, operation);
      this.updateSequenceDuration(sequence, spine);
      return;
    }

    switch (operation.type) {
      case "rename-clip": {
        const entry = this.findClipEntry(spine, operation.clipId, timelineId);
        if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (operation.name.trim().length === 0) throw new Error("INVALID_OPERATION: clip name cannot be empty");
        setAttribute(entry.node, "name", operation.name);
        break;
      }
      case "trim-clip": {
        const entry = this.findClipEntry(spine, operation.clipId, timelineId);
        if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if ((!Number.isFinite(operation.duration) || operation.duration <= 0) && !operation.durationTime) {
          throw new Error("INVALID_OPERATION: clip duration must be positive");
        }
        const duration = operation.durationTime ? rationalSeconds(operation.durationTime) : operation.duration;
        this.assertSourceRange(entry.node, duration);
        setAttribute(entry.node, "duration", operation.durationTime ? formatRational(operation.durationTime) : formatSeconds(duration));
        break;
      }
      case "set-gain": {
        const entry = this.findClipEntry(spine, operation.clipId, timelineId);
        if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
        if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
        this.setAdjustVolume(entry.node, operation.gainDb);
        break;
      }
      case "ripple-delete":
        if (operation.timelineId !== timelineId) throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
        this.applyRippleDelete(spine, operation.range.start, operation.range.end);
        break;
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
      case "timeline.media.add":
        this.applyMediaAdd(spine, timelineId, operation);
        break;
      case "timeline.audio.fades":
        this.applyAudioFades(spine, timelineId, operation);
        break;
      case "timeline.title.add":
        this.applyTitleAdd(spine, timelineId, operation);
        break;
      case "timeline.media.move":
        this.applyMediaMove(spine, timelineId, operation);
        break;
      case "timeline.media.replace":
        this.applyMediaReplace(spine, timelineId, operation);
        break;
      case "timeline.media.remove":
        this.applyMediaRemove(spine, timelineId, operation);
        break;
      case "timeline.transition.add":
        this.applyTransitionAdd(spine, timelineId, operation);
        break;
      case "timeline.audio.attach":
        this.applyAudioAttach(spine, timelineId, operation);
        break;
      case "timeline.audio.mix":
        this.applyAudioMix(spine, timelineId, operation);
        break;
    }
    this.updateSequenceDuration(sequence, spine);
  }

  private findClipEntry(spine: XmlNode, clipId: string, timelineId: string): TimelineEntry | undefined {
    return timelineEntries(spine)
      .filter(({ kind }) => CLIP_KINDS.has(kind))
      .find(({ kind, node, path }) => this.instanceId(node, kind, path, timelineId) === clipId);
  }

  private mediaResource(mediaId: string): ReturnType<FcpxmlDocumentAdapter["mediaFromResources"]>[number] {
    const media = this.mediaFromResources().find((candidate) => candidate.mediaId === mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${mediaId}`);
    return media;
  }

  private effectResource(assetId: string, operation: "title" | "transition"): XmlNode {
    const resource = effectResources(this.xml ?? []).find((candidate) => {
      const localId = String(attribute(candidate, "id") ?? "");
      const identity = stableEffectIdentity(candidate);
      return assetId === localId || assetId === identity || assetId === `fcpxml:effect:${identity}`;
    });
    if (!resource) throw new Error(`${operation === "title" ? "TITLE" : "TRANSITION"}_ASSET_NOT_FOUND: ${assetId}`);
    if (!stableEffectIdentity(resource)) {
      throw new Error(`FCPXML_EFFECT_IDENTITY_UNAVAILABLE: ${assetId}`);
    }
    return resource;
  }

  private applyMediaAdd(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.media.add" }>,
  ): void {
    const media = this.mediaResource(operation.mediaId);
    if (timelineEntries(spine).some(({ kind, node, path }) => this.instanceId(node, kind, path, timelineId) === operation.occurrenceId)) {
      throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${operation.occurrenceId}`);
    }
    if (!Number.isFinite(operation.start) || !Number.isFinite(operation.duration)
      || operation.start < 0 || operation.duration <= 0) {
      throw new Error("INVALID_OPERATION: media placement timing");
    }
    if (!mediaKindCompatible(operation.role, media.mediaKind)) {
      throw new Error(`MEDIA_KIND_MISMATCH: ${operation.mediaId}`);
    }
    if (media.duration !== undefined && operation.duration > media.duration) {
      throw new Error("INVALID_OPERATION: media placement duration must fit the source");
    }
    const lane = operation.targetLane ?? (operation.role === "video" ? "primary" : undefined);
    if (operation.role === "video" && lane !== "primary") {
      throw new Error("INVALID_OPERATION: video must target the primary storyline");
    }
    if (operation.role !== "video" && (typeof lane !== "number" || lane === 0)) {
      throw new Error("INVALID_OPERATION: audio requires an explicit non-primary lane");
    }
    const kind = operation.role === "video" ? "asset-clip" : "audio";
    const node = elementNode(kind, {
      id: operation.occurrenceId,
      ref: operation.mediaId,
      offset: formatSeconds(operation.start),
      start: "0s",
      duration: formatSeconds(operation.duration),
      ...(lane === "primary" ? {} : { lane: String(lane) }),
      ...(operation.role === "video" ? {} : { role: operation.role }),
    });
    appendChild(spine, kind, node);
  }

  private applyAudioFades(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.audio.fades" }>,
  ): void {
    const entry = this.findClipEntry(spine, operation.clipId, timelineId);
    if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
    if (!Number.isFinite(operation.fadeIn) || !Number.isFinite(operation.fadeOut)
      || operation.fadeIn < 0 || operation.fadeOut < 0
      || operation.fadeIn + operation.fadeOut > rationalSeconds(entry.durationTime)) {
      throw new Error("INVALID_OPERATION: audio fades must be non-negative and fit within the clip duration");
    }
    this.setAudioFades(entry.node, operation.fadeIn, operation.fadeOut);
  }

  private applyTitleAdd(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.title.add" }>,
  ): void {
    const effect = this.effectResource(operation.assetId, "title");
    this.assertNewOccurrence(spine, timelineId, operation.occurrenceId);
    if (!operation.text.trim() || !Number.isFinite(operation.start) || !Number.isFinite(operation.duration)
      || operation.start < 0 || operation.duration <= 0 || !Number.isInteger(operation.targetLane) || operation.targetLane === 0) {
      throw new Error("INVALID_OPERATION: title text, timing, and non-primary lane are required");
    }
    const node = elementNode("title", {
      id: operation.occurrenceId,
      ref: String(attribute(effect, "id")),
      name: String(attribute(effect, "name") ?? operation.assetId),
      offset: formatSeconds(operation.start),
      duration: formatSeconds(operation.duration),
      lane: String(operation.targetLane),
    });
    appendTextChild(node, "text", operation.text);
    appendChild(spine, "title", node);
  }

  private applyMediaMove(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.media.move" }>,
  ): void {
    const entry = this.findClipEntry(spine, operation.occurrenceId, timelineId);
    if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.occurrenceId}`);
    if (!Number.isFinite(operation.start) || operation.start < 0) {
      throw new Error("INVALID_OPERATION: media move start must be non-negative");
    }
    const existingLane = attribute(entry.node, "lane");
    const lane = operation.targetLane ?? (existingLane === undefined ? "primary" : Number(existingLane));
    if (lane === "primary" && entry.parent !== spine) {
      throw new Error("CAPABILITY_UNAVAILABLE: moving nested FCPXML media to the primary storyline");
    }
    if (lane !== "primary" && (!Number.isInteger(lane) || lane === 0)) {
      throw new Error("INVALID_OPERATION: media move requires a valid lane");
    }
    const parentStart = rationalSeconds(entry.parentStartTime);
    if (operation.start < parentStart) {
      throw new Error("INVALID_OPERATION: media move cannot precede its FCPXML parent");
    }
    setAttribute(entry.node, "offset", formatSeconds(operation.start - parentStart));
    if (lane === "primary") removeAttribute(entry.node, "lane");
    else setAttribute(entry.node, "lane", String(lane));
  }

  private applyMediaReplace(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.media.replace" }>,
  ): void {
    const entry = this.findClipEntry(spine, operation.occurrenceId, timelineId);
    if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.occurrenceId}`);
    const media = this.mediaResource(operation.mediaId);
    const currentMediaId = attribute(entry.node, "ref");
    const currentMedia = currentMediaId === undefined
      ? undefined
      : this.mediaFromResources().find((candidate) => candidate.mediaId === String(currentMediaId));
    const currentKind = entry.kind === "audio" ? "audio" : currentMedia?.mediaKind;
    if ((currentKind !== undefined && media.mediaKind !== undefined && currentKind !== media.mediaKind)
      || entry.kind === "audio" && media.mediaKind === "video") {
      throw new Error(`MEDIA_KIND_MISMATCH: ${operation.mediaId}`);
    }
    const duration = operation.duration ?? rationalSeconds(entry.durationTime);
    if (!Number.isFinite(duration) || duration <= 0 || media.duration !== undefined
      && sourceStart(entry.node) + duration > media.duration) {
      throw new Error("INVALID_OPERATION: replacement duration must fit the source");
    }
    setAttribute(entry.node, "ref", operation.mediaId);
    setAttribute(entry.node, "duration", formatSeconds(duration));
    setAttribute(entry.node, "name", media.source.split("/").pop() || media.mediaId);
  }

  private applyMediaRemove(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.media.remove" }>,
  ): void {
    const entry = this.findClipEntry(spine, operation.occurrenceId, timelineId);
    if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.occurrenceId}`);
    removeChild(entry.parent, entry.node);
  }

  private applyTransitionAdd(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.transition.add" }>,
  ): void {
    const effect = this.effectResource(operation.assetId, "transition");
    this.assertNewOccurrence(spine, timelineId, operation.transitionId);
    const before = this.findClipEntry(spine, operation.beforeClipId, timelineId);
    const after = this.findClipEntry(spine, operation.afterClipId, timelineId);
    if (!before || !after || before.parent !== spine || after.parent !== spine) {
      throw new Error("EDIT_POINT_NOT_FOUND: transition clips are required on the primary storyline");
    }
    const beforeIndex = childIndex(spine, before.node);
    const afterIndex = childIndex(spine, after.node);
    if (beforeIndex < 0 || afterIndex !== beforeIndex + 1) {
      throw new Error("EDIT_POINT_INVALID: transition clips must be adjacent");
    }
    const beforeEnd = rationalSeconds(before.startTime) + rationalSeconds(before.durationTime);
    if (Math.abs(beforeEnd - rationalSeconds(after.startTime)) > 1e-6) {
      throw new Error("EDIT_POINT_INVALID: transition clips must meet on one lane");
    }
    if (!Number.isFinite(operation.duration) || operation.duration <= 0
      || operation.duration > Math.min(rationalSeconds(before.durationTime), rationalSeconds(after.durationTime))) {
      throw new Error("INVALID_OPERATION: transition duration must fit both clips");
    }
    const node = elementNode("transition", {
      id: operation.transitionId,
      name: String(attribute(effect, "name") ?? operation.assetId),
      offset: formatSeconds(rationalSeconds(after.startTime) - operation.duration / 2),
      duration: formatSeconds(operation.duration),
      "framekit-before-clip": operation.beforeClipId,
      "framekit-after-clip": operation.afterClipId,
    });
    appendChild(node, "filter-video", elementNode("filter-video", {
      ref: String(attribute(effect, "id")),
      name: String(attribute(effect, "name") ?? operation.assetId),
    }));
    insertChildAt(spine, "transition", node, afterIndex);
  }

  private applyAudioAttach(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.audio.attach" }>,
  ): void {
    const target = this.findClipEntry(spine, operation.targetClipId, timelineId);
    if (!target) throw new Error(`CLIP_NOT_FOUND: ${operation.targetClipId}`);
    const media = this.mediaResource(operation.mediaId);
    if (media.mediaKind !== "audio") throw new Error(`AUDIO_MEDIA_REQUIRED: ${operation.mediaId}`);
    this.assertNewOccurrence(spine, timelineId, operation.occurrenceId);
    const startOffset = operation.startOffset ?? 0;
    const duration = operation.duration ?? media.duration;
    if (!Number.isFinite(startOffset) || startOffset < 0 || duration === undefined
      || !Number.isFinite(duration) || duration <= 0 || media.duration !== undefined && duration > media.duration
      || startOffset + duration > rationalSeconds(target.durationTime)) {
      throw new Error("INVALID_OPERATION: attached audio must fit within the target clip");
    }
    const node = elementNode("audio", {
      id: operation.occurrenceId,
      ref: operation.mediaId,
      offset: formatSeconds(startOffset),
      start: "0s",
      duration: formatSeconds(duration),
      lane: "-1",
      role: "audio",
      "framekit-attached-to": operation.targetClipId,
    });
    appendChild(target.node, "audio", node);
  }

  private applyAudioMix(
    spine: XmlNode,
    timelineId: string,
    operation: Extract<WorkflowOperation, { type: "timeline.audio.mix" }>,
  ): void {
    const entry = this.findClipEntry(spine, operation.clipId, timelineId);
    if (!entry) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
    const mediaId = attribute(entry.node, "ref");
    const media = mediaId === undefined ? undefined : this.mediaFromResources().find((candidate) => candidate.mediaId === String(mediaId));
    if (entry.kind !== "audio" && media?.mediaKind !== "audio") {
      throw new Error("INVALID_OPERATION: audio mix requires an audio clip");
    }
    if (operation.gainDb === undefined && operation.fadeIn === undefined && operation.fadeOut === undefined) {
      throw new Error("INVALID_OPERATION: audio mix requires a gain or fade change");
    }
    if (operation.gainDb !== undefined) {
      if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
      this.setAdjustVolume(entry.node, operation.gainDb);
    }
    if (operation.fadeIn !== undefined || operation.fadeOut !== undefined) {
      const existing = audioFadeProperties(entry.node);
      const fadeIn = operation.fadeIn ?? existing.fadeIn ?? 0;
      const fadeOut = operation.fadeOut ?? existing.fadeOut ?? 0;
      if (!Number.isFinite(fadeIn) || !Number.isFinite(fadeOut) || fadeIn < 0 || fadeOut < 0
        || fadeIn + fadeOut > rationalSeconds(entry.durationTime)) {
        throw new Error("INVALID_OPERATION: audio mix values must fit the clip");
      }
      this.setAudioFades(entry.node, fadeIn, fadeOut);
    }
  }

  private setAudioFades(node: XmlNode, fadeIn: number, fadeOut: number): void {
    const volume = firstChild(node, "adjust-volume") ?? elementNode("adjust-volume", {});
    if (!firstChild(node, "adjust-volume")) appendChild(node, "adjust-volume", volume);
    const param = firstChild(volume, "param") ?? elementNode("param", { name: "amount" });
    if (!firstChild(volume, "param")) appendChild(volume, "param", param);
    removeChildren(param, "fadeIn");
    removeChildren(param, "fadeOut");
    appendChild(param, "fadeIn", elementNode("fadeIn", { duration: formatSeconds(fadeIn) }));
    appendChild(param, "fadeOut", elementNode("fadeOut", { duration: formatSeconds(fadeOut) }));
  }

  private assertNewOccurrence(spine: XmlNode, timelineId: string, occurrenceId: string): void {
    if (timelineEntries(spine).some(({ kind, node, path }) => this.instanceId(node, kind, path, timelineId) === occurrenceId)) {
      throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${occurrenceId}`);
    }
  }

  private assertSourceRange(node: XmlNode, duration: number): void {
    const mediaId = attribute(node, "ref");
    if (mediaId === undefined) return;
    const media = this.mediaFromResources().find((candidate) => candidate.mediaId === String(mediaId));
    if (media?.duration !== undefined && sourceStart(node) + duration > media.duration) {
      throw new Error("INVALID_OPERATION: clip duration must fit the source");
    }
  }

  private applyRippleDelete(spine: XmlNode, start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error("INVALID_OPERATION: ripple-delete range must be finite and increasing");
    }
    const direct = storyEntries(spine)
      .map(({ kind, node }) => timelineEntries(spine).find((entry) => entry.node === node && entry.kind === kind))
      .filter((entry): entry is TimelineEntry => entry !== undefined);
    const delta = end - start;
    for (const entry of direct) {
      const entryStart = rationalSeconds(entry.startTime);
      const entryEnd = entryStart + rationalSeconds(entry.durationTime);
      if (entryEnd <= start || entryStart >= end) continue;
      if (entry.kind === "transition") {
        throw new Error("CAPABILITY_UNAVAILABLE: FCPXML ripple-delete cannot transform transitions safely");
      }
      if (storyEntries(entry.node).length > 0) {
        throw new Error("CAPABILITY_UNAVAILABLE: FCPXML ripple-delete cannot split anchored story elements safely");
      }
      if (entryStart < start && entryEnd > end) {
        throw new Error("CAPABILITY_UNAVAILABLE: FCPXML ripple-delete requires a source-preserving clip split");
      }
    }
    for (const entry of direct) {
      const entryStart = rationalSeconds(entry.startTime);
      const entryEnd = entryStart + rationalSeconds(entry.durationTime);
      if (entryEnd <= start) continue;
      if (entryStart >= end) {
        setAttribute(entry.node, "offset", formatSeconds(entryStart - delta));
        continue;
      }
      if (entryStart < start && entryEnd <= end) {
        const duration = start - entryStart;
        if (duration <= 0) removeChild(entry.parent, entry.node);
        else setAttribute(entry.node, "duration", formatSeconds(duration));
        continue;
      }
      if (entryStart >= start && entryEnd > end) {
        const duration = entryEnd - end;
        const sourceAdvance = end - entryStart;
        setAttribute(entry.node, "offset", formatSeconds(start));
        setAttribute(entry.node, "duration", formatSeconds(duration));
        if (CLIP_KINDS.has(entry.kind)) setAttribute(entry.node, "start", formatSeconds(sourceStart(entry.node) + sourceAdvance));
        continue;
      }
      removeChild(entry.parent, entry.node);
    }
  }

  private applyPictureInPicture(
    spine: XmlNode,
    timelineId: string,
    operation: AddPictureInPictureOperation,
  ): void {
    const media = this.mediaFromResources().find((candidate) => candidate.mediaId === operation.mediaId);
    if (!media) throw new Error(`MEDIA_NOT_FOUND: ${operation.mediaId}`);
    if (media.mediaKind !== undefined && media.mediaKind !== "video") {
      throw new Error(`MEDIA_KIND_MISMATCH: ${operation.mediaId}`);
    }
    if (this.findClipNode(spine, operation.occurrenceId, timelineId)) {
      throw new Error(`OCCURRENCE_ALREADY_EXISTS: ${operation.occurrenceId}`);
    }
    const anchorEntry = timelineEntries(spine)
      .find(({ kind, node, path }) => CLIP_KINDS.has(kind)
        && this.instanceId(node, kind, path, timelineId) === operation.attachedTo);
    if (!anchorEntry) throw new Error(`CLIP_NOT_FOUND: ${operation.attachedTo}`);
    if (anchorEntry.kind !== "asset-clip" && anchorEntry.kind !== "clip"
      && anchorEntry.kind !== "ref-clip" && anchorEntry.kind !== "sync-clip"
      && anchorEntry.kind !== "mc-clip") {
      throw new Error("INVALID_OPERATION: PIP anchor must be a video occurrence");
    }
    if (operation.frame) {
      throw new Error("CAPABILITY_UNAVAILABLE: FCPXML picture-in-picture frame requires the native Final Cut provider");
    }
    validatePictureInPictureOperation(operation, anchorEntry.startTime, anchorEntry.durationTime, media.duration);
    const connected = {
      "asset-clip": [],
      ":@": {
        "@_id": operation.occurrenceId,
        "@_name": media.source.split("/").pop() || operation.mediaId,
        "@_ref": operation.mediaId,
        "@_offset": formatSeconds(operation.start - rationalSeconds(anchorEntry.startTime)),
        "@_start": "0s",
        "@_duration": formatSeconds(operation.duration),
        "@_lane": String(operation.targetLane),
        "@_framekit-attached-to": operation.attachedTo,
      },
    } satisfies XmlNode;
    appendChild(anchorEntry.node, "asset-clip", connected);
    appendChild(connected, "adjust-transform", {
      ":@": {
        "@_position": `${operation.position.x} ${operation.position.y}`,
        "@_scale": `${operation.scale * 100} ${operation.scale * 100}`,
      },
    });
    if (operation.crop) {
      appendChild(connected, "adjust-crop", {
        ":@": {
          "@_mode": "crop",
        },
      });
      const crop = firstChild(connected, "adjust-crop");
      if (!crop) throw new Error("FCPXML_INVALID_PIP: crop adjustment could not be created");
      appendChild(crop, "crop-rect", {
        ":@": {
          "@_top": formatPictureInPicturePercentage(operation.crop.top),
          "@_right": formatPictureInPicturePercentage(operation.crop.right),
          "@_bottom": formatPictureInPicturePercentage(operation.crop.bottom),
          "@_left": formatPictureInPicturePercentage(operation.crop.left),
        },
      });
    }
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
    const temporaryPath = `${this.filePath}.framekit-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, this.filePath);
      this.fileSignature = hash(content);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private projectNode(): XmlNode {
    return findElement(this.xml ?? [], "project") ?? {};
  }

  private storyElementFromXml(entry: TimelineEntry, timelineId: string): StoryElement {
    const { node, kind, path, startTime, durationTime } = entry;
    const visual = pictureInPictureProperties(node);
    const referencedEffect = kind === "title"
      ? attribute(node, "ref")
      : kind === "transition" ? attribute(firstChild(node, "filter-video") ?? {}, "ref") : undefined;
    const assetId = referencedEffect === undefined ? undefined : this.effectAssetId(String(referencedEffect));
    const text = kind === "title" ? textChildValue(node, "text") : undefined;
    return {
      id: this.instanceId(node, kind, path, timelineId),
      kind,
      start: rationalSeconds(startTime),
      duration: rationalSeconds(durationTime),
      startTime,
      durationTime,
      ...(attribute(node, "lane") !== undefined ? { lane: Number(attribute(node, "lane")) } : {}),
      ...(CLIP_KINDS.has(kind) && attribute(node, "ref") !== undefined
        ? { mediaId: String(attribute(node, "ref")) }
        : {}),
      ...(attribute(node, "framekit-attached-to") !== undefined ? { attachedTo: String(attribute(node, "framekit-attached-to")) } : {}),
      ...(assetId ? { assetId } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(attribute(node, "framekit-before-clip") !== undefined
        ? { beforeClipId: String(attribute(node, "framekit-before-clip")) }
        : {}),
      ...(attribute(node, "framekit-after-clip") !== undefined
        ? { afterClipId: String(attribute(node, "framekit-after-clip")) }
        : {}),
      ...visual,
    };
  }

  private clipFromXml(entry: TimelineEntry, timelineId: string): Clip {
    const { node, kind, path, startTime, durationTime } = entry;
    const gain = firstChild(node, "adjust-volume");
    const visual = pictureInPictureProperties(node);
    const fades = audioFadeProperties(node);
    const sourceStartValue = attribute(node, "start");
    const sourceStartTime = sourceStartValue === undefined ? undefined : parseRational(sourceStartValue);
    const sourceStart = sourceStartTime === undefined ? undefined : rationalSeconds(sourceStartTime);
    if (sourceStart !== undefined && sourceStart < 0) throw new Error("FCPXML_INVALID_TIME: source clip start cannot be negative");
    return {
      id: this.instanceId(node, kind, path, timelineId),
      mediaId: attribute(node, "ref") === undefined ? undefined : String(attribute(node, "ref")),
      name: String(attribute(node, "name") ?? attribute(node, "ref") ?? `Clip ${path.includes(".") ? path : path + 1}`),
      start: rationalSeconds(startTime),
      duration: rationalSeconds(durationTime),
      ...(sourceStart !== undefined ? { sourceStart, sourceStartTime } : {}),
      track: Number(attribute(node, "lane") ?? 0),
      ...(kind === "audio" ? { role: "audio" as const } : {}),
      ...(attribute(node, "framekit-attached-to") !== undefined ? { attachedTo: String(attribute(node, "framekit-attached-to")) } : {}),
      startTime,
      durationTime,
      ...(gain ? { gainDb: parseDb(attribute(gain, "amount") ?? "0dB") } : {}),
      ...(fades.fadeIn !== undefined ? { fadeIn: fades.fadeIn } : {}),
      ...(fades.fadeOut !== undefined ? { fadeOut: fades.fadeOut } : {}),
      ...visual,
    };
  }

  private instanceId(node: XmlNode, kind: string, path: string, timelineId: string): string {
    const explicit = attribute(node, "id") ?? attribute(node, "uid");
    return String(explicit ?? `${timelineId}:spine:${path}:${kind}`);
  }

  private findClipNode(spine: XmlNode, clipId: string, timelineId: string): XmlNode | undefined {
    return this.findClipEntry(spine, clipId, timelineId)?.node;
  }

  private effectAssetId(ref: string): string | undefined {
    const effect = effectResources(this.xml ?? []).find((candidate) => attribute(candidate, "id") === ref);
    const identity = effect === undefined ? undefined : stableEffectIdentity(effect);
    return identity === undefined ? undefined : `fcpxml:effect:${identity}`;
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
    setAttribute(sequence, "duration", formatRational(timelineDuration(timelineEntries(spine))));
  }

  private mediaFromResources() {
    const resources = findElement(this.xml ?? [], "resources");
    return storyEntries(resources ?? {})
      .filter(({ kind }) => kind === "asset" || kind === "media")
      .map(({ node }) => {
        const durationValue = attribute(node, "duration");
        const mediaKind = mediaKindFromResource(node);
        return {
          mediaId: String(attribute(node, "id") ?? ""),
          source: resolveMediaSource(
            String(attribute(node, "src") ?? attribute(node, "name") ?? attribute(node, "id") ?? ""),
            this.filePath,
          ),
          ...(mediaKind ? { mediaKind } : {}),
          ...(durationValue !== undefined ? { duration: parseSeconds(durationValue) } : {}),
        };
      })
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

function effectResources(document: OrderedXml): XmlNode[] {
  const resources = findElement(document, "resources");
  return storyEntries(resources ?? {})
    .filter(({ kind }) => kind === "effect")
    .map(({ node }) => node);
}

function stableEffectIdentity(node: XmlNode): string | undefined {
  const uid = attribute(node, "uid");
  return uid === undefined || String(uid).trim().length === 0 ? undefined : String(uid);
}

function elementNode(kind: string, values: Record<string, string>): XmlNode {
  return {
    [kind]: [],
    ":@": Object.fromEntries(Object.entries(values).map(([name, value]) => [`@_${name}`, value])),
  };
}

function appendTextChild(node: XmlNode, kind: string, value: string): void {
  const elementKey = Object.keys(node).find((key) => key !== ":@");
  const child = { [kind]: [{ "#text": value }] };
  if (elementKey) {
    node[elementKey] = [...(Array.isArray(node[elementKey]) ? node[elementKey] : []), child];
  } else {
    node[kind] = [child];
  }
}

function childIndex(parent: XmlNode, child: XmlNode): number {
  for (const value of Object.values(parent)) {
    if (!Array.isArray(value)) continue;
    const index = value.indexOf(child);
    if (index >= 0) return index;
  }
  return -1;
}

function removeChild(parent: XmlNode, child: XmlNode): void {
  for (const [key, value] of Object.entries(parent)) {
    if (key === ":@" || !Array.isArray(value)) continue;
    const index = value.indexOf(child);
    if (index >= 0) {
      value.splice(index, 1);
      return;
    }
  }
}

function removeChildren(parent: XmlNode, kind: string): void {
  for (const [key, value] of Object.entries(parent)) {
    if (key === ":@" || !Array.isArray(value)) continue;
    parent[key] = value.filter((child) => Object.keys(child).find((name) => name !== ":@") !== kind);
  }
}

function sourceStart(node: XmlNode): number {
  const value = attribute(node, "start");
  return value === undefined ? 0 : parseSeconds(value);
}

function audioFadeProperties(node: XmlNode): { fadeIn?: number; fadeOut?: number } {
  const volume = firstChild(node, "adjust-volume");
  const param = volume === undefined ? undefined : firstChild(volume, "param");
  const fadeIn = param === undefined ? undefined : firstChild(param, "fadeIn");
  const fadeOut = param === undefined ? undefined : firstChild(param, "fadeOut");
  return {
    ...(fadeIn ? { fadeIn: parseSeconds(attribute(fadeIn, "duration") ?? "0s") } : {}),
    ...(fadeOut ? { fadeOut: parseSeconds(attribute(fadeOut, "duration") ?? "0s") } : {}),
  };
}

function textChildValue(node: XmlNode, kind: string): string | undefined {
  const text = firstChild(node, kind);
  if (!text) return undefined;
  const value = Array.isArray(text[kind]) ? text[kind][0]?.["#text"] : undefined;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

function mediaKindCompatible(role: "video" | "music" | "audio", mediaKind?: "video" | "audio"): boolean {
  if (mediaKind === undefined) return true;
  return role === "video" ? mediaKind === "video" : mediaKind === "audio";
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
        entries.push({ kind, node: child, path, startTime, durationTime, parent: node, parentStartTime: parentStart });
      }
      visit(child, startTime, path);
    });
  };

  visit(spine, { value: "0", timescale: "1" }, "");
  return entries;
}

function timelineDuration(entries: TimelineEntry[]): RationalTime {
  return entries
    .filter(({ kind }) => kind !== "marker" && kind !== "caption")
    .map(({ startTime, durationTime }) => addRational(startTime, durationTime))
    .reduce((maximum, endTime) => compareRational(endTime, maximum) > 0 ? endTime : maximum, {
      value: "0",
      timescale: "1",
    });
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

function sequenceFrameDuration(sequence: XmlNode, document: OrderedXml): RationalTime | undefined {
  const formatId = attribute(sequence, "format");
  if (formatId === undefined) return undefined;
  const resources = findElement(document, "resources");
  const format = storyEntries(resources ?? {}).find((entry) =>
    entry.kind === "format" && attribute(entry.node, "id") === String(formatId),
  )?.node;
  const value = attribute(format ?? {}, "frameDuration");
  return value === undefined ? undefined : parseRational(value);
}

function setAttribute(node: XmlNode, name: string, value: string): void {
  node[":@"] = { ...attributes(node), [`@_${name}`]: value };
}

function removeAttribute(node: XmlNode, name: string): void {
  const next = { ...attributes(node) };
  delete next[`@_${name}`];
  if (Object.keys(next).length === 0) delete node[":@"];
  else node[":@"] = next;
}

function insertChildAt(parent: XmlNode, kind: string, child: XmlNode, index: number): void {
  const elementKey = Object.keys(parent).find((key) => key !== ":@");
  const wrapper = Object.prototype.hasOwnProperty.call(child, kind)
    ? child
    : { [kind]: [], ...child };
  if (!elementKey) {
    parent[kind] = [wrapper];
    return;
  }
  const children = Array.isArray(parent[elementKey]) ? parent[elementKey] : [];
  children.splice(index, 0, wrapper);
  parent[elementKey] = children;
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

function compareRational(left: RationalTime, right: RationalTime): number {
  const difference = BigInt(left.value) * BigInt(right.timescale)
    - BigInt(right.value) * BigInt(left.timescale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
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
  if (!text.includes(".")) return rationalTime({ numerator: BigInt(text), denominator: 1n });
  const decimals = text.split(".")[1].length;
  const scale = 10 ** decimals;
  return rationalTime({ numerator: BigInt(Math.round(value * scale)), denominator: BigInt(scale) });
}

function formatDb(value: number): string {
  return `${value}dB`;
}

function mediaKindFromResource(node: XmlNode): "video" | "audio" | undefined {
  const hasVideo = attribute(node, "hasVideo");
  const hasAudio = attribute(node, "hasAudio");
  if (hasVideo === "1" || hasVideo === "true") return "video";
  if ((hasVideo === "0" || hasVideo === "false") && (hasAudio === "1" || hasAudio === "true")) return "audio";
  return undefined;
}

function validatePictureInPictureOperation(
  operation: AddPictureInPictureOperation,
  anchorStartTime: RationalTime,
  anchorDurationTime: RationalTime,
  mediaDuration?: number,
): void {
  const anchorStart = rationalSeconds(anchorStartTime);
  const anchorEnd = anchorStart + rationalSeconds(anchorDurationTime);
  if (!Number.isFinite(operation.start) || !Number.isFinite(operation.duration)
    || operation.start < anchorStart
    || operation.duration <= 0
    || operation.start + operation.duration > anchorEnd
    || !Number.isInteger(operation.targetLane)
    || operation.targetLane === 0
    || !Number.isFinite(operation.position.x)
    || !Number.isFinite(operation.position.y)
    || !Number.isFinite(operation.scale)
    || operation.scale <= 0
    || mediaDuration !== undefined && operation.duration > mediaDuration) {
    throw new Error("INVALID_OPERATION: PIP timing, connected lane, position, and scale are invalid");
  }
  if (operation.crop) validatePictureInPictureCrop(operation.crop);
}

function validatePictureInPictureCrop(crop: NonNullable<Clip["crop"]>): void {
  const values = [crop.top, crop.right, crop.bottom, crop.left];
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value < 1)
    || crop.left + crop.right >= 1
    || crop.top + crop.bottom >= 1) {
    throw new Error("INVALID_OPERATION: PIP crop must leave a positive source rectangle");
  }
}

function pictureInPictureProperties(node: XmlNode): Pick<Clip, "position" | "scale" | "crop" | "frame"> {
  const transform = firstChild(node, "adjust-transform");
  const crop = firstChild(node, "adjust-crop");
  const positionValue = transform ? attribute(transform, "position") : undefined;
  const scaleValue = transform ? attribute(transform, "scale") : undefined;
  const position = positionValue === undefined ? undefined : parsePictureInPicturePosition(positionValue);
  const scale = scaleValue === undefined ? undefined : parsePictureInPictureScale(scaleValue);
  const cropRect = crop ? firstChild(crop, "crop-rect") : undefined;
  const cropKeys = ["top", "right", "bottom", "left"];
  const hasCrop = cropRect !== undefined && cropKeys.some((key) => attribute(cropRect, key) !== undefined);
  const parsedCrop = hasCrop
    ? {
      top: parsePictureInPictureNumber(cropRect && attribute(cropRect, "top"), "top crop"),
      right: parsePictureInPictureNumber(cropRect && attribute(cropRect, "right"), "right crop"),
      bottom: parsePictureInPictureNumber(cropRect && attribute(cropRect, "bottom"), "bottom crop"),
      left: parsePictureInPictureNumber(cropRect && attribute(cropRect, "left"), "left crop"),
    }
    : undefined;
  if (parsedCrop) validatePictureInPictureCrop(parsedCrop);
  return {
    ...(position ? { position } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(parsedCrop ? { crop: parsedCrop } : {}),
  };
}

function parsePictureInPicturePosition(value: unknown): { x: number; y: number } {
  const values = String(value).trim().split(/\s+/).map(Number);
  if (values.length !== 2 || !values.every(Number.isFinite)) {
    throw new Error(`FCPXML_INVALID_PIP: position ${String(value)} is not a finite pair`);
  }
  return { x: values[0]!, y: values[1]! };
}

function parsePictureInPictureScale(value: unknown): number {
  const values = String(value).trim().split(/\s+/).map(Number);
  if (values.length !== 2 || !values.every((candidate) => Number.isFinite(candidate) && candidate > 0)
    || values[0] !== values[1]) {
    throw new Error(`FCPXML_INVALID_PIP: scale ${String(value)} is not a positive uniform pair`);
  }
  return values[0]! / 100;
}

function parsePictureInPictureNumber(value: unknown, label: string): number {
  const text = String(value ?? "").trim();
  const parsed = Number(text.replace(/%$/, ""));
  if (!Number.isFinite(parsed)) throw new Error(`FCPXML_INVALID_PIP: ${label} is not finite`);
  return text.endsWith("%") ? parsed / 100 : parsed;
}

function formatPictureInPicturePercentage(value: number): string {
  return `${value * 100}%`;
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
