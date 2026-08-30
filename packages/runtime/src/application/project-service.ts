import { ContextEngine } from "../context/context-engine.js";
import type { AssetSearchQuery, EditorAsset, EditorPort, ManagedArtifact } from "../domain/ports.js";
import type { ProjectCatalog, ProjectSelection } from "../domain/context.js";
import type { RationalTime } from "../domain/primitives.js";
import type { ProjectSnapshot } from "../domain/project.js";
import type { TimelineFrameCapture, VisualAnalysis } from "../domain/media.js";
import { withCanonicalTimelineMode } from "../capabilities.js";
import { isWithinClip, parseRational, rationalDifferenceSeconds } from "../timeline/rational-time.js";
import type { RuntimeOptions } from "./runtime-options.js";

export class ProjectService {
  public constructor(
    private readonly adapter: EditorPort,
    private readonly context: ContextEngine,
    private readonly options: RuntimeOptions,
  ) {}

  public async inspectProject(): Promise<ProjectSnapshot> {
    return this.context.inspectProject();
  }

  public async inspectTimeline(): Promise<ProjectSnapshot["timeline"]> {
    const project = await this.inspectProject();
    return project.timeline;
  }

  public async inspectArtifact(): Promise<ManagedArtifact> {
    if (!this.adapter.getManagedArtifact) {
      throw new Error("CAPABILITY_UNAVAILABLE: managed FCPXML artifact");
    }
    return this.adapter.getManagedArtifact();
  }

  public async captureFrame(
    position: RationalTime,
    options: { analyze?: boolean } = {},
  ): Promise<TimelineFrameCapture> {
    const exactPosition = parseRational(position, "INVALID_TIMELINE_POSITION");
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.frameCapture || !this.adapter.captureFrame) {
      throw new Error("CAPABILITY_UNAVAILABLE: timeline frame capture");
    }
    if (options.analyze && !this.options.visualAnalyzer) {
      throw new Error("CAPABILITY_UNAVAILABLE: visual analysis");
    }
    const project = await this.inspectProject();
    const source = await this.adapter.captureFrame(position, project.revision);
    const clip = project.timeline.clips
      .filter((candidate) => isWithinClip(exactPosition, candidate.startTime, candidate.durationTime))
      .sort((left, right) => right.track - left.track)[0];
    let analysis: VisualAnalysis | undefined;
    if (options.analyze) {
      const media = clip?.mediaId
        ? project.media.find((candidate) => candidate.mediaId === clip.mediaId)
        : undefined;
      if (!clip || !media) {
        throw new Error("CAPABILITY_UNAVAILABLE: visual analysis requires media at the captured position");
      }
      const mediaTime = rationalDifferenceSeconds(
        exactPosition,
        parseRational(clip.startTime, "INVALID_PROJECT_STATE"),
      );
      analysis = await this.options.visualAnalyzer!.analyze(
        { project, media },
        { start: mediaTime, end: mediaTime },
      );
    }
    return {
      image: structuredClone(source.image),
      position: { ...position },
      timecode: source.timecode,
      project: { id: project.projectId, name: project.projectName },
      sequence: { id: project.timeline.id, name: project.timeline.name },
      ...(clip ? {
        clip: {
          id: clip.id,
          ...(clip.mediaId ? { mediaId: clip.mediaId } : {}),
          name: clip.name,
          startTime: { ...clip.startTime },
          durationTime: { ...clip.durationTime },
          track: clip.track,
        },
      } : {}),
      ...(analysis ? { analysis } : {}),
    };
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.projectCatalogRead || !this.adapter.listProjects) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor project catalog");
    }
    return this.adapter.listProjects();
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.projectSelection || !this.adapter.selectProject) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor project selection");
    }
    if (!selection.projectId.trim()) throw new Error("INVALID_PROJECT_SELECTION: projectId is required");
    if (selection.sequenceId !== undefined && !selection.sequenceId.trim()) {
      throw new Error("INVALID_PROJECT_SELECTION: sequenceId cannot be empty");
    }
    return this.adapter.selectProject(selection);
  }

  public async inspectEditor() {
    const capabilities = withCanonicalTimelineMode(await this.adapter.getCapabilities());
    return {
      identity: await this.adapter.getIdentity(),
      capabilities: {
        ...capabilities,
        analyzers: {
          ...capabilities.analyzers,
          speechTranscribe: capabilities.analyzers.speechTranscribe || Boolean(this.options.speechAnalyzer),
          audioLoudness: capabilities.analyzers.audioLoudness || Boolean(this.options.audioAnalyzer),
          visualTrack: capabilities.analyzers.visualTrack || Boolean(this.options.visualAnalyzer),
        },
      },
    };
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    const capabilities = await this.adapter.getCapabilities();
    if (!capabilities.editor.assetDiscovery || !this.adapter.listAssets) {
      throw new Error("CAPABILITY_UNAVAILABLE: editor assets");
    }
    const assets = await this.context.listAssets(query);
    return assets.filter((asset) => matchesAssetQuery(asset, query));
  }
}

function matchesAssetQuery(asset: EditorAsset, query?: AssetSearchQuery): boolean {
  if (!query) return true;
  const normalized = query.query?.trim().toLowerCase();
  if (normalized && ![asset.id, asset.name, asset.vendor].some((value) => value.toLowerCase().includes(normalized))) {
    return false;
  }
  if (query.kind && asset.kind !== query.kind) return false;
  if (query.vendor && asset.vendor.toLowerCase() !== query.vendor.trim().toLowerCase()) return false;
  return true;
}
