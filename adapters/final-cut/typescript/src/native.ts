import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";
import type { ContextRevision, EditorLiveState, RationalTime } from "@framekit/runtime";

const execFile = promisify(execFileCallback);

class NativeFinalCutPreflightError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly context?: NativeFinalCutContext,
  ) {
    super(`${code}: ${message}`);
    this.name = "NativeFinalCutPreflightError";
  }
}

export type NativeFinalCutEdit =
  | { type: "rename-selected-clip"; name: string }
  | { type: "trim-selected-clip-to-playhead"; edge: "start" | "end" }
  | { type: "set-selected-clip-gain"; gainDb: number }
  | { type: "add-marker-at-playhead"; name: string; duration?: number };

export interface NativeFinalCutMediaMatch {
  handle: string;
  name: string;
  role?: string;
  identity?: string;
  sourceIdentity?: string;
  source?: string;
  browserContext?: string;
  uiIndex?: number;
}

export interface NativeFinalCutMediaImportResult {
  mediaHandle: string;
  sourcePath: string;
  name: string;
  kind: "video" | "audio";
}

export interface NativeFinalCutOccurrence {
  handle: string;
  mediaHandle: string;
  name: string;
  start?: string;
  duration?: string;
  timelineOffset?: number;
  sourceIdentity?: string;
  role?: string;
  sequence?: string;
  sequenceId?: string;
  revision?: string;
  uiContext?: string;
}

export interface NativeFinalCutOccurrenceSearchResult {
  status: "none" | "unique" | "ambiguous";
  occurrences: NativeFinalCutOccurrence[];
}

export interface NativeFinalCutTargetResult {
  query: string;
  status: "unique";
  media: NativeFinalCutMediaMatch;
  occurrence: NativeFinalCutOccurrence;
  selected: boolean;
  playheadTime?: string;
}

export interface NativeFinalCutBladePreview {
  previewToken: string;
  occurrence: NativeFinalCutOccurrence;
  playheadTime?: string;
  command: "Blade at playhead";
  expiresAt: string;
}

export interface NativeFinalCutBladeResult {
  operationId: string;
  previewToken: string;
  occurrence: NativeFinalCutOccurrence;
  resultingSegments: NativeFinalCutOccurrence[];
  before: NativeFinalCutContext;
  after: NativeFinalCutContext;
  verification: {
    verified: boolean;
    detail: string;
  };
  undoAvailable: boolean;
  undoCommand?: string;
}

export type NativeFinalCutMediaInsertionOperation = "append" | "insert";

export interface NativeFinalCutMediaInsertionPreview {
  previewToken: string;
  operation: NativeFinalCutMediaInsertionOperation;
  media: NativeFinalCutMediaMatch;
  beforeDuration: RationalTime;
  insertionTime: RationalTime;
  sequenceId?: string;
  revision: string;
  command: "Append selected media" | "Insert selected media at playhead";
  expiresAt: string;
}

export interface NativeFinalCutMediaInsertionResult {
  operationId: string;
  previewToken: string;
  operation: NativeFinalCutMediaInsertionOperation;
  media: NativeFinalCutMediaMatch;
  before: NativeFinalCutContext;
  after: NativeFinalCutContext;
  beforeDuration: RationalTime;
  afterDuration: RationalTime;
  beforeRevision: ContextRevision;
  afterRevision: ContextRevision;
  verification: {
    verified: boolean;
    detail: string;
  };
  undoAvailable: boolean;
  undoCommand?: string;
}

export type NativeFinalCutRangeOperation = "delete-range" | "trim-to-duration";

export interface NativeFinalCutRange {
  start: RationalTime;
  end: RationalTime;
}

export interface NativeFinalCutRangePreview {
  previewToken: string;
  operation: NativeFinalCutRangeOperation;
  range: NativeFinalCutRange;
  beforeDuration: RationalTime;
  expectedAfterDuration: RationalTime;
  sequenceId?: string;
  revision?: string;
  command: "Delete primary storyline range" | "Trim sequence to duration";
  expiresAt: string;
}

export interface NativeFinalCutRangeResult {
  operationId: string;
  previewToken: string;
  operation: NativeFinalCutRangeOperation;
  range: NativeFinalCutRange;
  before: NativeFinalCutContext;
  after: NativeFinalCutContext;
  beforeDuration: RationalTime;
  afterDuration: RationalTime;
  expectedAfterDuration: RationalTime;
  verification: {
    verified: boolean;
    detail: string;
  };
  undoAvailable: boolean;
  undoCommand?: string;
}

export interface NativeFinalCutContext {
  available: boolean;
  application: "Final Cut Pro";
  frontmost: boolean;
  frontWindow?: string;
  timelineWindowAvailable: boolean;
  timelineFocused: boolean;
  focusTarget: "timeline" | "browser" | "text-field" | "modal" | "unknown" | "none";
  focusAttempts?: number;
  focusedName?: string;
  focusedRole?: string;
  focusedDescription?: string;
  focusedWindowName?: string;
  framekitWindowAvailable?: boolean;
  framekitWindowMinimized?: boolean;
  overlayBlocked?: boolean;
  project?: string;
  sequence?: string;
  playheadTime?: string;
  target: {
    kind: "selected-clip" | "browser-media" | "playhead" | "unknown" | "none";
    name?: string;
    role?: string;
    identity?: string;
  };
  bladeAvailable: boolean;
  undoAvailable: boolean;
  undoCommand?: string;
  error?: { code: string; message: string };
}

export interface NativeFinalCutCapabilities {
  selectionEdit: boolean;
  undo: boolean;
  mediaLibrarySearch: boolean;
  mediaImport: boolean;
  mediaSelection: boolean;
  mediaAppendSelected: boolean;
  timelineOccurrenceLocate: boolean;
  bladeAtPlayhead: boolean;
  deleteRange: boolean;
  trimToDuration: boolean;
  mediaAppend: boolean;
  mediaInsert: boolean;
  timelineFocus: boolean;
  requiresAccessibility: true;
  requiresFinalCutFrontmost: true;
}

export interface NativeFinalCutEditResult {
  operationId: string;
  operation: NativeFinalCutEdit;
  command: string;
  before: NativeFinalCutContext;
  after: NativeFinalCutContext;
  verification: {
    verified: boolean;
    level: "native-command-accepted" | "selection-observed";
    detail: string;
  };
  undoAvailable: boolean;
  undoCommand?: string;
}

export interface NativeFinalCutUndoResult {
  operationId: string;
  undone: boolean;
  context: NativeFinalCutContext;
  verification: {
    verified: boolean;
    detail: string;
  };
}

type NativeOperationKind = "selection" | "blade" | "range" | "media-insertion";
type NativeRetryValidator = (context: NativeFinalCutContext) => Promise<void> | void;

interface NativeOperationRecord {
  kind: NativeOperationKind;
  before: NativeFinalCutContext;
  after: NativeFinalCutContext;
  beforeLive?: EditorLiveState;
  afterLive?: EditorLiveState;
  beforeDuration?: RationalTime;
  undoCommand?: string;
}

export interface NativeFinalCutAutomationOptions {
  enabled?: boolean;
  executor?: NativeFinalCutExecutor;
  liveState?: () => Promise<EditorLiveState>;
  suspendLiveConnection?: () => void;
  resumeLiveConnection?: () => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  nativePreflightTimeoutMs?: number;
  mediaImportTimeoutMs?: number;
  mediaImportDiscoveryTimeoutMs?: number;
  mediaImportPollMs?: number;
}

export interface NativeFinalCutExecutorOptions {
  signal?: AbortSignal;
}

export type NativeFinalCutExecutor = (
  script: string,
  options?: NativeFinalCutExecutorOptions,
) => Promise<string>;

export interface NativeFinalCutEditor {
  capabilities(): NativeFinalCutCapabilities;
  inspect(): Promise<NativeFinalCutContext>;
  focusTimeline(): Promise<NativeFinalCutContext>;
  edit(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult>;
  undo(operationId: string): Promise<NativeFinalCutUndoResult>;
  importMedia(sourcePath: string): Promise<NativeFinalCutMediaImportResult>;
  searchMedia(query: string): Promise<NativeFinalCutMediaMatch[]>;
  selectMedia(handle: string): Promise<NativeFinalCutContext>;
  locateOccurrence(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult>;
  targetMedia(query: string): Promise<NativeFinalCutTargetResult>;
  previewBlade(occurrenceHandle: string): Promise<NativeFinalCutBladePreview>;
  executeBlade(previewToken: string): Promise<NativeFinalCutBladeResult>;
  previewDeleteRange(range: NativeFinalCutRange): Promise<NativeFinalCutRangePreview>;
  executeDeleteRange(previewToken: string): Promise<NativeFinalCutRangeResult>;
  previewTrimToDuration(duration: RationalTime): Promise<NativeFinalCutRangePreview>;
  executeTrimToDuration(previewToken: string): Promise<NativeFinalCutRangeResult>;
  previewAppendMedia(mediaHandle: string): Promise<NativeFinalCutMediaInsertionPreview>;
  executeAppendMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult>;
  previewAppendSelectedMedia(): Promise<NativeFinalCutMediaInsertionPreview>;
  executeAppendSelectedMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult>;
  previewInsertMedia(mediaHandle: string): Promise<NativeFinalCutMediaInsertionPreview>;
  executeInsertMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult>;
}

export class FinalCutNativeAutomationAdapter implements NativeFinalCutEditor {
  private readonly enabled: boolean;
  private readonly executor: NativeFinalCutExecutor;
  private readonly canDriveNativeMouse: boolean;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly suspendLiveConnection?: () => void;
  private readonly resumeLiveConnection?: () => void;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly nativePreflightTimeoutMs: number;
  private readonly mediaImportTimeoutMs: number;
  private readonly mediaImportDiscoveryTimeoutMs: number;
  private readonly mediaImportPollMs: number;
  private nativeUiDepth = 0;
  private readonly operations = new Map<string, NativeOperationRecord>();
  private latestOperationId?: string;
  private readonly mediaHandles = new Map<string, NativeFinalCutMediaMatch>();
  private selectedMediaHandle?: string;
  private readonly stableMediaHandles = new Map<string, string>();
  private readonly occurrenceHandles = new Map<string, NativeFinalCutOccurrence>();
  private readonly ambiguousMediaHandles = new Set<string>();
  private readonly bladePreviews = new Map<string, { occurrence: NativeFinalCutOccurrence; expiresAt: number }>();
  private readonly rangePreviews = new Map<string, {
    operation: NativeFinalCutRangeOperation;
    range: NativeFinalCutRange;
    beforeDuration: RationalTime;
    expectedAfterDuration: RationalTime;
    sequenceId?: string;
    revision?: string;
    expiresAt: number;
  }>();
  private readonly mediaInsertionPreviews = new Map<string, {
    operation: NativeFinalCutMediaInsertionOperation;
    mediaHandle: string;
    selectionMode: "handle" | "selected";
    beforeDuration: RationalTime;
    insertionTime: RationalTime;
    sequenceId?: string;
    revision: string;
    expiresAt: number;
  }>();

  public constructor(options: NativeFinalCutAutomationOptions = {}) {
    this.enabled = options.enabled ?? process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES === "1";
    this.executor = options.executor ?? runAppleScript;
    this.canDriveNativeMouse = options.executor === undefined;
    this.liveState = options.liveState;
    this.suspendLiveConnection = options.suspendLiveConnection;
    this.resumeLiveConnection = options.resumeLiveConnection;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.nativePreflightTimeoutMs = options.nativePreflightTimeoutMs ?? 10_000;
    this.mediaImportTimeoutMs = options.mediaImportTimeoutMs ?? 30_000;
    this.mediaImportDiscoveryTimeoutMs = options.mediaImportDiscoveryTimeoutMs ?? 30_000;
    this.mediaImportPollMs = options.mediaImportPollMs ?? 100;
  }

  public capabilities(): NativeFinalCutCapabilities {
    return {
      selectionEdit: this.enabled,
      undo: this.enabled,
      mediaLibrarySearch: this.enabled,
      mediaImport: this.enabled,
      mediaSelection: this.enabled,
      mediaAppendSelected: this.enabled,
      timelineOccurrenceLocate: this.enabled,
      bladeAtPlayhead: this.enabled,
      deleteRange: this.enabled,
      trimToDuration: this.enabled,
      mediaAppend: this.enabled,
      mediaInsert: this.enabled,
      timelineFocus: this.enabled,
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
    };
  }

  public async inspect(): Promise<NativeFinalCutContext> {
    return this.withNativeUi(() => this.inspectNative());
  }

  public async focusTimeline(): Promise<NativeFinalCutContext> {
    return this.withNativeUi(() => this.focusTimelineNative());
  }

  private async inspectNative(): Promise<NativeFinalCutContext> {
    if (!this.enabled) {
      return unavailableContext("CAPABILITY_UNAVAILABLE", "Final Cut native writes are disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    }
    try {
      return await this.attachLiveState(await this.ensureTimelineReady());
    } catch (error) {
      return unavailableContext(nativeErrorCode(error), nativeErrorMessage(error), preflightContext(error));
    }
  }

  private async focusTimelineNative(): Promise<NativeFinalCutContext> {
    if (!this.enabled) {
      return unavailableContext("CAPABILITY_UNAVAILABLE", "Final Cut native writes are disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    }
    try {
      return await this.attachLiveState(await this.ensureTimelineReady());
    } catch (error) {
      return unavailableContext(nativeErrorCode(error), nativeErrorMessage(error), preflightContext(error));
    }
  }

  private async inspectRawNative(deadline?: number): Promise<NativeFinalCutContext> {
    try {
      return await this.attachLiveState(parseContext(await this.executeNativeScript(inspectScript(), deadline)));
    } catch (error) {
      return unavailableContext(nativeErrorCode(error), nativeErrorMessage(error));
    }
  }

  private async attachLiveState(context: NativeFinalCutContext): Promise<NativeFinalCutContext> {
    if (!this.liveState) return context;
    try {
      const live = await this.liveState();
      context.project = live.project?.name;
      context.sequence = live.sequence?.name;
      context.playheadTime = live.playheadTime
        ? `${live.playheadTime.value}/${live.playheadTime.timescale}`
        : undefined;
    } catch {
      // Native UI inspection remains useful when the optional live socket is down.
    }
    return context;
  }

  private async readLiveState(): Promise<EditorLiveState | undefined> {
    if (!this.liveState) return undefined;
    try {
      return await this.liveState();
    } catch {
      return undefined;
    }
  }

  private rememberOperation(operationId: string, record: NativeOperationRecord): void {
    this.operations.set(operationId, record);
    this.latestOperationId = operationId;
  }

  public async edit(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult> {
    return this.withNativeUi(() => this.editNative(operation));
  }

  private async editNative(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult> {
    this.assertEnabled();
    const before = await this.requireTimelineTarget(operation);
    const beforeLive = await this.readLiveState();
    const operationId = `native-op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const command = commandName(operation);
    const requiresPlayhead = operation.type === "trim-selected-clip-to-playhead" || operation.type === "add-marker-at-playhead";
    try {
      await this.executeNativeCommand(editScript(operation), (recovered) => this.assertRetryContext(before, recovered, requiresPlayhead));
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireTimelineContext();
    const afterLive = await this.readLiveState();
    const verification = verifyNativeEdit(operation, before, after);
    if (!verification.verified) {
      throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${verification.detail}`);
    }
    this.rememberOperation(operationId, { kind: "selection", before, after, beforeLive, afterLive, undoCommand: after.undoCommand });
    return { operationId, operation, command, before, after, verification, undoAvailable: after.undoAvailable, ...(after.undoCommand ? { undoCommand: after.undoCommand } : {}) };
  }

  public async undo(operationId: string): Promise<NativeFinalCutUndoResult> {
    return this.withNativeUi(() => this.undoNative(operationId));
  }

  private async undoNative(operationId: string): Promise<NativeFinalCutUndoResult> {
    this.assertEnabled();
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`FINAL_CUT_NATIVE_UNDO_UNAVAILABLE: unknown operation ${operationId}`);
    if (this.latestOperationId !== operationId) throw new Error("FINAL_CUT_NATIVE_UNDO_STALE: operation is no longer the latest native edit");
    const before = await this.requireTimelineContext();
    const currentLive = await this.readLiveState();
    if (operation.afterLive && currentLive && operation.afterLive.revision.id !== currentLive.revision.id) {
      throw new Error("FINAL_CUT_NATIVE_UNDO_STALE: Final Cut timeline changed after the native edit");
    }
    if (!before.undoAvailable || !before.undoCommand) throw new Error("FINAL_CUT_NATIVE_UNDO_UNAVAILABLE: Final Cut has no available Undo command");
    if (!operation.undoCommand || before.undoCommand !== operation.undoCommand) {
      throw new Error("FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED: Final Cut's current Undo command does not match the native edit");
    }
    try {
      await this.executeNativeCommand(undoScript(operation.undoCommand), (recovered) => {
        this.assertRetryContext(before, recovered);
        if (!recovered.undoAvailable || recovered.undoCommand !== operation.undoCommand) {
          throw new Error("FINAL_CUT_NATIVE_UNDO_COMMAND_CHANGED: Final Cut's current Undo command does not match the native edit");
        }
      });
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireTimelineContext();
    const afterLive = await this.waitForUndo(operation);
    const verification = verifyNativeUndo(operation, after, afterLive);
    if (!verification.verified) throw new Error(`FINAL_CUT_NATIVE_UNDO_VERIFICATION_FAILED: ${verification.detail}`);
    this.operations.delete(operationId);
    this.latestOperationId = undefined;
    return { operationId, undone: true, context: after, verification };
  }

  public async importMedia(sourcePath: string): Promise<NativeFinalCutMediaImportResult> {
    return this.withNativeUi(() => this.importMediaNative(sourcePath));
  }

  private async importMediaNative(sourcePath: string): Promise<NativeFinalCutMediaImportResult> {
    this.assertEnabled();
    const normalizedPath = resolve(sourcePath.trim());
    const name = basename(normalizedPath);
    if (!name) throw new Error("INVALID_OPERATION: local media path cannot be empty");
    try {
      const details = await stat(normalizedPath);
      await access(normalizedPath, constants.R_OK);
      if (!details.isFile()) throw new Error("path is not a file");
    } catch (error) {
      throw new Error(`FINAL_CUT_NATIVE_MEDIA_PATH_UNAVAILABLE: ${normalizedPath} is not a readable local media file (${String(error)})`);
    }

    const beforeDiscoveryDeadline = this.now() + this.mediaImportDiscoveryTimeoutMs;
    await this.ensureBrowserReady(beforeDiscoveryDeadline, "FINAL_CUT_NATIVE_MEDIA_IMPORT_DISCOVERY_TIMEOUT");
    const beforeMatches = await this.searchMediaNative(name, beforeDiscoveryDeadline, "FINAL_CUT_NATIVE_MEDIA_IMPORT_DISCOVERY_TIMEOUT");
    const beforeIdentities = new Set(
      beforeMatches
        .filter((match) => match.name.toLowerCase() === name.toLowerCase())
        .map((match) => browserMediaIdentity(match))
        .filter((identity): identity is string => Boolean(identity)),
    );
    const hasIndistinguishablePreExistingMatch = beforeMatches.some(
      (match) => match.name.toLowerCase() === name.toLowerCase() && !browserMediaIdentity(match),
    );
    if (hasIndistinguishablePreExistingMatch) {
      throw new Error(`FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE: Final Cut did not expose an immutable Browser source identity for pre-existing ${name}`);
    }
    try {
      await this.executeNativeScript(importMediaScript(dirname(normalizedPath), name), this.now() + this.mediaImportTimeoutMs);
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }

    const discoveryDeadline = this.now() + this.mediaImportDiscoveryTimeoutMs;
    let sawPreExistingMatch = false;
    while (this.now() <= discoveryDeadline) {
      let matches: NativeFinalCutMediaMatch[];
      try {
        matches = await this.searchMediaNative(name, discoveryDeadline, "FINAL_CUT_NATIVE_MEDIA_IMPORT_DISCOVERY_TIMEOUT");
      } catch (error) {
        if (nativeErrorCode(error) === "FINAL_CUT_NATIVE_MEDIA_IMPORT_DISCOVERY_TIMEOUT") {
          throw new Error(`FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: Final Cut imported ${name}, but Browser Accessibility did not expose a stable media identity before the ${this.mediaImportDiscoveryTimeoutMs}ms discovery deadline`);
        }
        throw error;
      }
      const exactMatches = matches.filter((match) => match.name.toLowerCase() === name.toLowerCase());
      if (exactMatches.some((match) => !browserMediaIdentity(match))) {
        throw new Error(`FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE: Final Cut did not expose an immutable Browser source identity for ${name}`);
      }
      const newMatches = exactMatches.filter((match) => {
        const identity = browserMediaIdentity(match);
        if (!identity) return false;
        if (beforeIdentities.has(identity)) {
          sawPreExistingMatch = true;
          return false;
        }
        return true;
      });
      if (newMatches.length > 1) {
        throw new Error(`FINAL_CUT_NATIVE_MEDIA_IMPORT_AMBIGUOUS: Final Cut exposed multiple newly appearing Browser results for ${name}`);
      }
      const match = newMatches[0];
      if (match) {
        const identity = browserMediaIdentity(match);
        if (!identity) throw new Error(`FINAL_CUT_NATIVE_MEDIA_IMPORT_IDENTITY_UNAVAILABLE: Final Cut did not expose an immutable Browser source identity for ${name}`);
        const mediaHandle = this.stableMediaHandle(identity);
        const stableMatch = { ...match, handle: mediaHandle };
        this.stableMediaHandles.set(identity, mediaHandle);
        this.mediaHandles.set(mediaHandle, stableMatch);
        return {
          mediaHandle,
          sourcePath: normalizedPath,
          name,
          kind: mediaKind(normalizedPath),
        };
      }
      if (this.now() >= discoveryDeadline) break;
      await this.sleep(Math.min(this.mediaImportPollMs, discoveryDeadline - this.now()));
    }
    if (sawPreExistingMatch) {
      throw new Error(`FINAL_CUT_NATIVE_MEDIA_IMPORT_PRE_EXISTING: Final Cut exposed only pre-existing Browser results for ${name}`);
    }
    const diagnostics = await this.readBrowserMediaDiagnostics(name);
    throw new Error(`FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: Final Cut imported ${name}, but Browser Accessibility did not expose a stable media identity${diagnostics ? `; diagnostics=${diagnostics}` : ""}`);
  }

  public async searchMedia(query: string): Promise<NativeFinalCutMediaMatch[]> {
    return this.withNativeUi(() => this.searchMediaNative(query));
  }

  private async searchMediaNative(query: string, deadline?: number, timeoutCode = "FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT"): Promise<NativeFinalCutMediaMatch[]> {
    this.assertEnabled();
    if (!query.trim()) throw new Error("INVALID_OPERATION: media search query cannot be empty");
    const context = await this.ensureBrowserReady(deadline, timeoutCode);
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's Browser must be frontmost");
    try {
      const rawMatches = parseMediaMatches(await this.executeNativeScript(searchMediaScript(query), deadline, timeoutCode));
      const normalizedQuery = query.toLocaleLowerCase();
      if (rawMatches.some((match) => !browserMediaIdentity(match) && match.name.toLocaleLowerCase().includes(normalizedQuery))) {
        const diagnostics = await this.readBrowserMediaDiagnostics(query);
        throw new Error(`FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: matching Browser media has no AXIdentifier${diagnostics ? `; diagnostics=${diagnostics}` : ""}`);
      }
      const seenSourceIdentities = new Set<string>();
      const matches = rawMatches
        .filter((match) => {
          const identity = browserMediaIdentity(match);
          if (!identity || seenSourceIdentities.has(identity)) return false;
          seenSourceIdentities.add(identity);
          return true;
        })
        .map((match) => {
        const identity = browserMediaIdentity(match);
        if (!identity) return match;
        const stableHandle = this.stableMediaHandles.get(identity) ?? this.stableMediaHandle(identity);
        this.stableMediaHandles.set(identity, stableHandle);
        return { ...match, handle: stableHandle };
        });
      const stableHandles = new Set(this.stableMediaHandles.values());
      for (const handle of this.mediaHandles.keys()) {
        if (!stableHandles.has(handle)) this.mediaHandles.delete(handle);
      }
      this.selectedMediaHandle = undefined;
      for (const match of matches) this.mediaHandles.set(match.handle, match);
      return matches;
    } catch (error) {
      if (deadline !== undefined && nativeErrorCode(error) === timeoutCode) throw error;
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
  }

  private async readBrowserMediaDiagnostics(query: string): Promise<string> {
    try {
      const output = await this.executeNativeScript(browserMediaDiagnosticScript(query), this.now() + 2_000, "FINAL_CUT_NATIVE_MEDIA_DIAGNOSTIC_TIMEOUT");
      return output.trim().slice(0, 8_000);
    } catch {
      return "";
    }
  }

  public async previewAppendSelectedMedia(): Promise<NativeFinalCutMediaInsertionPreview> {
    return this.withNativeUi(() => this.previewSelectedMediaInsertionNative());
  }

  private async previewSelectedMediaInsertionNative(): Promise<NativeFinalCutMediaInsertionPreview> {
    this.assertEnabled();
    const media = await this.readSelectedMediaNative();
    const mediaHandle = this.stableMediaHandle(media.sourceIdentity!);
    const stableMedia = { ...media, handle: mediaHandle };
    this.stableMediaHandles.set(media.sourceIdentity!, mediaHandle);
    this.mediaHandles.set(mediaHandle, stableMedia);
    this.selectedMediaHandle = mediaHandle;
    return this.previewMediaInsertionNative("append", mediaHandle, "selected");
  }

  private async readSelectedMediaNative(): Promise<NativeFinalCutMediaMatch> {
    const context = await this.ensureBrowserReady();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's Browser must be frontmost");
    try {
      const matches = parseMediaMatches(await this.executor(selectedBrowserMediaScript()));
      if (matches.length === 0) throw new Error("FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: no selected Browser media was exposed by Accessibility");
      if (matches.length > 1) throw new Error("FINAL_CUT_NATIVE_AMBIGUOUS_TARGET: multiple selected Browser media items were exposed");
      const media = matches[0]!;
      if (!media.sourceIdentity) {
        const diagnostics = await this.readBrowserMediaDiagnostics(media.name);
        throw new Error(`FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: selected Browser media has no AXIdentifier${diagnostics ? `; diagnostics=${diagnostics}` : ""}`);
      }
      return media;
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
  }

  public async selectMedia(handle: string): Promise<NativeFinalCutContext> {
    return this.withNativeUi(() => this.selectMediaNative(handle));
  }

  private async selectMediaNative(handle: string): Promise<NativeFinalCutContext> {
    this.assertEnabled();
    const match = this.mediaHandles.get(handle);
    if (!match) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${handle}`);
    const before = await this.ensureBrowserReady();
    if (!before.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's Browser must be frontmost");
    try {
      await this.executor(selectMediaScript(match));
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    this.selectedMediaHandle = handle;
    return {
      ...after,
      target: { kind: "browser-media", name: match.name, ...(match.role ? { role: match.role } : {}) },
    };
  }

  public async locateOccurrence(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult> {
    return this.withNativeUi(() => this.locateOccurrenceNative(mediaHandle));
  }

  public async targetMedia(query: string): Promise<NativeFinalCutTargetResult> {
    return this.withNativeUi(() => this.targetMediaNative(query));
  }

  private async targetMediaNative(query: string): Promise<NativeFinalCutTargetResult> {
    this.assertEnabled();
    const matches = await this.searchMediaNative(query);
    if (matches.length === 0) throw new Error("FINAL_CUT_NATIVE_MEDIA_NOT_FOUND: no Browser media matched the query");
    if (matches.length > 1) throw new Error("FINAL_CUT_NATIVE_AMBIGUOUS_TARGET: media query matched multiple Browser items");

    const media = matches[0]!;
    await this.selectMediaNative(media.handle);
    const located = await this.locateOccurrenceNative(media.handle, true);
    if (located.status === "none") {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_NOT_FOUND: selected Browser media has no timeline occurrence");
    }
    if (located.status === "ambiguous") {
      throw new Error("FINAL_CUT_NATIVE_AMBIGUOUS_TARGET: media has multiple timeline occurrences");
    }
    if (located.occurrences[0]?.timelineOffset === undefined) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_POSITION_UNAVAILABLE: unique timeline occurrence has no selectable position");
    }

    const live = await this.readLiveState();
    if (!live?.playheadTime) {
      throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_UNAVAILABLE: deterministic targeting requires live playhead state");
    }
    return {
      query,
      status: "unique",
      media,
      occurrence: located.occurrences[0]!,
      selected: true,
      playheadTime: `${live.playheadTime.value}/${live.playheadTime.timescale}`,
    };
  }

  private async locateOccurrenceNative(mediaHandle: string, scanAll = false): Promise<NativeFinalCutOccurrenceSearchResult> {
    this.assertEnabled();
    const match = this.mediaHandles.get(mediaHandle);
    if (!match) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${mediaHandle}`);
    if (!match.sourceIdentity) throw new Error("FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: Browser result has no shared source-media identifier");
    const context = await this.requireTimelineContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    try {
      const occurrences = parseOccurrences(await this.executor(locateOccurrenceScript(match, scanAll)), mediaHandle);
      if (occurrences.length === 1 && this.canDriveNativeMouse) {
        const timelineOffset = occurrences[0]?.timelineOffset;
        if (timelineOffset === undefined) {
          throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_POSITION_UNAVAILABLE: unique timeline occurrence has no selectable position");
        }
        await selectTimelineOccurrence(this.executor, timelineOffset);
      }
      const live = this.liveState ? await this.liveState().catch(() => undefined) : undefined;
      for (const occurrence of occurrences) {
        occurrence.sequence = live?.sequence?.name;
        occurrence.sequenceId = live?.sequence?.id;
        occurrence.revision = live?.revision.id;
        occurrence.uiContext = context.frontWindow;
      }
      this.occurrenceHandles.clear();
      this.ambiguousMediaHandles.clear();
      for (const occurrence of occurrences) this.occurrenceHandles.set(occurrence.handle, occurrence);
      if (occurrences.length !== 1) this.ambiguousMediaHandles.add(mediaHandle);
      return {
        status: occurrences.length === 0 ? "none" : occurrences.length === 1 ? "unique" : "ambiguous",
        occurrences,
      };
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
  }

  public async previewBlade(occurrenceHandle: string): Promise<NativeFinalCutBladePreview> {
    return this.withNativeUi(() => this.previewBladeNative(occurrenceHandle));
  }

  private async previewBladeNative(occurrenceHandle: string): Promise<NativeFinalCutBladePreview> {
    this.assertEnabled();
    const occurrence = this.occurrenceHandles.get(occurrenceHandle);
    if (!occurrence) throw new Error(`FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: unknown occurrence handle ${occurrenceHandle}`);
    if (this.ambiguousMediaHandles.has(occurrence.mediaHandle)) {
      throw new Error("FINAL_CUT_NATIVE_AMBIGUOUS_OCCURRENCE: automatic Blade requires exactly one timeline occurrence");
    }
    const context = await this.requireTimelineContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    if (context.target.kind !== "selected-clip") throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: select exactly one timeline occurrence");
    if (context.target.name && context.target.name !== occurrence.name) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: selected timeline occurrence changed");
    }
    await this.validateOccurrenceBinding(occurrence);
    if (!context.bladeAvailable) throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_OUTSIDE_OCCURRENCE: Final Cut has disabled Blade for the current selection/playhead");
    const expiresAtMs = this.now() + 30_000;
    const previewToken = opaqueHandle("blade-preview");
    this.bladePreviews.set(previewToken, { occurrence, expiresAt: expiresAtMs });
    return {
      previewToken,
      occurrence,
      ...(context.playheadTime ? { playheadTime: context.playheadTime } : {}),
      command: "Blade at playhead",
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  public async executeBlade(previewToken: string): Promise<NativeFinalCutBladeResult> {
    return this.withNativeUi(() => this.executeBladeNative(previewToken));
  }

  private async executeBladeNative(previewToken: string): Promise<NativeFinalCutBladeResult> {
    this.assertEnabled();
    const preview = this.bladePreviews.get(previewToken);
    if (!preview) throw new Error(`FINAL_CUT_NATIVE_PREVIEW_STALE: unknown Blade preview ${previewToken}`);
    this.bladePreviews.delete(previewToken);
    if (this.now() > preview.expiresAt) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: Blade preview has expired");
    const before = await this.requireTimelineContext();
    if (!before.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    if (before.target.kind !== "selected-clip") throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: select exactly one timeline occurrence");
    if (before.target.name && before.target.name !== preview.occurrence.name) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: selected timeline occurrence changed");
    }
    await this.validateOccurrenceBinding(preview.occurrence);
    if (!before.bladeAvailable) throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_OUTSIDE_OCCURRENCE: Final Cut has disabled Blade for the current selection/playhead");
    try {
      await this.executeNativeCommand(bladeScript(), async (recovered) => {
        this.assertRetryContext(before, recovered, true);
        await this.validateOccurrenceBinding(preview.occurrence);
        if (!recovered.bladeAvailable) throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_OUTSIDE_OCCURRENCE: Final Cut has disabled Blade for the current selection/playhead");
      });
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireTimelineContext();
    if (!after.frontmost) throw new Error("FINAL_CUT_NATIVE_VERIFICATION_FAILED: Final Cut changed focus during Blade");
    const resultingSegments = parseOccurrences(
      await this.executor(locateOccurrenceScript({ handle: preview.occurrence.mediaHandle, name: preview.occurrence.name }, true)),
      preview.occurrence.mediaHandle,
    );
    if (resultingSegments.length < 2) {
      throw new Error("FINAL_CUT_NATIVE_VERIFICATION_FAILED: Final Cut did not expose two resulting timeline segments after Blade");
    }
    const operationId = opaqueHandle("native-blade");
    const afterLive = await this.readLiveState();
    this.rememberOperation(operationId, { kind: "blade", before, after, beforeLive: undefined, afterLive, undoCommand: after.undoCommand });
    return {
      operationId,
      previewToken,
      occurrence: preview.occurrence,
      resultingSegments,
      before,
      after,
      verification: { verified: true, detail: "Final Cut accepted the Blade command while the target remained frontmost" },
      undoAvailable: after.undoAvailable,
      ...(after.undoCommand ? { undoCommand: after.undoCommand } : {}),
    };
  }

  public async previewDeleteRange(range: NativeFinalCutRange): Promise<NativeFinalCutRangePreview> {
    return this.withNativeUi(() => this.previewRangeNative("delete-range", range));
  }

  public async executeDeleteRange(previewToken: string): Promise<NativeFinalCutRangeResult> {
    return this.withNativeUi(() => this.executeRangeNative(previewToken));
  }

  public async previewTrimToDuration(duration: RationalTime): Promise<NativeFinalCutRangePreview> {
    return this.withNativeUi(async () => {
      this.assertEnabled();
      const live = await this.requireLiveState();
      const context = await this.requireTimelineContext();
      if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline window must be frontmost");
      const sequenceStart = live.sequenceTimeRange?.start ?? live.sequence?.startTime;
      const currentDuration = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
      if (!sequenceStart || !currentDuration) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut sequence duration is unavailable");
      if (compareRational(duration, zeroRational()) <= 0) throw new Error("INVALID_OPERATION: target duration must be positive");
      if (compareRational(duration, currentDuration) >= 0) {
        const token = this.createRangePreview("trim-to-duration", { start: sequenceStart, end: sequenceStart }, currentDuration, currentDuration, live);
        return { ...token, command: "Trim sequence to duration" };
      }
      const range = { start: addRational(sequenceStart, duration), end: addRational(sequenceStart, currentDuration) };
      return this.createRangePreview("trim-to-duration", range, currentDuration, duration, live, duration);
    });
  }

  public async executeTrimToDuration(previewToken: string): Promise<NativeFinalCutRangeResult> {
    return this.withNativeUi(() => this.executeRangeNative(previewToken, "trim-to-duration"));
  }

  public async previewAppendMedia(mediaHandle: string): Promise<NativeFinalCutMediaInsertionPreview> {
    return this.withNativeUi(() => this.previewMediaInsertionNative("append", mediaHandle));
  }

  public async executeAppendMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult> {
    return this.withNativeUi(() => this.executeMediaInsertionNative(previewToken, "append", "handle"));
  }

  public async executeAppendSelectedMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult> {
    return this.withNativeUi(() => this.executeMediaInsertionNative(previewToken, "append", "selected"));
  }

  public async previewInsertMedia(mediaHandle: string): Promise<NativeFinalCutMediaInsertionPreview> {
    return this.withNativeUi(() => this.previewMediaInsertionNative("insert", mediaHandle));
  }

  public async executeInsertMedia(previewToken: string): Promise<NativeFinalCutMediaInsertionResult> {
    return this.withNativeUi(() => this.executeMediaInsertionNative(previewToken, "insert"));
  }

  private async previewMediaInsertionNative(
    operation: NativeFinalCutMediaInsertionOperation,
    mediaHandle: string,
    selectionMode: "handle" | "selected" = "handle",
  ): Promise<NativeFinalCutMediaInsertionPreview> {
    this.assertEnabled();
    const media = this.mediaHandles.get(mediaHandle);
    if (!media) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${mediaHandle}`);
    if (this.selectedMediaHandle !== mediaHandle) {
      throw new Error("FINAL_CUT_NATIVE_MEDIA_SELECTION_REQUIRED: select one Browser media result before insertion");
    }
    const context = await this.requireTimelineContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    const live = await this.requireLiveState();
    const sequenceStart = live.sequenceTimeRange?.start ?? live.sequence?.startTime;
    const beforeDuration = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
    if (!sequenceStart || !beforeDuration) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut sequence duration is unavailable");
    const insertionTime = operation === "append"
      ? addRational(sequenceStart, beforeDuration)
      : live.playheadTime;
    if (!insertionTime) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut playhead is unavailable for media insertion");
    const expiresAt = this.now() + 30_000;
    const previewToken = opaqueHandle(`${operation}-media-preview`);
    this.mediaInsertionPreviews.set(previewToken, {
      operation,
      mediaHandle,
      selectionMode,
      beforeDuration,
      insertionTime,
      sequenceId: live.sequence?.id,
      revision: live.revision.id,
      expiresAt,
    });
    return {
      previewToken,
      operation,
      media,
      beforeDuration,
      insertionTime,
      ...(live.sequence?.id ? { sequenceId: live.sequence.id } : {}),
      revision: live.revision.id,
      command: operation === "append" ? "Append selected media" : "Insert selected media at playhead",
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async executeMediaInsertionNative(
    previewToken: string,
    expectedOperation?: NativeFinalCutMediaInsertionOperation,
    expectedSelectionMode?: "handle" | "selected",
  ): Promise<NativeFinalCutMediaInsertionResult> {
    this.assertEnabled();
    const preview = this.mediaInsertionPreviews.get(previewToken);
    if (!preview) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: unknown media insertion preview");
    this.mediaInsertionPreviews.delete(previewToken);
    if (this.now() > preview.expiresAt) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: media insertion preview has expired");
    if (expectedOperation && preview.operation !== expectedOperation) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: preview operation does not match execute operation");
    if (expectedSelectionMode && preview.selectionMode !== expectedSelectionMode) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: preview selection mode does not match execute operation");
    const media = this.mediaHandles.get(preview.mediaHandle);
    if (!media) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${preview.mediaHandle}`);
    if (preview.selectionMode === "handle" && this.selectedMediaHandle !== preview.mediaHandle) {
      throw new Error("FINAL_CUT_NATIVE_MEDIA_SELECTION_REQUIRED: selected Browser media changed before insertion");
    }
    const before = await this.requireTimelineContext();
    const beforeLive = await this.requireLiveState();
    this.validateMediaInsertionBinding(preview, beforeLive);
    if (preview.selectionMode === "selected") await this.validateSelectedMediaBinding(media);
    try {
      // Re-select by the stable Browser identity immediately before the edit. The
      // cached handle only proves what this process selected, not what Final Cut
      // currently has selected after another UI interaction.
      if (preview.selectionMode === "handle") await this.selectMediaNative(preview.mediaHandle);
      await this.focusTimelineForMediaInsertion();
      await this.executeNativeCommand(mediaInsertionScript(preview.operation), async (recovered) => {
        this.assertRetryContext(before, recovered, preview.operation === "insert");
        if (preview.selectionMode === "handle") await this.selectMediaNative(preview.mediaHandle);
        const refocused = await this.prepareNativeRetry();
        this.assertRetryContext(before, refocused, preview.operation === "insert");
        await this.focusTimelineForMediaInsertion();
        this.validateMediaInsertionBinding(preview, await this.requireLiveState());
        if (preview.selectionMode === "selected") await this.validateSelectedMediaBinding(media);
      });
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const operationId = opaqueHandle(`native-${preview.operation}-media`);
    let after: NativeFinalCutContext | undefined;
    let afterLive: EditorLiveState | undefined;
    try {
      after = await this.requireTimelineContext();
      afterLive = await this.waitForMediaInsertion(preview.beforeDuration, beforeLive.revision.id);
    } catch (error) {
      const observedContext = after ?? await this.inspectRawNative();
      const observedLive = afterLive ?? await this.readLiveState();
      if (observedLive && mediaInsertionMutationObserved(beforeLive, observedLive) && observedContext.undoCommand) {
        this.rememberOperation(operationId, {
          kind: "media-insertion",
          before,
          after: observedContext,
          beforeLive,
          afterLive: observedLive,
          beforeDuration: preview.beforeDuration,
          undoCommand: observedContext.undoCommand,
        });
        try {
          await this.undo(operationId);
        } catch (rollbackError) {
          throw new Error(`${nativeErrorCode(error)}: ${String(error)}; operationId=${operationId}; native rollback failed: ${String(rollbackError)}`);
        }
        throw new Error(`${nativeErrorCode(error)}: ${String(error)}; insertion was rolled back`);
      }
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}; post-command state was not safely recoverable, so no Undo handle was retained`);
    }
    const afterDuration = afterLive.sequenceTimeRange?.duration ?? afterLive.sequence?.duration;
    const verification = mediaInsertionVerificationDetail(afterDuration, preview.beforeDuration, afterLive.revision.id, beforeLive.revision.id);
    const operation = {
      kind: "media-insertion",
      before,
      after,
      beforeLive,
      afterLive,
      beforeDuration: preview.beforeDuration,
      undoCommand: after.undoCommand,
    } satisfies NativeOperationRecord;
    if (!verification.verified) {
      if (mediaInsertionMutationObserved(beforeLive, afterLive) && after.undoAvailable && after.undoCommand) {
        this.rememberOperation(operationId, operation);
        try {
          await this.undo(operationId);
        } catch (rollbackError) {
          throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${verification.detail}; operationId=${operationId}; native rollback failed: ${String(rollbackError)}`);
        }
        throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${verification.detail}; insertion was rolled back`);
      }
      throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${verification.detail}`);
    }
    this.rememberOperation(operationId, operation);
    return {
      operationId,
      previewToken,
      operation: preview.operation,
      media,
      before,
      after,
      beforeDuration: preview.beforeDuration,
      afterDuration: afterDuration!,
      beforeRevision: beforeLive.revision,
      afterRevision: afterLive.revision,
      verification,
      undoAvailable: after.undoAvailable,
      ...(after.undoCommand ? { undoCommand: after.undoCommand } : {}),
    };
  }

  private async focusTimelineForMediaInsertion(): Promise<void> {
    if (!this.canDriveNativeMouse) return;
    const coordinates = (await this.executor(timelineInsertionCoordinatesScript())).split("|").map(Number);
    const [originX, originY, width, height] = coordinates;
    if (![originX, originY, width, height].every(Number.isFinite)) {
      throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: could not resolve Final Cut timeline coordinates");
    }
    const x = Math.round(originX + width * 0.5);
    const y = Math.round(originY + height * 0.82);
    try {
      await execFile("swift", ["-e", nativeMouseFocusSource(x, y)]);
    } catch (error) {
      throw new Error(`FINAL_CUT_NATIVE_AUTOMATION_FAILED: native timeline focus failed: ${String(error)}`);
    }
  }

  private async validateSelectedMediaBinding(media: NativeFinalCutMediaMatch): Promise<void> {
    const selected = await this.readSelectedMediaNative();
    if (selected.sourceIdentity !== media.sourceIdentity) {
      throw new Error("FINAL_CUT_NATIVE_MEDIA_SELECTION_CHANGED: selected Browser media changed before insertion");
    }
  }

  private async previewRangeNative(operation: NativeFinalCutRangeOperation, range: NativeFinalCutRange): Promise<NativeFinalCutRangePreview> {
    this.assertEnabled();
    const context = await this.requireTimelineContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline window must be frontmost");
    const live = await this.requireLiveState();
    const sequenceStart = live.sequenceTimeRange?.start ?? live.sequence?.startTime;
    const currentDuration = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
    if (!sequenceStart || !currentDuration) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut sequence duration is unavailable");
    const duration = subtractRational(range.end, range.start);
    if (compareRational(duration, zeroRational()) <= 0) throw new Error("INVALID_OPERATION: delete range must have start before end");
    if (compareRational(range.start, sequenceStart) < 0 || compareRational(range.end, addRational(sequenceStart, currentDuration)) > 0) {
      throw new Error("FINAL_CUT_NATIVE_RANGE_OUT_OF_BOUNDS: delete range must be inside the active sequence");
    }
    const expectedAfterDuration = subtractRational(currentDuration, duration);
    return this.createRangePreview(operation, range, currentDuration, expectedAfterDuration, live);
  }

  private createRangePreview(
    operation: NativeFinalCutRangeOperation,
    range: NativeFinalCutRange,
    beforeDuration: RationalTime,
    expectedAfterDuration: RationalTime,
    live: EditorLiveState,
    targetDuration?: RationalTime,
  ): NativeFinalCutRangePreview {
    const expiresAt = this.now() + 30_000;
    const previewToken = opaqueHandle(`${operation}-preview`);
    this.rangePreviews.set(previewToken, {
      operation,
      range,
      beforeDuration,
      expectedAfterDuration,
      sequenceId: live.sequence?.id,
      revision: live.revision.id,
      expiresAt,
    });
    return {
      previewToken,
      operation,
      range,
      beforeDuration,
      expectedAfterDuration: targetDuration ?? expectedAfterDuration,
      ...(live.sequence?.id ? { sequenceId: live.sequence.id } : {}),
      revision: live.revision.id,
      command: operation === "delete-range" ? "Delete primary storyline range" : "Trim sequence to duration",
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private async executeRangeNative(previewToken: string, expectedOperation?: NativeFinalCutRangeOperation): Promise<NativeFinalCutRangeResult> {
    this.assertEnabled();
    const preview = this.rangePreviews.get(previewToken);
    if (!preview) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: unknown range preview");
    this.rangePreviews.delete(previewToken);
    if (this.now() > preview.expiresAt) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: range preview has expired");
    if (expectedOperation && preview.operation !== expectedOperation) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: preview operation does not match execute operation");
    const before = await this.requireTimelineContext();
    const beforeLive = await this.requireLiveState();
    this.validateRangeBinding(preview, beforeLive);
    const rangeDuration = subtractRational(preview.range.end, preview.range.start);
    if (compareRational(rangeDuration, zeroRational()) === 0) {
      return {
        operationId: opaqueHandle("native-noop"),
        previewToken,
        operation: preview.operation,
        range: preview.range,
        before,
        after: before,
        beforeDuration: preview.beforeDuration,
        afterDuration: preview.beforeDuration,
        expectedAfterDuration: preview.expectedAfterDuration,
        verification: { verified: true, detail: "Requested duration is already at or below the active sequence duration" },
        undoAvailable: false,
      };
    }
    try {
      await this.positionAndDeleteRange(preview.range, beforeLive, async () => {
        this.validateRangeBinding(preview, await this.requireLiveState());
      });
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireTimelineContext();
    const afterLive = await this.waitForDuration(preview.expectedAfterDuration, beforeLive.revision.id);
    const detail = durationVerificationDetail(
      afterLive.sequenceTimeRange?.duration ?? afterLive.sequence?.duration,
      preview.expectedAfterDuration,
      afterLive.sequence?.frameDuration ?? beforeLive.sequence?.frameDuration,
    );
    if (!detail.verified) throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${detail.detail}`);
    const operationId = opaqueHandle(`native-${preview.operation}`);
    this.rememberOperation(operationId, {
      kind: "range",
      before,
      after,
      beforeLive,
      afterLive,
      beforeDuration: preview.beforeDuration,
      undoCommand: after.undoCommand,
    });
    return {
      operationId,
      previewToken,
      operation: preview.operation,
      range: preview.range,
      before,
      after,
      beforeDuration: preview.beforeDuration,
      afterDuration: afterLive.sequenceTimeRange?.duration ?? afterLive.sequence?.duration ?? preview.expectedAfterDuration,
      expectedAfterDuration: preview.expectedAfterDuration,
      verification: { verified: true, detail: detail.detail },
      undoAvailable: after.undoAvailable,
      ...(after.undoCommand ? { undoCommand: after.undoCommand } : {}),
    };
  }

  private validateRangeBinding(preview: { sequenceId?: string; revision?: string; beforeDuration: RationalTime }, live: EditorLiveState): void {
    if (preview.sequenceId && live.sequence?.id !== preview.sequenceId) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: active sequence changed");
    if (preview.revision && live.revision.id !== preview.revision) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: playhead or timeline revision changed");
    const currentDuration = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
    if (!currentDuration || compareRational(currentDuration, preview.beforeDuration) !== 0) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: sequence duration changed");
  }

  private async requireLiveState(): Promise<EditorLiveState> {
    if (!this.liveState) throw new Error("CAPABILITY_UNAVAILABLE: live Final Cut state is required for range operations");
    return this.liveState();
  }

  private validateMediaInsertionBinding(
    preview: { sequenceId?: string; revision: string; beforeDuration: RationalTime; insertionTime: RationalTime; operation: NativeFinalCutMediaInsertionOperation },
    live: EditorLiveState,
  ): void {
    if (preview.sequenceId && live.sequence?.id !== preview.sequenceId) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: active sequence changed");
    if (live.revision.id !== preview.revision) throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: playhead or timeline revision changed");
    const currentDuration = live.sequenceTimeRange?.duration ?? live.sequence?.duration;
    if (!currentDuration || compareRational(currentDuration, preview.beforeDuration) !== 0) {
      throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: sequence duration changed");
    }
    if (preview.operation === "insert" && (!live.playheadTime || compareRational(live.playheadTime, preview.insertionTime) !== 0)) {
      throw new Error("FINAL_CUT_NATIVE_PREVIEW_STALE: playhead changed");
    }
  }

  private async waitForMediaInsertion(expectedBeforeDuration: RationalTime, previousRevision: string): Promise<EditorLiveState> {
    const deadline = this.now() + 5_000;
    let latest = await this.requireLiveState();
    while (this.now() < deadline) {
      const duration = latest.sequenceTimeRange?.duration ?? latest.sequence?.duration;
      if (duration && compareRational(duration, expectedBeforeDuration) > 0 && latest.revision.id !== previousRevision) return latest;
      await this.sleep(100);
      latest = await this.requireLiveState();
    }
    return latest;
  }

  private async waitForDuration(expected: RationalTime, previousRevision: string): Promise<EditorLiveState> {
    const deadline = this.now() + 5_000;
    let latest = await this.requireLiveState();
    while (this.now() < deadline) {
      const duration = latest.sequenceTimeRange?.duration ?? latest.sequence?.duration;
      if (duration && durationVerificationDetail(duration, expected, latest.sequence?.frameDuration).verified && latest.revision.id !== previousRevision) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
      latest = await this.requireLiveState();
    }
    return latest;
  }

  private async waitForUndo(operation: NativeOperationRecord): Promise<EditorLiveState | undefined> {
    if (!operation.afterLive || !this.liveState) return undefined;
    const deadline = this.now() + 5_000;
    let latest = await this.requireLiveState();
    while (this.now() < deadline) {
      const duration = latest.sequenceTimeRange?.duration ?? latest.sequence?.duration;
      const durationRestored = operation.beforeDuration
        ? Boolean(duration && compareRational(duration, operation.beforeDuration) === 0)
        : true;
      if (latest.revision.id !== operation.afterLive.revision.id && durationRestored) return latest;
      await this.sleep(100);
      latest = await this.requireLiveState();
    }
    return latest;
  }

  private async positionAndDeleteRange(
    range: NativeFinalCutRange,
    beforeLive: EditorLiveState,
    validateRetry: NativeRetryValidator,
  ): Promise<void> {
    const startTimecode = this.toTimecode(range.start, beforeLive);
    const endTimecode = this.toTimecode(range.end, beforeLive);
    const executeRange = async (): Promise<void> => {
      await this.executor(setPlayheadScript(startTimecode));
      await this.waitForPlayhead(range.start, beforeLive.sequence?.id);
      await this.executor(markRangeStartScript());
      await this.executor(setPlayheadScript(endTimecode));
      await this.waitForPlayhead(range.end, beforeLive.sequence?.id);
      await this.executor(markRangeEndAndDeleteScript());
    };
    await this.executeNativeSequence(executeRange, validateRetry);
  }

  private async executeNativeCommand(script: string, validateRetry?: NativeRetryValidator): Promise<void> {
    try {
      await this.executor(script);
    } catch (error) {
      if (!isRecoverableNativeFocusRace(error)) throw error;
      await validateRetry?.(await this.prepareNativeRetry());
      await this.executor(script);
    }
  }

  private async executeNativeSequence(execute: () => Promise<void>, validateRetry: NativeRetryValidator): Promise<void> {
    try {
      await execute();
    } catch (error) {
      if (!isRecoverableNativeFocusRace(error)) throw error;
      await validateRetry(await this.prepareNativeRetry());
      await execute();
    }
  }

  private async prepareNativeRetry(): Promise<NativeFinalCutContext> {
    return this.attachLiveState(await this.ensureTimelineReady());
  }

  private assertRetryContext(expected: NativeFinalCutContext, recovered: NativeFinalCutContext, requirePlayhead = false): void {
    const targetChanged = expected.target.kind !== recovered.target.kind
      || expected.target.name !== recovered.target.name
      || expected.target.role !== recovered.target.role;
    const occurrenceChanged = expected.target.kind === "selected-clip" && recovered.target.kind === "selected-clip"
      && (!expected.target.identity || !recovered.target.identity || expected.target.identity !== recovered.target.identity);
    const playheadChanged = requirePlayhead
      ? !expected.playheadTime || !recovered.playheadTime || expected.playheadTime !== recovered.playheadTime
      : expected.playheadTime !== recovered.playheadTime;
    if (targetChanged || occurrenceChanged || playheadChanged) {
      throw new Error("FINAL_CUT_NATIVE_RETRY_TARGET_CHANGED: Final Cut selection or playhead changed during focus recovery");
    }
  }

  private async waitForPlayhead(expected: RationalTime, sequenceId?: string): Promise<EditorLiveState> {
    const deadline = this.now() + 5_000;
    let latest = await this.requireLiveState();
    while (this.now() < deadline) {
      if ((!sequenceId || latest.sequence?.id === sequenceId) && latest.playheadTime && compareRational(latest.playheadTime, expected) === 0) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
      latest = await this.requireLiveState();
    }
    throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_VERIFICATION_FAILED: Final Cut did not move to the requested frame");
  }

  private toTimecode(time: RationalTime, live: EditorLiveState): string {
    const sequence = live.sequence;
    if (!sequence) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut sequence frame rate is unavailable");
    const relative = subtractRational(time, sequence.startTime);
    const frames = divideRationalFloor(relative, sequence.frameDuration);
    const nominalFps = Math.max(1, Math.round(Number(sequence.frameDuration.timescale) / Number(sequence.frameDuration.value)));
    return formatTimecode(frames, nominalFps);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are disabled");
  }

  private async withNativeUi<T>(operation: () => Promise<T>): Promise<T> {
    const outermost = this.nativeUiDepth === 0;
    if (outermost && this.enabled) this.suspendLiveConnection?.();
    this.nativeUiDepth += 1;
    try {
      return await operation();
    } finally {
      this.nativeUiDepth -= 1;
      if (outermost && this.enabled) this.resumeLiveConnection?.();
    }
  }

  private async validateOccurrenceBinding(occurrence: NativeFinalCutOccurrence): Promise<void> {
    if (!this.liveState || !occurrence.revision) return;
    const live = await this.liveState().catch(() => undefined);
    if (!live) return;
    if (occurrence.sequenceId && live.sequence?.id !== occurrence.sequenceId) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: active sequence changed");
    }
    if (live.revision.id !== occurrence.revision) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: playhead or timeline revision changed");
    }
    if (occurrence.start && occurrence.duration && live.playheadTime) {
      const start = parseRationalNumber(occurrence.start);
      const duration = parseRationalNumber(occurrence.duration);
      const playhead = Number(live.playheadTime.value) / Number(live.playheadTime.timescale);
      if (start !== undefined && duration !== undefined && (playhead < start || playhead >= start + duration)) {
        throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_OUTSIDE_OCCURRENCE: playhead is outside the target occurrence");
      }
    }
  }

  private async requireTimelineTarget(operation: NativeFinalCutEdit): Promise<NativeFinalCutContext> {
    const context = await this.requireTimelineContext();
    if (requiresClip(operation) && context.target.kind !== "selected-clip") {
      throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: select exactly one clip in Final Cut Pro");
    }
    if (!requiresClip(operation) && context.target.kind === "none") {
      throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: position the playhead in Final Cut Pro");
    }
    return context;
  }

  private async requireTimelineContext(): Promise<NativeFinalCutContext> {
    const context = await this.attachLiveState(await this.ensureTimelineReady());
    if (!context.available) {
      throw new Error(`${context.error?.code ?? "FINAL_CUT_NATIVE_UNAVAILABLE"}: ${context.error?.message ?? "native timeline context unavailable"}`);
    }
    return context;
  }

  private async ensureTimelineReady(): Promise<NativeFinalCutContext> {
    const deadline = this.now() + this.nativePreflightTimeoutMs;
    let lastCode = "FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW";
    let lastMessage = "Final Cut has no accessible timeline window; open a project timeline and retry";
    let lastContext: NativeFinalCutContext | undefined;

    while (this.now() < deadline) {
      try {
        const context = parseContext(await this.executeNativeScript(
          timelinePreflightScript(),
          deadline,
          "FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT",
        ));
        lastContext = context;
        if (!context.timelineWindowAvailable) {
          lastCode = "FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW";
          lastMessage = "Final Cut has no accessible timeline window; open a project timeline and retry";
        } else if (context.overlayBlocked) {
          lastCode = "FINAL_CUT_NATIVE_OVERLAY_BLOCKED";
          lastMessage = "The Framekit window could not be minimized; close or minimize the overlay and retry";
        } else if (!context.frontmost) {
          lastCode = "FINAL_CUT_NATIVE_NOT_FRONTMOST";
          lastMessage = "Final Cut is running but is not the frontmost application";
        } else if (!context.timelineFocused) {
          lastCode = "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED";
          lastMessage = "Final Cut's timeline pane could not be focused; click the timeline and retry";
        } else {
          return context;
        }
      } catch (error) {
        const code = nativeErrorCode(error);
        if (code === "FINAL_CUT_NATIVE_PERMISSION_REQUIRED") throw new NativeFinalCutPreflightError(code, nativeErrorMessage(error), lastContext);
        lastCode = code;
        lastMessage = nativeErrorMessage(error);
      }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(100, deadline - this.now()));
    }
    throw new NativeFinalCutPreflightError(lastCode, lastMessage, lastContext);
  }

  private async requireAvailableContext(deadline?: number): Promise<NativeFinalCutContext> {
    const context = await this.inspectRawNative(deadline);
    if (!context.available) throw new Error(`${context.error?.code ?? "FINAL_CUT_NATIVE_UNAVAILABLE"}: ${context.error?.message ?? "native context unavailable"}`);
    return context;
  }

  private async ensureBrowserReady(deadline?: number, timeoutCode = "FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT"): Promise<NativeFinalCutContext> {
    try {
      await this.executeNativeScript(browserFocusScript(), deadline, timeoutCode);
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const context = await this.requireAvailableContext(deadline);
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut could not be brought to the front for Browser automation");
    return context;
  }

  private stableMediaHandle(identity: string): string {
    return `media-import-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  }

  private async executeNativeScript(
    script: string,
    deadline?: number,
    timeoutCode = "FINAL_CUT_NATIVE_MEDIA_IMPORT_TIMEOUT",
  ): Promise<string> {
    if (deadline === undefined) return this.executor(script);
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new Error(`${timeoutCode}: native automation deadline expired`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${timeoutCode}: native automation deadline expired`));
      }, remaining);
    });
    try {
      return await Promise.race([this.executor(script, { signal: controller.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function verifyNativeUndo(
  operation: NativeOperationRecord,
  after: NativeFinalCutContext,
  afterLive?: EditorLiveState,
): NativeFinalCutUndoResult["verification"] {
  if (operation.afterLive && (!afterLive || afterLive.revision.id === operation.afterLive.revision.id)) {
    return { verified: false, detail: "Final Cut did not expose a new revision after Undo" };
  }
  if (operation.beforeDuration) {
    const duration = afterLive?.sequenceTimeRange?.duration ?? afterLive?.sequence?.duration;
    const detail = durationVerificationDetail(duration, operation.beforeDuration);
    if (!detail.verified) return detail;
  }
  if (operation.kind === "selection" && operation.before.target.name !== after.target.name) {
    return {
      verified: false,
      detail: `expected selected target ${operation.before.target.name ?? "<unnamed>"}, observed ${after.target.name ?? "<unnamed>"}`,
    };
  }
  return { verified: true, detail: "Final Cut restored the native edit's pre-operation state" };
}

async function runAppleScript(script: string, options: NativeFinalCutExecutorOptions = {}): Promise<string> {
  try {
    const result = await execFile("osascript", ["-e", script], { maxBuffer: 1_000_000, signal: options.signal });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
      throw new Error(`FINAL_CUT_NATIVE_PERMISSION_REQUIRED: ${detail}`);
    }
    throw new Error(`FINAL_CUT_NATIVE_AUTOMATION_FAILED: ${detail}`);
  }
}

function activateFinalCutWindowAppleScript(): string {
  return `
    set frontmost to true
    delay 0.1`;
}

function requireFrontmostAppleScript(): string {
  return `
    if not frontmost then error number -1719`;
}

function timelinePreflightScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    set frontmost to true
  end tell
end tell
delay 0.1
on preflightResult(processFrontmost, frontWindowName, selectedCount, selectedName, selectedRole, focusedName, focusedRole, focusedDescription, focusedWindowName, timelineWindowAvailable, timelineFocused, focusTarget, focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, selectedIdentity)
  set undoEnabled to false
  set undoCommand to ""
  try
    tell application "System Events"
      tell process "Final Cut Pro"
        repeat with candidate in menu items of menu "Edit" of menu bar 1
          try
            set candidateName to name of candidate as text
            if candidateName starts with "Undo" and (enabled of candidate) is true then
              set undoEnabled to true
              set undoCommand to candidateName
              exit repeat
            end if
          end try
        end repeat
      end tell
    end tell
  end try
  return processFrontmost & (ASCII character 31) & frontWindowName & (ASCII character 31) & selectedCount & (ASCII character 31) & selectedName & (ASCII character 31) & selectedRole & (ASCII character 31) & undoEnabled & (ASCII character 31) & "false" & (ASCII character 31) & focusedName & (ASCII character 31) & focusedRole & (ASCII character 31) & focusedDescription & (ASCII character 31) & timelineWindowAvailable & (ASCII character 31) & timelineFocused & (ASCII character 31) & focusTarget & (ASCII character 31) & focusAttempts & (ASCII character 31) & framekitWindowAvailable & (ASCII character 31) & framekitWindowMinimized & (ASCII character 31) & focusedWindowName & (ASCII character 31) & overlayBlocked & (ASCII character 31) & undoCommand & (ASCII character 31) & selectedIdentity
end preflightResult

on focusSnapshot()
  tell application "System Events"
    tell process "Final Cut Pro"
      set processState to frontmost as text
      set windowName to ""
      set elementName to ""
      set elementRole to ""
      set elementDescription to ""
      try
        set focusedWindow to value of attribute "AXFocusedWindow"
        set windowName to name of focusedWindow as text
      end try
      try
        set focusedElement to value of attribute "AXFocusedUIElement"
        set elementName to name of focusedElement as text
        set elementRole to role of focusedElement as text
        set elementDescription to description of focusedElement as text
      end try
      return {processState, windowName, elementName, elementRole, elementDescription}
    end tell
  end tell
end focusSnapshot

on attemptTimelineFocus(candidatePoint)
  tell application "System Events"
    tell process "Final Cut Pro"
      set clickedName to ""
      set clickedRole to ""
      set clickedDescription to ""
      try
        set clickedElement to click at candidatePoint
        set clickedName to name of clickedElement as text
        set clickedRole to role of clickedElement as text
        set clickedDescription to description of clickedElement as text
        try
          perform action "AXPress" of clickedElement
        end try
      end try
    end tell
  end tell
  delay 0.1
  return (my focusSnapshot()) & {clickedName, clickedRole, clickedDescription}
end attemptTimelineFocus

on timelineFocus(roleName, descriptionText, elementName)
  if roleName is "AXTextField" or roleName is "AXSearchField" then return false
  if roleName is "AXSheet" or roleName is "AXDialog" then return false
  if descriptionText contains "Browser" or descriptionText contains "browser" or descriptionText contains "search" or descriptionText contains "Search" or elementName contains "Browser" or elementName contains "browser" or elementName contains "search" or elementName contains "Search" then return false
  if roleName is "AXGroup" or roleName is "AXScrollArea" or roleName is "AXLayoutArea" or roleName is "AXCanvas" then return true
  if roleName is "AXImage" and (descriptionText contains "Filmstrip" or descriptionText contains "filmstrip" or descriptionText contains "Video") then return true
  if descriptionText contains "timeline" or descriptionText contains "Timeline" or elementName contains "timeline" or elementName contains "Timeline" then return true
  return false
end timelineFocus

tell application "System Events"
  tell process "Final Cut Pro"
    try
      set frontmost to true
      delay 0.1
    end try
    set processFrontmost to frontmost as text
    set timelineWindowAvailable to false
    set frontWindowName to ""
    set focusAttempts to 0
    set framekitWindowAvailable to false
    set framekitWindowMinimized to false
    set overlayBlocked to false
    set focusedWindowName to ""
    try
      set frontWindow to window "Final Cut Pro"
      set timelineWindowAvailable to true
      set frontWindowName to name of frontWindow as text
    on error
      return my preflightResult(processFrontmost, frontWindowName, 0, "", "", "", "", "", "", timelineWindowAvailable, false, "none", focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, "")
    end try

    try
      repeat with candidateWindow in windows
        try
          set candidateWindowName to name of candidateWindow as text
          if candidateWindowName contains "Framekit" then
            set framekitWindowAvailable to true
            set framekitWindow to contents of candidateWindow
            try
              set framekitWindowMinimized to (value of attribute "AXMinimized" of framekitWindow) as boolean
            end try
            if not framekitWindowMinimized then
              try
                perform action "AXMinimize" of framekitWindow
              on error
                try
                  set value of attribute "AXMinimized" of framekitWindow to true
                end try
              end try
              delay 0.1
              try
                set framekitWindowMinimized to (value of attribute "AXMinimized" of framekitWindow) as boolean
              end try
            end if
            if not framekitWindowMinimized then set overlayBlocked to true
            exit repeat
          end if
        end try
      end repeat
    end try

    if overlayBlocked then
      set snapshot to my focusSnapshot()
      set processFrontmost to item 1 of snapshot
      set focusedWindowName to item 2 of snapshot
      set focusedName to item 3 of snapshot
      set focusedRole to item 4 of snapshot
      set focusedDescription to item 5 of snapshot
      return my preflightResult(processFrontmost, frontWindowName, 0, "", "", focusedName, focusedRole, focusedDescription, focusedWindowName, timelineWindowAvailable, false, "unknown", focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, "")
    end if
    try
      set frontmost to true
      delay 0.1
    end try
    set snapshot to my focusSnapshot()
    set processFrontmost to item 1 of snapshot
    set focusedWindowName to item 2 of snapshot
    if processFrontmost is not "true" then
      return my preflightResult(processFrontmost, frontWindowName, 0, "", "", item 3 of snapshot, item 4 of snapshot, item 5 of snapshot, focusedWindowName, timelineWindowAvailable, false, "unknown", focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, "")
    end if
    try
      perform action "AXRaise" of frontWindow
    end try
    set frontmost to true
    delay 0.1
    set snapshot to my focusSnapshot()
    set processFrontmost to item 1 of snapshot
    set focusedWindowName to item 2 of snapshot
    if processFrontmost is not "true" then
      return my preflightResult(processFrontmost, frontWindowName, 0, "", "", item 3 of snapshot, item 4 of snapshot, item 5 of snapshot, focusedWindowName, timelineWindowAvailable, false, "unknown", focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, "")
    end if

    set windowPosition to position of frontWindow
    set windowSize to size of frontWindow
    set originX to item 1 of windowPosition
    set originY to item 2 of windowPosition
    set windowWidth to item 1 of windowSize
    set windowHeight to item 2 of windowSize
    set semanticPoints to {}
    -- Full AX-tree traversal can block Final Cut for tens of seconds while
    -- the Browser or Framekit extension window is hosted. Keep semanticPoints
    -- available for diagnostics, but use bounded timeline fallback points.

    set fallbackPoints to {{originX + (windowWidth * 0.50), originY + (windowHeight * 0.82)}, {originX + (windowWidth * 0.75), originY + (windowHeight * 0.82)}, {originX + (windowWidth * 0.25), originY + (windowHeight * 0.82)}, {originX + (windowWidth * 0.50), originY + (windowHeight * 0.90)}}
    set timelineFocused to false
    set focusTarget to "unknown"
    repeat with candidatePoint in semanticPoints
      set focusAttempts to focusAttempts + 1
      set snapshot to my attemptTimelineFocus(contents of candidatePoint)
      set processFrontmost to item 1 of snapshot
      set focusedWindowName to item 2 of snapshot
      set focusedName to item 3 of snapshot
      set focusedRole to item 4 of snapshot
      set focusedDescription to item 5 of snapshot
      set clickedName to item 6 of snapshot
      set clickedRole to item 7 of snapshot
      set clickedDescription to item 8 of snapshot
      if focusedWindowName contains "Framekit" then
        set overlayBlocked to true
        exit repeat
      else if (my timelineFocus(focusedRole, focusedDescription, focusedName) or my timelineFocus(clickedRole, clickedDescription, clickedName)) and processFrontmost is "true" then
        set timelineFocused to true
        set focusTarget to "timeline"
        exit repeat
      else if focusedRole is "AXTextField" or focusedRole is "AXSearchField" then
        set focusTarget to "text-field"
      else if focusedDescription contains "Browser" or focusedDescription contains "browser" or focusedDescription contains "search" or focusedDescription contains "Search" or focusedName contains "Browser" or focusedName contains "browser" or focusedName contains "search" or focusedName contains "Search" then
        set focusTarget to "browser"
      end if
    end repeat
    if not timelineFocused then
      repeat with fallbackPoint in fallbackPoints
        set focusAttempts to focusAttempts + 1
        set snapshot to my attemptTimelineFocus(contents of fallbackPoint)
        set processFrontmost to item 1 of snapshot
        set focusedWindowName to item 2 of snapshot
        set focusedName to item 3 of snapshot
        set focusedRole to item 4 of snapshot
        set focusedDescription to item 5 of snapshot
        set clickedName to item 6 of snapshot
        set clickedRole to item 7 of snapshot
        set clickedDescription to item 8 of snapshot
        if focusedWindowName contains "Framekit" then
          set overlayBlocked to true
          exit repeat
        else if (my timelineFocus(focusedRole, focusedDescription, focusedName) or my timelineFocus(clickedRole, clickedDescription, clickedName)) and processFrontmost is "true" then
          set timelineFocused to true
          set focusTarget to "timeline"
          exit repeat
        else if focusedRole is "AXTextField" or focusedRole is "AXSearchField" then
          set focusTarget to "text-field"
        else if focusedRole is "AXSheet" or focusedRole is "AXDialog" then
          set focusTarget to "modal"
        else if focusedDescription contains "Browser" or focusedDescription contains "browser" or focusedDescription contains "search" or focusedDescription contains "Search" or focusedName contains "Browser" or focusedName contains "browser" or focusedName contains "search" or focusedName contains "Search" then
          set focusTarget to "browser"
        else
          set focusTarget to "unknown"
        end if
      end repeat
    end if

    set snapshot to my focusSnapshot()
    set processFrontmost to item 1 of snapshot
    set focusedWindowName to item 2 of snapshot
    set focusedName to item 3 of snapshot
    set focusedRole to item 4 of snapshot
    set focusedDescription to item 5 of snapshot
    if focusedWindowName contains "Framekit" then set overlayBlocked to true
    set selectedName to ""
    set selectedRole to ""
    set selectedIdentity to ""
    set selectedCount to 0
    -- Do not walk the full AX tree here. Final Cut can block that traversal
    -- while the Browser or Framekit extension window is hosted; selected
    -- Browser media is discovered through its dedicated bounded path.
    return my preflightResult(processFrontmost, frontWindowName, selectedCount, selectedName, selectedRole, focusedName, focusedRole, focusedDescription, focusedWindowName, timelineWindowAvailable, timelineFocused, focusTarget, focusAttempts, framekitWindowAvailable, framekitWindowMinimized, overlayBlocked, selectedIdentity)
  end tell
end tell`;
}

function inspectScript(): string {
  return `
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    set frontWindow to window "Final Cut Pro"
    set frontWindowName to name of frontWindow
    set selectedName to ""
    set selectedRole to ""
    set selectedCount to 0
    try
      repeat with candidate in entire contents of frontWindow
        try
          if (selected of candidate) is true then
            set selectedCount to selectedCount + 1
            if selectedCount is 1 then
              set selectedName to name of candidate as text
              set selectedRole to role of candidate as text
            end if
          end if
        end try
      end repeat
    end try
    set undoEnabled to false
    set undoCommand to ""
    try
      repeat with candidate in menu items of menu "Edit" of menu bar 1
        try
          set candidateName to name of candidate as text
          if candidateName starts with "Undo" and (enabled of candidate) is true then
            set undoEnabled to true
            set undoCommand to candidateName
            exit repeat
          end if
        end try
      end repeat
    end try
    set bladeEnabled to false
    try
      set bladeEnabled to enabled of menu item "Blade" of menu "Trim" of menu bar 1
    end try
    set inspectorName to ""
    set inspectorRole to ""
    if selectedCount is 0 and bladeEnabled then
      set selectedCount to 1
      if inspectorName is not "" then
        set selectedName to inspectorName
        set selectedRole to inspectorRole
      end if
    end if
    set focusedName to ""
    set focusedRole to ""
    set focusedDescription to ""
    try
      set focusedElement to value of attribute "AXFocusedUIElement"
      set focusedName to value of focusedElement as text
      set focusedRole to role of focusedElement as text
      set focusedDescription to description of focusedElement as text
    end try
    set frontState to frontmost as text
    return frontState & (ASCII character 31) & frontWindowName & (ASCII character 31) & selectedCount & (ASCII character 31) & selectedName & (ASCII character 31) & selectedRole & (ASCII character 31) & undoEnabled & (ASCII character 31) & bladeEnabled & (ASCII character 31) & focusedName & (ASCII character 31) & focusedRole & (ASCII character 31) & focusedDescription & (ASCII character 31) & "" & (ASCII character 31) & "" & (ASCII character 31) & frontWindowName & (ASCII character 31) & "false" & (ASCII character 31) & undoCommand
  end tell
end tell`;
}

function searchMediaScript(query: string): string {
  return `
  ${browserSearchControlFinderScript()}
  ${browserMediaTraversalScript()}
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    ${browserSearchFieldScript()}
    set searchQuery to ${appleScriptString(query)}
    set value of searchField to searchQuery
    delay 0.5
    set output to my collectBrowserMedia(browserRoot, 0, searchQuery, origin, false, {}, "root")
    return output
  end tell
end tell`;
}

function selectedBrowserMediaScript(): string {
  return `
  ${browserSearchControlFinderScript()}
  ${browserMediaTraversalScript()}
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    set output to ""
    set selectedCandidateCount to 0
    set selectedIdentityCount to 0
    set missingSourceIdentity to false
    set seenSourceIdentities to {}
    set browserRoot to mainWindow
    try
      set browserSearchResult to my findBrowserSearchControl(mainWindow, 0)
      if browserSearchResult is not missing value then set browserRoot to item 2 of browserSearchResult
    end try
    try
      set output to my collectSelectedBrowserMedia(browserRoot, 0, origin, false, {}, "root")
      if output is not "" then
        repeat with recordItem in my splitText(output, ASCII character 30)
          if recordItem is not "" then
            set selectedCandidateCount to selectedCandidateCount + 1
            set recordParts to my splitText(recordItem, ASCII character 31)
            set candidateSourceIdentity to item 4 of recordParts
            if candidateSourceIdentity is "" then
              set missingSourceIdentity to true
            else if seenSourceIdentities does not contain candidateSourceIdentity then
              set end of seenSourceIdentities to candidateSourceIdentity
              set selectedIdentityCount to selectedIdentityCount + 1
            end if
          end if
        end repeat
      end if
    on error
      error "FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: selected Browser media was not accessible"
    end try
    if selectedIdentityCount is 0 then
      if selectedCandidateCount is 0 then error "FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: no selected Browser media was exposed by Accessibility"
      if missingSourceIdentity then error "FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: selected Browser media has no AXIdentifier"
    end if
    if selectedIdentityCount > 1 then error "FINAL_CUT_NATIVE_AMBIGUOUS_TARGET: multiple selected Browser media items were exposed"
    return output
  end tell
end tell`;
}

function browserFocusScript(): string {
  return `
  ${browserSearchControlFinderScript()}
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    ${browserSearchFieldScript()}
    return "browser-focused"
  end tell
end tell`;
}

function browserSearchFieldScript(): string {
  return `
    set origin to position of mainWindow
    set searchFieldFound to false
    set searchField to missing value
    set searchButton to missing value
    set browserRoot to mainWindow
    try
      set focusedCandidate to value of attribute "AXFocusedUIElement"
      set focusedRole to role of focusedCandidate as text
      set focusedDescription to ""
      try
        set focusedDescription to description of focusedCandidate as text
      end try
      if focusedRole is "AXSearchField" or (focusedRole is "AXTextField" and (focusedDescription contains "search" or focusedDescription contains "Search")) then
        set searchField to focusedCandidate
        set searchFieldFound to true
      end if
    end try
    if not searchFieldFound then
      repeat with searchOffset in {368, 400, 340, 561, 531, 501}
        repeat with searchY in {52, 38}
          try
            click at {(item 1 of origin) + (searchOffset as integer), (item 2 of origin) + (searchY as integer)}
            delay 0.15
            set focusedCandidate to value of attribute "AXFocusedUIElement"
            set focusedRole to role of focusedCandidate as text
            set focusedDescription to ""
            try
              set focusedDescription to description of focusedCandidate as text
            end try
            if (focusedRole is "AXSearchField" or (focusedRole is "AXTextField" and (focusedDescription contains "search" or focusedDescription contains "Search"))) then
              set searchField to focusedCandidate
              set searchFieldFound to true
              exit repeat
            end if
          end try
        end repeat
        if searchFieldFound then exit repeat
      end repeat
    end if
    try
      if my revealBrowser(mainWindow, 0) then delay 0.5
    end try
    try
      set searchControlResult to my findBrowserSearchControl(mainWindow, 0)
      if searchControlResult is not missing value then
        set searchControl to item 1 of searchControlResult
        set browserRoot to item 2 of searchControlResult
        set searchRole to role of searchControl as text
        if searchRole is "AXSearchField" or searchRole is "AXTextField" then
          set searchField to searchControl
          set searchFieldFound to true
        else if searchRole is "AXButton" then
          set searchButton to searchControl
        end if
      end if
    end try
    if not searchFieldFound then
      try
        set searchControlResult to my findBrowserSearchControl(mainWindow, 0)
        if searchControlResult is not missing value then
          set searchControl to item 1 of searchControlResult
          set browserRoot to item 2 of searchControlResult
          set searchRole to role of searchControl as text
          if searchRole is "AXSearchField" or searchRole is "AXTextField" then
            set searchField to searchControl
            set searchFieldFound to true
          else if searchRole is "AXButton" then
            set searchButton to searchControl
          end if
        end if
      end try
    end if
    if not searchFieldFound and searchButton is missing value then
      try
        set directSearchButton to UI element 3 of UI element 3 of UI element 1 of UI element 2 of UI element 1 of UI element 1 of UI element 1 of mainWindow
        set directSearchDescription to description of directSearchButton as text
        if directSearchDescription contains "search" or directSearchDescription contains "Search" then
          set searchButton to directSearchButton
        end if
      end try
    end if
    if not searchFieldFound then
      if searchButton is not missing value then
        try
          perform action "AXPress" of searchButton
          delay 0.2
          set focusedCandidate to value of attribute "AXFocusedUIElement"
          set focusedRole to role of focusedCandidate as text
          set focusedDescription to ""
          try
            set focusedDescription to description of focusedCandidate as text
          end try
          if (focusedRole is "AXSearchField" or (focusedRole is "AXTextField" and (focusedDescription contains "search" or focusedDescription contains "Search"))) then
            set searchField to focusedCandidate
            set searchFieldFound to true
          end if
        end try
      end if
    end if
    if not searchFieldFound then error "FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser search field was not found through Accessibility or coordinate fallback"
    set searchRole to role of searchField as text
    if searchRole is not "AXTextField" and searchRole is not "AXSearchField" then error "FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser search field was not hit"
    try
      perform action "AXPress" of searchField
    end try
    try
      set value of attribute "AXFocused" of searchField to true
    end try
    delay 0.2`;
}

function browserSearchControlFinderScript(): string {
  return `
  using terms from application "System Events"
    on findBrowserSearchControl(containerItem, depth)
      if depth > 12 then return missing value
      set candidateItems to UI elements of containerItem
      repeat with candidateIndex in my orderedChildIndices(containerItem)
        try
          set candidate to item (contents of candidateIndex) of candidateItems
          set candidateRole to role of candidate as text
          if candidateRole is "AXSearchField" then
            return {candidate, containerItem}
          end if
          if candidateRole is "AXTextField" then
            set candidateName to ""
            set candidateDescription to ""
            try
              set candidateName to name of candidate as text
            end try
            try
              set candidateDescription to description of candidate as text
            end try
            if candidateName contains "search" or candidateName contains "Search" or candidateDescription contains "search" or candidateDescription contains "Search" then
              return {candidate, containerItem}
            end if
          end if
          if candidateRole is "AXButton" then
            set candidateDescription to description of candidate as text
            if candidateDescription contains "search" or candidateDescription contains "Search" then
              return {candidate, containerItem}
            end if
          end if
        end try
        try
          set nestedCandidate to my findBrowserSearchControl(candidate, depth + 1)
          if nestedCandidate is not missing value then
            return nestedCandidate
          end if
        end try
      end repeat
      return missing value
    end findBrowserSearchControl

    on revealBrowser(containerItem, depth)
      if depth > 8 then return false
      set candidateItems to UI elements of containerItem
      repeat with candidateIndex in my orderedChildIndices(containerItem)
        try
          set candidate to item (contents of candidateIndex) of candidateItems
          set candidateRole to role of candidate as text
          set candidateName to ""
          set candidateDescription to ""
          try
            set candidateName to name of candidate as text
          end try
          try
            set candidateDescription to description of candidate as text
          end try
          if candidateRole is "AXCheckBox" and (candidateName contains "Browser" or candidateDescription contains "Browser" or candidateDescription contains "browser") then
            set browserVisible to false
            try
              set browserVisible to (value of candidate as boolean)
            end try
            if not browserVisible then perform action "AXPress" of candidate
            return true
          end if
        end try
        try
          if my revealBrowser(candidate, depth + 1) then return true
        end try
      end repeat
      return false
    end revealBrowser

    on orderedChildIndices(containerItem)
      set childCount to count of UI elements of containerItem
      set orderedIndices to {}
      repeat with candidateIndex from 1 to childCount
        set end of orderedIndices to contents of candidateIndex
      end repeat
      return orderedIndices
    end orderedChildIndices

  end using terms from`;
}

function browserMediaTraversalScript(): string {
  return `
  using terms from application "System Events"
    on splitText(valueText, delimiter)
      set oldDelimiters to AppleScript's text item delimiters
      set AppleScript's text item delimiters to delimiter
      set parts to text items of valueText
      set AppleScript's text item delimiters to oldDelimiters
      return parts
    end splitText

    on mediaContainer(containerItem, inheritedContext)
      set containerText to ""
      try
        set containerText to description of containerItem as text
      end try
      if containerText is "" then
        try
          set containerText to name of containerItem as text
        end try
      end if
      if containerText is "" then
        try
          set containerText to value of containerItem as text
        end try
      end if
      if containerText contains "Browser" or containerText contains "browser" or containerText contains "Events" or containerText contains "events" or containerText contains "Event" or containerText contains "event" then return true
      return inheritedContext
    end mediaContainer

    on accessibilityMediaIdentity(candidate, candidateName, candidateRole, mediaContext, browserPath)
      if not mediaContext or candidateName is "" then return ""
      if candidateRole is not "AXGroup" and candidateRole is not "AXBrowserMedia" and candidateRole is not "AXRow" and candidateRole is not "AXCell" then
        return ""
      end if
      return "fcp-ax://browser/" & browserPath & "|" & candidateRole & "|" & candidateName
    end accessibilityMediaIdentity

    on browserMediaRole(candidateRole, mediaContext, candidateSelected, candidateSourceIdentity)
      if candidateRole is "AXBrowserMedia" or candidateRole is "AXRow" or candidateRole is "AXCell" then return true
      if candidateRole is "AXButton" then return mediaContext and candidateSourceIdentity is not ""
      if candidateRole is "AXGroup" or candidateRole is "AXStaticText" or candidateRole is "AXImage" then return mediaContext or (candidateSelected and candidateSourceIdentity is not "")
      return false
    end browserMediaRole

    on browserRegion(candidatePosition, origin, mediaContext)
      if mediaContext then return true
      set candidateX to item 1 of candidatePosition
      set candidateY to item 2 of candidatePosition
      set originX to item 1 of origin
      set originY to item 2 of origin
      return candidateX >= originX and candidateX < (originX + 900) and candidateY >= (originY + 60) and candidateY < (originY + 650)
    end browserRegion

    on collectBrowserMedia(containerItem, depth, searchQuery, origin, inheritedContext, seenIdentities, browserPath)
      if depth > 12 then return ""
      set output to ""
      set mediaContext to my mediaContainer(containerItem, inheritedContext)
      tell application "System Events"
        try
          set candidateItems to UI elements of containerItem
          repeat with candidateIndex from 1 to (count of candidateItems)
            try
              set candidate to contents of item candidateIndex of candidateItems
              set candidatePath to browserPath & "/" & (candidateIndex as text)
              set candidateRole to role of candidate as text
              set candidateName to ""
              try
                set candidateName to value of candidate as text
              end try
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to name of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to description of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              set candidateSelected to false
              try
                set candidateSelected to (selected of candidate) is true
              end try
              set candidateSourceIdentity to ""
              try
                set candidateSourceIdentity to value of attribute "AXIdentifier" of candidate as text
              end try
              set candidatePosition to position of candidate
              set candidateMediaContext to my mediaContainer(candidate, mediaContext)
              set isBrowserMedia to my browserMediaRole(candidateRole, candidateMediaContext, candidateSelected, candidateSourceIdentity)
              set inBrowserRegion to my browserRegion(candidatePosition, origin, candidateMediaContext)
              if candidateSourceIdentity is "" and isBrowserMedia then set candidateSourceIdentity to my accessibilityMediaIdentity(candidate, candidateName, candidateRole, candidateMediaContext, candidatePath)
              if candidateName is not "" and candidateSourceIdentity is not "" and isBrowserMedia and inBrowserRegion and candidateName contains searchQuery then
                if seenIdentities does not contain candidateSourceIdentity then
                  set end of seenIdentities to candidateSourceIdentity
                  set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 31) & candidateSourceIdentity & (ASCII character 31) & candidateSourceIdentity & (ASCII character 30)
                end if
              end if
              set output to output & my collectBrowserMedia(candidate, depth + 1, searchQuery, origin, candidateMediaContext, seenIdentities, candidatePath)
            on error
              -- Ignore inaccessible descendants and continue enumerating Browser results.
            end try
          end repeat
        on error
          error "FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser media results were not accessible"
        end try
      end tell
      return output
    end collectBrowserMedia

    on collectSelectedBrowserMedia(containerItem, depth, origin, inheritedContext, seenIdentities, browserPath)
      if depth > 12 then return ""
      set output to ""
      set mediaContext to my mediaContainer(containerItem, inheritedContext)
      tell application "System Events"
        try
          set candidateItems to UI elements of containerItem
          repeat with candidateIndex from 1 to (count of candidateItems)
            try
              set candidate to contents of item candidateIndex of candidateItems
              set candidatePath to browserPath & "/" & (candidateIndex as text)
              set candidateSelected to false
              try
                set candidateSelected to (selected of candidate) is true
              end try
              set candidateName to ""
              try
                set candidateName to value of candidate as text
              end try
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to name of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to description of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              set candidateRole to role of candidate as text
              set candidatePosition to position of candidate
              set candidateSourceIdentity to ""
              try
                set candidateSourceIdentity to value of attribute "AXIdentifier" of candidate as text
              end try
              set candidateMediaContext to my mediaContainer(candidate, mediaContext)
              set isBrowserMedia to my browserMediaRole(candidateRole, candidateMediaContext, candidateSelected, candidateSourceIdentity)
              set inBrowserRegion to my browserRegion(candidatePosition, origin, candidateMediaContext)
              if candidateSourceIdentity is "" and isBrowserMedia then set candidateSourceIdentity to my accessibilityMediaIdentity(candidate, candidateName, candidateRole, candidateMediaContext, candidatePath)
              if candidateSelected and candidateName is not "" and isBrowserMedia and inBrowserRegion then
                if candidateSourceIdentity is "" or seenIdentities does not contain candidateSourceIdentity then
                  if candidateSourceIdentity is not "" then set end of seenIdentities to candidateSourceIdentity
                  set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 31) & candidateSourceIdentity & (ASCII character 31) & candidateSourceIdentity & (ASCII character 30)
                end if
              end if
              set output to output & my collectSelectedBrowserMedia(candidate, depth + 1, origin, candidateMediaContext, seenIdentities, candidatePath)
            on error
              -- Ignore inaccessible descendants and continue looking for the selection.
            end try
          end repeat
        on error
          error "FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: selected Browser media was not accessible"
        end try
      end tell
      return output
    end collectSelectedBrowserMedia

    on pressBrowserMedia(containerItem, depth, origin, inheritedContext, targetSourceIdentity, targetIdentity, browserPath)
      if depth > 12 then return false
      set mediaContext to my mediaContainer(containerItem, inheritedContext)
      tell application "System Events"
        try
          set candidateItems to UI elements of containerItem
          repeat with candidateIndex from 1 to (count of candidateItems)
            try
              set candidate to contents of item candidateIndex of candidateItems
              set candidatePath to browserPath & "/" & (candidateIndex as text)
              set candidateRole to role of candidate as text
              set candidateName to ""
              try
                set candidateName to value of candidate as text
              end try
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to name of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              if candidateName is "" then
                try
                  set candidateName to description of candidate as text
                end try
              end if
              if candidateName is "missing value" then set candidateName to ""
              set candidatePosition to position of candidate
              set candidateSourceIdentity to ""
              try
                set candidateSourceIdentity to value of attribute "AXIdentifier" of candidate as text
              end try
              set candidateMediaContext to my mediaContainer(candidate, mediaContext)
              set candidateSelected to false
              try
                set candidateSelected to (selected of candidate) is true
              end try
              if candidateSourceIdentity is "" and my browserMediaRole(candidateRole, candidateMediaContext, candidateSelected, candidateSourceIdentity) then set candidateSourceIdentity to my accessibilityMediaIdentity(candidate, candidateName, candidateRole, candidateMediaContext, candidatePath)
              if my browserMediaRole(candidateRole, candidateMediaContext, candidateSelected, candidateSourceIdentity) and my browserRegion(candidatePosition, origin, candidateMediaContext) then
                set candidateIdentity to (candidatePosition as text) & "|" & ((size of candidate) as text)
                if (targetSourceIdentity is not "" and candidateSourceIdentity is targetSourceIdentity) or (targetSourceIdentity is "" and candidateIdentity is targetIdentity) then
                  if candidateRole is "AXGroup" and targetSourceIdentity starts with "fcp-ax://browser/" then
                    set thumbnailClicked to false
                    try
                      set candidateChildren to UI elements of candidate
                      repeat with thumbnailIndex from 1 to (count of candidateChildren)
                        set thumbnailCandidate to contents of item thumbnailIndex of candidateChildren
                        if (role of thumbnailCandidate as text) is "AXImage" then
                          set thumbnailPosition to position of thumbnailCandidate
                          set thumbnailSize to size of thumbnailCandidate
                          click at {(item 1 of thumbnailPosition) + ((item 1 of thumbnailSize) / 2), (item 2 of thumbnailPosition) + ((item 2 of thumbnailSize) / 2)}
                          set thumbnailClicked to true
                          exit repeat
                        end if
                      end repeat
                    end try
                    if not thumbnailClicked then perform action "AXPress" of candidate
                  else
                    perform action "AXPress" of candidate
                  end if
                  return true
                end if
              end if
              if my pressBrowserMedia(candidate, depth + 1, origin, candidateMediaContext, targetSourceIdentity, targetIdentity, candidatePath) then return true
            on error
              -- Ignore inaccessible descendants and continue looking for the target.
            end try
          end repeat
        end try
      end tell
      return false
    end pressBrowserMedia
  end using terms from`;
}

function browserMediaDiagnosticScript(query: string): string {
  return `
  using terms from application "System Events"
    on collectBrowserMediaDiagnostics(containerItem, depth, searchQuery, ancestors)
      if depth > 12 then return ""
      set output to ""
      set nextAncestors to ancestors
      try
        set containerDescription to description of containerItem as text
        if containerDescription is not "" then set nextAncestors to ancestors & containerDescription & " > "
      end try
      tell application "System Events"
        try
          repeat with candidate in UI elements of containerItem
            try
              set candidateValue to ""
              try
                set candidateValue to value of candidate as text
              end try
              set candidateName to candidateValue
              if candidateName is "" then
                try
                  set candidateName to name of candidate as text
                end try
              end if
              if candidateName contains searchQuery and (length of output) < 8000 then
                set candidateRole to role of candidate as text
                set candidateDescription to ""
                try
                  set candidateDescription to description of candidate as text
                end try
                set candidateSelected to "false"
                try
                  set candidateSelected to (selected of candidate) as text
                end try
                set candidateSourceIdentity to ""
                try
                  set candidateSourceIdentity to value of attribute "AXIdentifier" of candidate as text
                end try
                set candidateBounds to ""
                try
                  set candidateBounds to ((position of candidate) as text) & "|" & ((size of candidate) as text)
                end try
                set output to output & candidateRole & (ASCII character 31) & candidateValue & (ASCII character 31) & candidateDescription & (ASCII character 31) & candidateSelected & (ASCII character 31) & candidateSourceIdentity & (ASCII character 31) & candidateBounds & (ASCII character 31) & nextAncestors & candidateDescription & (ASCII character 30)
              end if
              set output to output & my collectBrowserMediaDiagnostics(candidate, depth + 1, searchQuery, nextAncestors)
            on error
              -- Ignore inaccessible descendants and continue collecting diagnostics.
            end try
          end repeat
        end try
      end tell
      return output
    end collectBrowserMediaDiagnostics
  end using terms from
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set output to my collectBrowserMediaDiagnostics(mainWindow, 0, ${appleScriptString(query)}, "")
    return output
  end tell
  end tell`;
}

function importMediaScript(sourceDirectory: string, fileName: string): string {
  return `
  tell application "System Events"
  tell process "Final Cut Pro"
    -- FRAMEKIT_IMPORT_MEDIA
    set frontmost to true
    if not (exists window "Media Import") then keystroke "i" using {command down}
    set mediaImportWindow to missing value
    repeat 40 times
      if exists window "Media Import" then
        set mediaImportWindow to window "Media Import"
        exit repeat
      end if
      delay 0.1
    end repeat
    if mediaImportWindow is missing value then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: Media Import window did not open"
    keystroke "g" using {command down, shift down}
    set goSheet to missing value
    repeat 30 times
      if exists sheet 1 of mediaImportWindow then
        set goSheet to sheet 1 of mediaImportWindow
        exit repeat
      end if
      delay 0.1
    end repeat
    if goSheet is missing value then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: Go to folder sheet did not open"
    set value of text field 1 of goSheet to ${appleScriptString(sourceDirectory)}
    click button "Go" of goSheet
    repeat 30 times
      if not (exists sheet 1 of mediaImportWindow) then exit repeat
      delay 0.1
    end repeat
    if exists sheet 1 of mediaImportWindow then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: Go to folder sheet did not close"
    set importWindowPosition to position of mediaImportWindow
    set importWindowSize to size of mediaImportWindow
    click at {(item 1 of importWindowPosition) + 400, (item 2 of importWindowPosition) + (item 2 of importWindowSize) - 140}
    keystroke ${appleScriptString(fileName)}
    delay 0.2
    set importButton to missing value
    repeat 40 times
      try
        if exists button "Import All" of mediaImportWindow then set importButton to button "Import All" of mediaImportWindow
        if importButton is missing value and exists button "Import Selected" of mediaImportWindow then set importButton to button "Import Selected" of mediaImportWindow
        if importButton is not missing value and enabled of importButton then exit repeat
      end try
      delay 0.1
    end repeat
    if importButton is missing value or (enabled of importButton) is false then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: no enabled import button"
    click importButton
    repeat 20 times
      if exists window "Processing Files" then exit repeat
      if not (exists window "Media Import") then exit repeat
      delay 0.1
    end repeat
    repeat 100 times
      if not (exists window "Processing Files") then exit repeat
      delay 0.1
    end repeat
    if exists window "Processing Files" then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: Final Cut is still processing the import"
    if exists window "Media Import" then
      repeat with candidate in buttons of mediaImportWindow
        try
          if (description of candidate as text) is "close button" then
            click candidate
            exit repeat
          end if
        end try
      end repeat
      repeat 20 times
        if not (exists window "Media Import") then exit repeat
        delay 0.1
      end repeat
      if exists window "Media Import" then error "FINAL_CUT_NATIVE_MEDIA_IMPORT_UI_UNAVAILABLE: Media Import window did not close"
    end if
    return "import-requested"
  end tell
  end tell`;
}

function selectMediaScript(match: NativeFinalCutMediaMatch): string {
  return `
  ${browserSearchControlFinderScript()}
  ${browserMediaTraversalScript()}
  tell application "System Events"
  tell process "Final Cut Pro"
    ${activateFinalCutWindowAppleScript()}
    if not frontmost then error number -1719
    set mainWindow to window "Final Cut Pro"
    ${browserSearchFieldScript()}
    set value of searchField to ${appleScriptString(match.name)}
    delay 0.5
    set origin to position of mainWindow
    set targetSourceIdentity to ${appleScriptString(match.sourceIdentity ?? "")}
    set targetIdentity to ${appleScriptString(match.identity ?? "")}
    if targetSourceIdentity is "" and targetIdentity is "" then error "FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: Browser result has no stable identity"
    if my pressBrowserMedia(browserRoot, 0, origin, false, targetSourceIdentity, targetIdentity, "root") then return "selected"
    error "FINAL_CUT_NATIVE_MEDIA_SELECTION_UNAVAILABLE: Browser result could not be selected"
  end tell
end tell`;
}

function locateOccurrenceScript(match: NativeFinalCutMediaMatch, scanAll: boolean): string {
  const timelineOffsets = scanAll
    ? [40, 160, 224, 256, 400, 640, 880, 1120, 1360, 1500].join(", ")
    : "800";
  return `
  tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    set sourceIdentity to ${appleScriptString(match.sourceIdentity ?? "")}
    if sourceIdentity is "" then error "FINAL_CUT_NATIVE_MEDIA_ID_UNAVAILABLE: timeline lookup requires a shared source-media identifier"
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    set timelineSelection to click at {(item 1 of origin) + 800, (item 2 of origin) + 650}
    key code 115
    repeat 30 times
      key code 124
    end repeat
    set output to ""
    set inMatch to false
    set lastMatchIdentity to ""
    repeat with xOffset in {${timelineOffsets}}
      try
        set candidate to click at {(item 1 of origin) + xOffset, (item 2 of origin) + 650}
        set candidateRole to role of candidate as text
        set candidateName to value of candidate as text
        set candidateIdentity to ((position of candidate) as text) & "|" & ((size of candidate) as text)
        set candidateSourceIdentity to ""
        try
          set candidateSourceIdentity to value of attribute "AXIdentifier" of candidate as text
        end try
        if candidateSourceIdentity is sourceIdentity then
          if candidateIdentity is not lastMatchIdentity then
            set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 31) & candidateSourceIdentity & (ASCII character 31) & (xOffset as text) & (ASCII character 30)
          end if
          set lastMatchIdentity to candidateIdentity
          set inMatch to true
        else
          set inMatch to false
        end if
      on error
        set inMatch to false
      end try
    end repeat
    if output is not "" then
      click at {(item 1 of origin) + 800, (item 2 of origin) + 650}
      key code 115
      repeat 30 times
        key code 124
      end repeat
    end if
    return output
  end tell
end tell`;
}

async function selectTimelineOccurrence(executor: (script: string) => Promise<string>, timelineOffset: number): Promise<void> {
  const coordinates = (await executor(timelineSelectionCoordinatesScript())).split("|").map(Number);
  const [originX, originY] = coordinates;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: could not resolve Final Cut window coordinates");
  }
  const x = Math.round(originX + timelineOffset);
  const y = Math.round(originY + 650);
  try {
    await execFile("swift", ["-e", nativeMouseSelectionSource(x, y)]);
  } catch (error) {
    throw new Error(`FINAL_CUT_NATIVE_AUTOMATION_FAILED: native timeline selection failed: ${String(error)}`);
  }
}

function timelineSelectionCoordinatesScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    return ((item 1 of origin) as text) & "|" & ((item 2 of origin) as text)
  end tell
end tell`;
}

function timelineInsertionCoordinatesScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    set windowSize to size of mainWindow
    return ((item 1 of origin) as text) & "|" & ((item 2 of origin) as text) & "|" & ((item 1 of windowSize) as text) & "|" & ((item 2 of windowSize) as text)
  end tell
end tell`;
}

function nativeMouseFocusSource(x: number, y: number): string {
  return `
import CoreGraphics
import Foundation

let point = CGPoint(x: ${x}, y: ${y})
func postMouse(_ type: CGEventType) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
postMouse(.leftMouseDown)
usleep(80_000)
postMouse(.leftMouseUp)
usleep(100_000)
`;
}

function nativeMouseSelectionSource(x: number, y: number): string {
  return `
import CoreGraphics
import Foundation

let point = CGPoint(x: ${x}, y: ${y})
func postMouse(_ type: CGEventType) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func pressKey(_ key: CGKeyCode) {
  CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)?.post(tap: .cghidEventTap)
  usleep(30_000)
  CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap)
}
postMouse(.leftMouseDown)
usleep(80_000)
postMouse(.leftMouseUp)
usleep(100_000)
pressKey(115)
for _ in 0..<30 { pressKey(124) }
`;
}

function bladeScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    try
      click menu item "Blade" of menu "Trim" of menu bar 1
    on error
      keystroke "b"
    end try
  end tell
end tell`;
}

function mediaInsertionScript(operation: NativeFinalCutMediaInsertionOperation): string {
  const shortcut = operation === "append" ? "e" : "w";
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    set mainWindow to window "Final Cut Pro"
    set timelinePosition to position of mainWindow
    set timelineSize to size of mainWindow
    -- Selecting the Browser item leaves focus in the Browser search field.
    -- Final Cut interprets E/W there as Browser input, so explicitly return
    -- focus to the timeline before issuing the native insertion shortcut.
    click at {(item 1 of timelinePosition) + ((item 1 of timelineSize) * 0.50), (item 2 of timelinePosition) + ((item 2 of timelineSize) * 0.82)}
    delay 0.1
    keystroke "${shortcut}"
    -- When the first media item establishes an empty project's settings,
    -- Final Cut presents a modal properties sheet. Accept only that sheet;
    -- never send an unconditional Return to the timeline.
    repeat 30 times
      try
        if exists sheet 1 of mainWindow and exists button "OK" of sheet 1 of mainWindow then
          click button "OK" of sheet 1 of mainWindow
          exit repeat
        end if
      end try
      delay 0.1
    end repeat
    delay 0.5
  end tell
end tell`;
}

function setPlayheadScript(timecode: string): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    keystroke "p" using {control down}
    keystroke ${appleScriptString(timecode)}
    key code 36
    delay 0.2
  end tell
end tell`;
}

function markRangeStartScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    keystroke "i"
  end tell
end tell`;
}

function markRangeEndAndDeleteScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    keystroke "o"
    delay 0.2
    key code 51
    delay 0.5
  end tell
end tell`;
}

function editScript(operation: NativeFinalCutEdit): string {
  const action = operation.type === "rename-selected-clip"
    ? `click menu item "Apply Custom Name" of menu "Modify" of menu bar 1\n    delay 0.2\n    set value of first text field of front window to ${appleScriptString(operation.name)}\n    key code 36`
    : operation.type === "trim-selected-clip-to-playhead"
      ? `click menu item "Trim ${operation.edge === "start" ? "Start" : "End"}" of menu "Trim" of menu bar 1`
      : operation.type === "set-selected-clip-gain"
        ? `click menu item "Adjust Volume" of menu "Modify" of menu bar 1\n    delay 0.2\n    set value of first text field of front window to ${appleScriptString(`${operation.gainDb}`)}\n    key code 36`
        : `click menu item "Marker" of menu "Mark" of menu bar 1`;
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    ${action}
  end tell
end tell`;
}

function undoScript(command: string): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${requireFrontmostAppleScript()}
    click menu item ${appleScriptString(command)} of menu "Edit" of menu bar 1
  end tell
end tell`;
}

function parseContext(output: string): NativeFinalCutContext {
  const [frontState, frontWindow, selectedCountText, selectedName, selectedRole, undoState, bladeState, focusedName, focusedRole, focusedDescription, timelineWindowState, timelineFocusedState, focusTargetState, focusAttemptsState, framekitWindowState, framekitMinimizedState, focusedWindowName, overlayBlockedState, undoCommandState, targetIdentity] = output.split(String.fromCharCode(31));
  const selectedCount = Number(selectedCountText ?? "0");
  const timelineWindowAvailable = timelineWindowState === undefined ? Boolean(frontWindow) : timelineWindowState === "true";
  const timelineFocused = timelineFocusedState === undefined
    ? frontState === "true" && timelineWindowAvailable
    : timelineFocusedState === "true";
  const focusTarget = focusTargetState === "timeline" || focusTargetState === "browser" || focusTargetState === "text-field" || focusTargetState === "modal" || focusTargetState === "unknown" || focusTargetState === "none"
    ? focusTargetState
    : timelineFocused
      ? "timeline"
      : "none";
  const target = selectedCount === 1
    ? { kind: "selected-clip" as const, ...(selectedName ? { name: selectedName } : {}), ...(selectedRole ? { role: selectedRole } : {}), ...(targetIdentity ? { identity: targetIdentity } : {}) }
    : selectedCount > 1
      ? { kind: "unknown" as const }
      : focusedRole === "AXTextField" && (focusedDescription === "text field" || focusedDescription === "Title") && focusedName
        ? { kind: "selected-clip" as const, name: focusedName, role: focusedRole }
      : { kind: "playhead" as const };
  return {
    available: true,
    application: "Final Cut Pro",
    frontmost: frontState === "true",
    frontWindow,
    timelineWindowAvailable,
    timelineFocused,
    focusTarget,
    ...(focusedName ? { focusedName } : {}),
    ...(focusedRole ? { focusedRole } : {}),
    ...(focusedDescription ? { focusedDescription } : {}),
    ...(focusedWindowName ? { focusedWindowName } : {}),
    ...(focusAttemptsState && Number.isFinite(Number(focusAttemptsState)) ? { focusAttempts: Number(focusAttemptsState) } : {}),
    ...(framekitWindowState !== undefined ? { framekitWindowAvailable: framekitWindowState === "true" } : {}),
    ...(framekitMinimizedState !== undefined ? { framekitWindowMinimized: framekitMinimizedState === "true" } : {}),
    ...(overlayBlockedState !== undefined ? { overlayBlocked: overlayBlockedState === "true" } : {}),
    target,
    bladeAvailable: bladeState === "true",
    undoAvailable: undoState === "true",
    ...(undoCommandState ? { undoCommand: undoCommandState } : {}),
  };
}

function parseMediaMatches(output: string): NativeFinalCutMediaMatch[] {
  return output
    .split(String.fromCharCode(30))
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record, index) => {
      const [name = "", role = "", identity = "", sourceIdentity = ""] = record.split(String.fromCharCode(31));
      return {
        handle: opaqueHandle("media", index),
        name,
        ...(role ? { role } : {}),
        ...(identity ? { identity } : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        uiIndex: index,
      };
    });
}

function browserMediaIdentity(match: NativeFinalCutMediaMatch): string | undefined {
  const identity = match.sourceIdentity?.trim();
  return identity || undefined;
}

function parseOccurrences(output: string, mediaHandle: string): NativeFinalCutOccurrence[] {
  return output
    .split(String.fromCharCode(30))
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record, index) => {
      const [name = "", role = "", sourceIdentity = "", timelineOffsetOrDuration = "", legacyTimelineOffset] = record.split(String.fromCharCode(31));
      const legacyRecord = legacyTimelineOffset !== undefined;
      const identityOrStart = sourceIdentity;
      const timelineOffsetText = legacyRecord ? legacyTimelineOffset : timelineOffsetOrDuration;
      const legacyRange = legacyRecord || (!legacyRecord && isRational(identityOrStart) && isRational(timelineOffsetOrDuration));
      return {
        handle: opaqueHandle("occurrence", index),
        mediaHandle,
        name,
        ...(role ? { role } : {}),
        ...(sourceIdentity && !legacyRange ? { sourceIdentity } : {}),
        ...(legacyRange ? { start: identityOrStart, duration: timelineOffsetOrDuration } : {}),
        ...(timelineOffsetText && Number.isFinite(Number(timelineOffsetText)) ? { timelineOffset: Number(timelineOffsetText) } : {}),
      };
    });
}

function isRational(value: string): boolean {
  return /^-?\d+\/\d+$/.test(value);
}

function opaqueHandle(kind: string, suffix?: number): string {
  return `${kind}-${Date.now().toString(36)}-${suffix ?? Math.random().toString(36).slice(2, 8)}`;
}

function mediaKind(sourcePath: string): "video" | "audio" {
  return new Set([".aif", ".aiff", ".flac", ".m4a", ".mp3", ".wav", ".aac", ".caf"]).has(extname(sourcePath).toLowerCase())
    ? "audio"
    : "video";
}

function parseRationalNumber(value: string): number | undefined {
  const [numerator, timescale] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(timescale) || timescale <= 0) return undefined;
  return numerator / timescale;
}

function zeroRational(): RationalTime {
  return { value: "0", timescale: "1" };
}

function rationalParts(value: RationalTime): [bigint, bigint] {
  const numerator = BigInt(value.value);
  const denominator = BigInt(value.timescale);
  if (denominator <= 0n) throw new Error("INVALID_OPERATION: rational timescale must be positive");
  return [numerator, denominator];
}

function normalizeRational(numerator: bigint, denominator: bigint): RationalTime {
  if (denominator <= 0n) throw new Error("INVALID_OPERATION: rational timescale must be positive");
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { value: (numerator / divisor).toString(), timescale: (denominator / divisor).toString() };
}

function addRational(left: RationalTime, right: RationalTime): RationalTime {
  const [leftValue, leftScale] = rationalParts(left);
  const [rightValue, rightScale] = rationalParts(right);
  return normalizeRational(leftValue * rightScale + rightValue * leftScale, leftScale * rightScale);
}

function subtractRational(left: RationalTime, right: RationalTime): RationalTime {
  const [leftValue, leftScale] = rationalParts(left);
  const [rightValue, rightScale] = rationalParts(right);
  return normalizeRational(leftValue * rightScale - rightValue * leftScale, leftScale * rightScale);
}

function compareRational(left: RationalTime, right: RationalTime): number {
  const [leftValue, leftScale] = rationalParts(left);
  const [rightValue, rightScale] = rationalParts(right);
  const difference = leftValue * rightScale - rightValue * leftScale;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function divideRationalFloor(value: RationalTime, divisor: RationalTime): bigint {
  const [valueNumerator, valueDenominator] = rationalParts(value);
  const [divisorNumerator, divisorDenominator] = rationalParts(divisor);
  if (divisorNumerator <= 0n) throw new Error("INVALID_OPERATION: frame duration must be positive");
  const numerator = valueNumerator * divisorDenominator;
  const denominator = valueDenominator * divisorNumerator;
  return numerator / denominator;
}

function formatTimecode(totalFrames: bigint, framesPerSecond: number): string {
  if (totalFrames < 0n) throw new Error("INVALID_OPERATION: timecode cannot be negative");
  const fps = BigInt(framesPerSecond);
  const framesPerMinute = fps * 60n;
  const framesPerHour = framesPerMinute * 60n;
  const hours = totalFrames / framesPerHour;
  const minutes = (totalFrames % framesPerHour) / framesPerMinute;
  const seconds = (totalFrames % framesPerMinute) / fps;
  const frames = totalFrames % fps;
  return [hours, minutes, seconds, frames]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
}

function durationVerificationDetail(actual: RationalTime | undefined, expected: RationalTime, tolerance = zeroRational()): { verified: boolean; detail: string } {
  if (!actual) return { verified: false, detail: "Final Cut did not expose a resulting sequence duration" };
  const difference = subtractRational(actual, expected);
  const [differenceNumerator, differenceDenominator] = rationalParts(difference);
  const [toleranceNumerator, toleranceDenominator] = rationalParts(tolerance);
  if ((differenceNumerator < 0n ? -differenceNumerator : differenceNumerator) * toleranceDenominator <= toleranceNumerator * differenceDenominator) {
    return { verified: true, detail: `Final Cut exposed resulting duration ${actual.value}/${actual.timescale}` };
  }
  return { verified: false, detail: `expected duration ${expected.value}/${expected.timescale}, observed ${actual.value}/${actual.timescale}` };
}

function mediaInsertionVerificationDetail(
  actual: RationalTime | undefined,
  before: RationalTime,
  revision: string,
  previousRevision: string,
): { verified: boolean; detail: string } {
  if (!actual) return { verified: false, detail: "Final Cut did not expose a resulting sequence duration" };
  if (compareRational(actual, before) <= 0) {
    return { verified: false, detail: `expected inserted media to increase duration beyond ${before.value}/${before.timescale}, observed ${actual.value}/${actual.timescale}` };
  }
  if (revision === previousRevision) return { verified: false, detail: "Final Cut did not expose a new revision after media insertion" };
  return { verified: true, detail: `Final Cut exposed resulting duration ${actual.value}/${actual.timescale} at revision ${revision}` };
}

function mediaInsertionMutationObserved(before: EditorLiveState, after: EditorLiveState): boolean {
  const beforeDuration = before.sequenceTimeRange?.duration ?? before.sequence?.duration;
  const afterDuration = after.sequenceTimeRange?.duration ?? after.sequence?.duration;
  return Boolean(beforeDuration && afterDuration && compareRational(afterDuration, beforeDuration) > 0);
}

function unavailableContext(code: string, message: string, observed?: NativeFinalCutContext): NativeFinalCutContext {
  return {
    ...(observed ?? {
      application: "Final Cut Pro" as const,
      frontmost: false,
      timelineWindowAvailable: false,
      timelineFocused: false,
      focusTarget: "none" as const,
      target: { kind: "none" as const },
      undoAvailable: false,
      bladeAvailable: false,
    }),
    available: false,
    error: { code, message },
  };
}

function preflightContext(error: unknown): NativeFinalCutContext | undefined {
  return error instanceof NativeFinalCutPreflightError ? error.context : undefined;
}

function verifyNativeEdit(operation: NativeFinalCutEdit, before: NativeFinalCutContext, after: NativeFinalCutContext): NativeFinalCutEditResult["verification"] {
  if (operation.type === "rename-selected-clip" && after.target.name !== operation.name) {
    return { verified: false, level: "selection-observed", detail: "Final Cut did not expose the renamed selected clip" };
  }
  if (operation.type === "rename-selected-clip") {
    return { verified: true, level: "selection-observed", detail: "Selected clip name changed" };
  }
  if (!after.frontmost || before.frontWindow !== after.frontWindow) {
    return { verified: false, level: "native-command-accepted", detail: "Final Cut changed focus during the native edit" };
  }
  return { verified: true, level: "native-command-accepted", detail: "Final Cut accepted the native menu command" };
}

function requiresClip(operation: NativeFinalCutEdit): boolean {
  return operation.type === "rename-selected-clip" || operation.type === "trim-selected-clip-to-playhead" || operation.type === "set-selected-clip-gain";
}

function commandName(operation: NativeFinalCutEdit): string {
  if (operation.type === "rename-selected-clip") return "Modify > Apply Custom Name";
  if (operation.type === "trim-selected-clip-to-playhead") return `Trim > Trim ${operation.edge === "start" ? "Start" : "End"}`;
  if (operation.type === "set-selected-clip-gain") return "Modify > Adjust Volume";
  return "Mark > Marker";
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
}

function nativeErrorCode(error: unknown): string {
  const message = String(error);
  if (message.includes("-1712") || /AppleEvent.*timed out/i.test(message)) return "FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT";
  const explicitCodes = [...message.matchAll(/FINAL_CUT_NATIVE_[A-Z_]+/g)].map((match) => match[0]);
  if (explicitCodes.length > 0) return explicitCodes[explicitCodes.length - 1];
  if (message.includes("PERMISSION_REQUIRED") || message.includes("not authorized") || message.includes("-1743") || message.includes("-25211")) return "FINAL_CUT_NATIVE_PERMISSION_REQUIRED";
  if (message.includes("-600") || message.includes("isn't running") || message.includes("is not running")) return "FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW";
  if (message.includes("-1728") || message.includes("Can’t get window") || message.includes("Can't get window")) return "FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW";
  if (message.includes("-1719") || message.includes("window 1") || message.includes("Invalid index")) return "FINAL_CUT_NATIVE_NOT_FRONTMOST";
  if (message.includes("MODAL")) return "FINAL_CUT_NATIVE_MODAL_BLOCKED";
  return "FINAL_CUT_NATIVE_AUTOMATION_FAILED";
}

function nativeErrorMessage(error: unknown): string {
  const message = String(error);
  if (message.includes("FINAL_CUT_NATIVE_OVERLAY_BLOCKED")) return "The Framekit window could not be minimized; close or minimize the overlay and retry";
  if (message.includes("FINAL_CUT_NATIVE_APPLE_EVENT_TIMEOUT") || message.includes("-1712") || /AppleEvent.*timed out/i.test(message)) return "Final Cut did not respond to an AppleEvent; reopen or bring Final Cut Pro to the front and retry";
  if (message.includes("FINAL_CUT_NATIVE_NO_TIMELINE_WINDOW")) return "Final Cut has no accessible timeline window; open a project timeline and retry";
  if (message.includes("FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED")) return "Final Cut's timeline pane could not be focused; click the timeline and retry";
  if (message.includes("FINAL_CUT_NATIVE_NOT_FRONTMOST")) return "Final Cut is running but is not the frontmost application";
  if (message.includes("-600") || message.includes("isn't running") || message.includes("is not running")) return "Final Cut is not running or has no accessible timeline window; open a project timeline and retry";
  if (message.includes("-1728") || message.includes("Can’t get window") || message.includes("Can't get window")) return "Final Cut has no accessible timeline window; open a project timeline and retry";
  if (message.includes("-1719") || message.includes("window 1") || message.includes("Invalid index")) return "Final Cut has no accessible timeline window; bring a project timeline to the front";
  if (message.includes("PERMISSION_REQUIRED") || message.includes("not authorized") || message.includes("-1743") || message.includes("-25211")) return "Grant Accessibility and Automation permission to the MCP host for Final Cut Pro";
  const executionError = message.split("\n").find((line) => line.includes("execution error:"));
  return executionError?.trim() ?? message;
}

function isRecoverableNativeFocusRace(error: unknown): boolean {
  const code = nativeErrorCode(error);
  if (code === "FINAL_CUT_NATIVE_NOT_FRONTMOST" || code === "FINAL_CUT_NATIVE_TIMELINE_FOCUS_REQUIRED") return true;
  const message = String(error);
  return message.includes("execution error:") && message.includes("-1719");
}
