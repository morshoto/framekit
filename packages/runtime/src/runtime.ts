import { ContextEngine } from "./context/context-engine.js";
import type {
  AgentContext,
  AssetSearchQuery,
  AudioAnalysis,
  CompositeEditPreview,
  CompositeEditRequest,
  ContextDiff,
  ContextRevision,
  EditOperation,
  EditTransaction,
  EditorAsset,
  EditorChange,
  EditorLiveState,
  EditorPort,
  MediaContext,
  MediaUnderstanding,
  MusicAddRequest,
  ProjectCatalog,
  ProjectSelection,
  ProjectSnapshot,
  RationalTime,
  SpeechAnalysis,
  TimelineDiff,
  TimelineFrameCapture,
  TimeRange,
  VerificationPolicy,
  VisualAnalysis,
} from "./domain/index.js";
import type { FillerRemovalPreview, FillerRemovalRequest } from "./speech/filler-removal.js";
import { DefaultVerificationEngine } from "./verification/verification.js";
import { ContextService } from "./context/context-service.js";
import { EditService } from "./editing/edit-service.js";
import { FillerRemovalService } from "./editing/filler-removal-service.js";
import { MediaAnalysisService } from "./application/media-analysis-service.js";
import { MusicService } from "./editing/music-service.js";
import { ProjectService } from "./application/project-service.js";
import type { RuntimeOptions } from "./application/runtime-options.js";
import { TransactionStore } from "./application/transaction-store.js";

/** Stable runtime façade exposed to the MCP server and editor adapters. */
export class AgentVideoRuntime {
  private readonly projects: ProjectService;
  private readonly contexts: ContextService;
  private readonly media: MediaAnalysisService;
  private readonly edits: EditService;
  private readonly music: MusicService;
  private readonly fillerRemoval: FillerRemovalService;

  public constructor(
    adapter: EditorPort,
    options: RuntimeOptions = {},
  ) {
    const context = new ContextEngine(adapter);
    const verificationEngine = options.verificationEngine ?? new DefaultVerificationEngine();
    const transactions = new TransactionStore();
    this.projects = new ProjectService(adapter, context, options);
    this.contexts = new ContextService(adapter, context);
    this.media = new MediaAnalysisService(this.projects, context, options);
    this.edits = new EditService(adapter, this.projects, this.media, verificationEngine, options, transactions);
    this.music = new MusicService(this.projects, this.edits);
    this.fillerRemoval = new FillerRemovalService(adapter, this.projects, verificationEngine, options, transactions);
  }

  public async inspectProject(): Promise<ProjectSnapshot> {
    return this.projects.inspectProject();
  }

  public async inspectTimeline(): Promise<ProjectSnapshot["timeline"]> {
    return this.projects.inspectTimeline();
  }

  public async captureFrame(
    position: RationalTime,
    options: { analyze?: boolean } = {},
  ): Promise<TimelineFrameCapture> {
    return this.projects.captureFrame(position, options);
  }

  public async listProjects(): Promise<ProjectCatalog> {
    return this.projects.listProjects();
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    return this.projects.selectProject(selection);
  }

  public async inspectEditor() {
    return this.projects.inspectEditor();
  }

  public async inspectContext(): Promise<AgentContext> {
    const editor = await this.inspectEditor();
    return this.contexts.inspectContext(editor.capabilities);
  }

  public async inspectLiveEditor(): Promise<EditorLiveState> {
    return this.contexts.inspectLiveEditor();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    return this.contexts.liveChangesSince(revision, waitMs);
  }

  public async edit(operation: EditOperation, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    return this.edits.edit(operation, policy);
  }

  public async previewEdit(request: CompositeEditRequest): Promise<CompositeEditPreview> {
    return this.edits.previewEdit(request);
  }

  public async executeEdit(previewToken: string, policy: VerificationPolicy = {}): Promise<EditTransaction> {
    return this.edits.executeEdit(previewToken, policy);
  }

  public async previewMusic(request: MusicAddRequest): Promise<CompositeEditPreview> {
    return this.music.previewMusic(request);
  }

  public async previewFillerRemoval(request: FillerRemovalRequest): Promise<FillerRemovalPreview> {
    return this.fillerRemoval.previewFillerRemoval(request);
  }

  public async executeFillerRemoval(previewToken: string): Promise<EditTransaction> {
    return this.fillerRemoval.executeFillerRemoval(previewToken);
  }

  public async changesSince(revision: ContextRevision): Promise<TimelineDiff> {
    return this.contexts.changesSince(revision);
  }

  public async contextChangesSince(revision: ContextRevision, waitMs = 0): Promise<ContextDiff> {
    return this.contexts.contextChangesSince(revision, waitMs);
  }

  public async analyzeSpeech(mediaId: string): Promise<SpeechAnalysis> {
    return this.media.analyzeSpeech(mediaId);
  }

  public async analyzeAudio(mediaId: string): Promise<AudioAnalysis> {
    return this.media.analyzeAudio(mediaId);
  }

  public async analyzeVisual(mediaId: string, range?: TimeRange): Promise<VisualAnalysis> {
    return this.media.analyzeVisual(mediaId, range);
  }

  public async understandMedia(mediaId: string): Promise<MediaUnderstanding> {
    return this.media.understandMedia(mediaId);
  }

  public async inspectMedia(mediaId: string): Promise<MediaContext> {
    return this.media.inspectMedia(mediaId);
  }

  public async searchMedia(query: string): Promise<MediaContext[]> {
    return this.media.searchMedia(query);
  }

  public async listAssets(query?: AssetSearchQuery): Promise<EditorAsset[]> {
    return this.projects.listAssets(query);
  }

  public getDiff(transactionId: string): TimelineDiff {
    return this.edits.getDiff(transactionId);
  }

  public getTransaction(transactionId: string): EditTransaction {
    return this.edits.getTransaction(transactionId);
  }

  public async verifyTransaction(transactionId: string): Promise<NonNullable<EditTransaction["verification"]>> {
    return this.edits.verifyTransaction(transactionId);
  }

  public async undo(transactionId: string): Promise<ProjectSnapshot> {
    return this.edits.undo(transactionId);
  }
}
