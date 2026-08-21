import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { EditorLiveState, RationalTime } from "@framekit/runtime";

const execFile = promisify(execFileCallback);

export type NativeFinalCutEdit =
  | { type: "rename-selected-clip"; name: string }
  | { type: "trim-selected-clip-to-playhead"; edge: "start" | "end" }
  | { type: "set-selected-clip-gain"; gainDb: number }
  | { type: "add-marker-at-playhead"; name: string; duration?: number };

export interface NativeFinalCutMediaMatch {
  handle: string;
  name: string;
  role?: string;
  source?: string;
  browserContext?: string;
  uiIndex?: number;
}

export interface NativeFinalCutOccurrence {
  handle: string;
  mediaHandle: string;
  name: string;
  start?: string;
  duration?: string;
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
}

export interface NativeFinalCutContext {
  available: boolean;
  application: "Final Cut Pro";
  frontmost: boolean;
  frontWindow?: string;
  project?: string;
  sequence?: string;
  playheadTime?: string;
  target: {
    kind: "selected-clip" | "browser-media" | "playhead" | "unknown" | "none";
    name?: string;
    role?: string;
  };
  bladeAvailable: boolean;
  undoAvailable: boolean;
  error?: { code: string; message: string };
}

export interface NativeFinalCutCapabilities {
  selectionEdit: boolean;
  undo: boolean;
  mediaLibrarySearch: boolean;
  mediaSelection: boolean;
  timelineOccurrenceLocate: boolean;
  bladeAtPlayhead: boolean;
  deleteRange: boolean;
  trimToDuration: boolean;
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
}

export interface NativeFinalCutUndoResult {
  operationId: string;
  undone: boolean;
  context: NativeFinalCutContext;
}

export interface NativeFinalCutAutomationOptions {
  enabled?: boolean;
  executor?: (script: string) => Promise<string>;
  liveState?: () => Promise<EditorLiveState>;
  suspendLiveConnection?: () => void;
  resumeLiveConnection?: () => void;
  now?: () => number;
}

export interface NativeFinalCutEditor {
  capabilities(): NativeFinalCutCapabilities;
  inspect(): Promise<NativeFinalCutContext>;
  edit(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult>;
  undo(operationId: string): Promise<NativeFinalCutUndoResult>;
  searchMedia(query: string): Promise<NativeFinalCutMediaMatch[]>;
  selectMedia(handle: string): Promise<NativeFinalCutContext>;
  locateOccurrence(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult>;
  previewBlade(occurrenceHandle: string): Promise<NativeFinalCutBladePreview>;
  executeBlade(previewToken: string): Promise<NativeFinalCutBladeResult>;
  previewDeleteRange(range: NativeFinalCutRange): Promise<NativeFinalCutRangePreview>;
  executeDeleteRange(previewToken: string): Promise<NativeFinalCutRangeResult>;
  previewTrimToDuration(duration: RationalTime): Promise<NativeFinalCutRangePreview>;
  executeTrimToDuration(previewToken: string): Promise<NativeFinalCutRangeResult>;
}

export class FinalCutNativeAutomationAdapter implements NativeFinalCutEditor {
  private readonly enabled: boolean;
  private readonly executor: (script: string) => Promise<string>;
  private readonly canDriveNativeMouse: boolean;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly suspendLiveConnection?: () => void;
  private readonly resumeLiveConnection?: () => void;
  private readonly now: () => number;
  private nativeUiDepth = 0;
  private readonly operations = new Set<string>();
  private readonly mediaHandles = new Map<string, NativeFinalCutMediaMatch>();
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

  public constructor(options: NativeFinalCutAutomationOptions = {}) {
    this.enabled = options.enabled ?? process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES === "1";
    this.executor = options.executor ?? runAppleScript;
    this.canDriveNativeMouse = options.executor === undefined;
    this.liveState = options.liveState;
    this.suspendLiveConnection = options.suspendLiveConnection;
    this.resumeLiveConnection = options.resumeLiveConnection;
    this.now = options.now ?? Date.now;
  }

  public capabilities(): NativeFinalCutCapabilities {
    return {
      selectionEdit: this.enabled,
      undo: this.enabled,
      mediaLibrarySearch: this.enabled,
      mediaSelection: this.enabled,
      timelineOccurrenceLocate: this.enabled,
      bladeAtPlayhead: this.enabled,
      deleteRange: this.enabled,
      trimToDuration: this.enabled,
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
    };
  }

  public async inspect(): Promise<NativeFinalCutContext> {
    return this.withNativeUi(() => this.inspectNative());
  }

  private async inspectNative(): Promise<NativeFinalCutContext> {
    if (!this.enabled) {
      return unavailableContext("CAPABILITY_UNAVAILABLE", "Final Cut native writes are disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    }
    try {
      const context = parseContext(await this.executor(inspectScript()));
      if (this.liveState) {
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
      }
      return context;
    } catch (error) {
      return unavailableContext(nativeErrorCode(error), nativeErrorMessage(error));
    }
  }

  public async edit(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult> {
    return this.withNativeUi(() => this.editNative(operation));
  }

  private async editNative(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult> {
    this.assertEnabled();
    const before = await this.requireTarget(operation);
    const operationId = `native-op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const command = commandName(operation);
    try {
      await this.executor(editScript(operation));
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    const verification = verifyNativeEdit(operation, before, after);
    if (!verification.verified) {
      throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${verification.detail}`);
    }
    this.operations.add(operationId);
    return { operationId, operation, command, before, after, verification, undoAvailable: after.undoAvailable };
  }

  public async undo(operationId: string): Promise<NativeFinalCutUndoResult> {
    return this.withNativeUi(() => this.undoNative(operationId));
  }

  private async undoNative(operationId: string): Promise<NativeFinalCutUndoResult> {
    this.assertEnabled();
    if (!this.operations.has(operationId)) throw new Error(`FINAL_CUT_NATIVE_UNDO_UNAVAILABLE: unknown operation ${operationId}`);
    const before = await this.requireAvailableContext();
    if (!before.undoAvailable) throw new Error("FINAL_CUT_NATIVE_UNDO_UNAVAILABLE: Final Cut has no available Undo command");
    try {
      await this.executor(undoScript());
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    this.operations.delete(operationId);
    return { operationId, undone: true, context: after };
  }

  public async searchMedia(query: string): Promise<NativeFinalCutMediaMatch[]> {
    return this.withNativeUi(() => this.searchMediaNative(query));
  }

  private async searchMediaNative(query: string): Promise<NativeFinalCutMediaMatch[]> {
    this.assertEnabled();
    if (!query.trim()) throw new Error("INVALID_OPERATION: media search query cannot be empty");
    const context = await this.requireAvailableContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's Browser must be frontmost");
    try {
      const matches = parseMediaMatches(await this.executor(searchMediaScript(query)));
      this.mediaHandles.clear();
      for (const match of matches) this.mediaHandles.set(match.handle, match);
      return matches;
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
    const before = await this.requireAvailableContext();
    if (!before.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's Browser must be frontmost");
    try {
      await this.executor(selectMediaScript(match));
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    return {
      ...after,
      target: { kind: "browser-media", name: match.name, ...(match.role ? { role: match.role } : {}) },
    };
  }

  public async locateOccurrence(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult> {
    return this.withNativeUi(() => this.locateOccurrenceNative(mediaHandle));
  }

  private async locateOccurrenceNative(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult> {
    this.assertEnabled();
    const match = this.mediaHandles.get(mediaHandle);
    if (!match) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${mediaHandle}`);
    const context = await this.requireAvailableContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    try {
      const occurrences = parseOccurrences(await this.executor(locateOccurrenceScript(match, false)), mediaHandle);
      if (occurrences.length === 1 && this.canDriveNativeMouse) {
        await selectTimelineClipAtPlayhead(this.executor);
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
    const context = await this.requireAvailableContext();
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
    const before = await this.requireAvailableContext();
    if (!before.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    if (before.target.kind !== "selected-clip") throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: select exactly one timeline occurrence");
    if (before.target.name && before.target.name !== preview.occurrence.name) {
      throw new Error("FINAL_CUT_NATIVE_OCCURRENCE_HANDLE_STALE: selected timeline occurrence changed");
    }
    await this.validateOccurrenceBinding(preview.occurrence);
    if (!before.bladeAvailable) throw new Error("FINAL_CUT_NATIVE_PLAYHEAD_OUTSIDE_OCCURRENCE: Final Cut has disabled Blade for the current selection/playhead");
    try {
      await this.executor(bladeScript());
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    if (!after.frontmost) throw new Error("FINAL_CUT_NATIVE_VERIFICATION_FAILED: Final Cut changed focus during Blade");
    const resultingSegments = parseOccurrences(
      await this.executor(locateOccurrenceScript({ handle: preview.occurrence.mediaHandle, name: preview.occurrence.name }, true)),
      preview.occurrence.mediaHandle,
    );
    if (resultingSegments.length < 2) {
      throw new Error("FINAL_CUT_NATIVE_VERIFICATION_FAILED: Final Cut did not expose two resulting timeline segments after Blade");
    }
    const operationId = opaqueHandle("native-blade");
    this.operations.add(operationId);
    return {
      operationId,
      previewToken,
      occurrence: preview.occurrence,
      resultingSegments,
      before,
      after,
      verification: { verified: true, detail: "Final Cut accepted the Blade command while the target remained frontmost" },
      undoAvailable: after.undoAvailable,
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
      const context = await this.requireAvailableContext();
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

  private async previewRangeNative(operation: NativeFinalCutRangeOperation, range: NativeFinalCutRange): Promise<NativeFinalCutRangePreview> {
    this.assertEnabled();
    const context = await this.requireAvailableContext();
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
    const beforeLive = await this.requireLiveState();
    this.validateRangeBinding(preview, beforeLive);
    const before = await this.requireTarget({ type: "add-marker-at-playhead", name: "native-range-operation" });
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
      await this.positionAndDeleteRange(preview.range, beforeLive);
    } catch (error) {
      throw new Error(`${nativeErrorCode(error)}: ${String(error)}`);
    }
    const after = await this.requireAvailableContext();
    const afterLive = await this.waitForDuration(preview.expectedAfterDuration, beforeLive.revision.id);
    const detail = durationVerificationDetail(
      afterLive.sequenceTimeRange?.duration ?? afterLive.sequence?.duration,
      preview.expectedAfterDuration,
      afterLive.sequence?.frameDuration ?? beforeLive.sequence?.frameDuration,
    );
    if (!detail.verified) throw new Error(`FINAL_CUT_NATIVE_VERIFICATION_FAILED: ${detail.detail}`);
    const operationId = opaqueHandle(`native-${preview.operation}`);
    this.operations.add(operationId);
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

  private async waitForDuration(expected: RationalTime, previousRevision: string): Promise<EditorLiveState> {
    const deadline = this.now() + 2_000;
    let latest = await this.requireLiveState();
    while (this.now() < deadline) {
      const duration = latest.sequenceTimeRange?.duration ?? latest.sequence?.duration;
      if (duration && durationVerificationDetail(duration, expected, latest.sequence?.frameDuration).verified && latest.revision.id !== previousRevision) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
      latest = await this.requireLiveState();
    }
    return latest;
  }

  private async positionAndDeleteRange(range: NativeFinalCutRange, beforeLive: EditorLiveState): Promise<void> {
    const startTimecode = this.toTimecode(range.start, beforeLive);
    const endTimecode = this.toTimecode(range.end, beforeLive);
    await this.executor(focusTimelineScript());
    await this.executor(setPlayheadScript(startTimecode));
    await this.waitForPlayhead(range.start, beforeLive.sequence?.id);
    await this.executor(markRangeStartScript());
    await this.executor(setPlayheadScript(endTimecode));
    await this.waitForPlayhead(range.end, beforeLive.sequence?.id);
    await this.executor(markRangeEndAndDeleteScript());
  }

  private async waitForPlayhead(expected: RationalTime, sequenceId?: string): Promise<EditorLiveState> {
    const deadline = this.now() + 2_000;
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

  private async requireTarget(operation: NativeFinalCutEdit): Promise<NativeFinalCutContext> {
    const context = await this.requireAvailableContext();
    if (!context.frontmost || context.frontWindow?.includes("Framekit")) {
      throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline window must be frontmost");
    }
    if (requiresClip(operation) && context.target.kind !== "selected-clip") {
      throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: select exactly one clip in Final Cut Pro");
    }
    if (!requiresClip(operation) && context.target.kind === "none") {
      throw new Error("FINAL_CUT_NATIVE_SELECTION_REQUIRED: position the playhead in Final Cut Pro");
    }
    return context;
  }

  private async requireAvailableContext(): Promise<NativeFinalCutContext> {
    const context = await this.inspect();
    if (!context.available) throw new Error(`${context.error?.code ?? "FINAL_CUT_NATIVE_UNAVAILABLE"}: ${context.error?.message ?? "native context unavailable"}`);
    return context;
  }
}

async function runAppleScript(script: string): Promise<string> {
  try {
    const result = await execFile("osascript", ["-e", script], { maxBuffer: 1_000_000 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
      throw new Error(`FINAL_CUT_NATIVE_PERMISSION_REQUIRED: ${detail}`);
    }
    throw new Error(`FINAL_CUT_NATIVE_AUTOMATION_FAILED: ${detail}`);
  }
}

function dismissFramekitWindowAppleScript(): string {
  return `
    try
      if exists window "Framekit" then
        set ignoredResult to click button 1 of window "Framekit"
        delay 0.1
      end if
    end try
    set frontmost to true
    delay 0.1`;
}

function inspectScript(): string {
  return `
  tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
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
    try
      set undoEnabled to enabled of menu item "Undo" of menu "Edit" of menu bar 1
    end try
    set bladeEnabled to false
    try
      set bladeEnabled to enabled of menu item "Blade" of menu "Trim" of menu bar 1
    end try
    try
      if not undoEnabled then set undoEnabled to enabled of menu item "Undo Blade" of menu "Edit" of menu bar 1
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
    return frontState & (ASCII character 31) & frontWindowName & (ASCII character 31) & selectedCount & (ASCII character 31) & selectedName & (ASCII character 31) & selectedRole & (ASCII character 31) & undoEnabled & (ASCII character 31) & bladeEnabled & (ASCII character 31) & focusedName & (ASCII character 31) & focusedRole & (ASCII character 31) & focusedDescription
  end tell
end tell`;
}

function searchMediaScript(query: string): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    set searchX to (item 1 of origin) + 240
    set searchY to (item 2 of origin) + 83
    set searchQuery to ${appleScriptString(query)}
    set searchField to click at {searchX, searchY}
    if (role of searchField as text) is not "AXTextField" or (description of searchField as text) is not "text search" then error "FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser search field was not hit"
    set value of searchField to searchQuery
    try
      set value of attribute "AXFocused" of searchField to true
    end try
    delay 0.5
    return ${appleScriptString(query)} & (ASCII character 31) & "AXBrowserMedia" & (ASCII character 30)
  end tell
end tell`;
}

function selectMediaScript(match: NativeFinalCutMediaMatch): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    set searchField to click at {(item 1 of origin) + 240, (item 2 of origin) + 83}
    if (role of searchField as text) is not "AXTextField" or (description of searchField as text) is not "text search" then error "FINAL_CUT_NATIVE_SEARCH_UNAVAILABLE: Browser search field was not hit"
    set value of searchField to ${appleScriptString(match.name)}
    try
      set value of attribute "AXFocused" of searchField to true
    end try
    delay 0.5
    click at {(item 1 of origin) + 275, (item 2 of origin) + 185}
    return "selected"
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
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
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
        if candidateName is ${appleScriptString(match.name)} then
          if candidateIdentity is not lastMatchIdentity then
            set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 31) & candidateIdentity & (ASCII character 30)
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

async function selectTimelineClipAtPlayhead(executor: (script: string) => Promise<string>): Promise<void> {
  const coordinates = (await executor(timelineSelectionCoordinatesScript())).split("|").map(Number);
  const [originX, originY] = coordinates;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new Error("FINAL_CUT_NATIVE_AUTOMATION_FAILED: could not resolve Final Cut window coordinates");
  }
  const x = Math.round(originX + 800);
  const y = Math.round(originY + 670);
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
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    return ((item 1 of origin) as text) & "|" & ((item 2 of origin) as text)
  end tell
end tell`;
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
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    try
      click menu item "Blade" of menu "Trim" of menu bar 1
    on error
      keystroke "b"
    end try
  end tell
end tell`;
}

function focusTimelineScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    set mainWindow to window "Final Cut Pro"
    set origin to position of mainWindow
    click at {(item 1 of origin) + 800, (item 2 of origin) + 650}
    keystroke "a"
  end tell
end tell`;
}

function setPlayheadScript(timecode: string): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
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
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
    keystroke "i"
  end tell
end tell`;
}

function markRangeEndAndDeleteScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    if not frontmost then error number -1719
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
    ${dismissFramekitWindowAppleScript()}
    ${action}
  end tell
end tell`;
}

function undoScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    ${dismissFramekitWindowAppleScript()}
    keystroke "z" using {command down}
  end tell
end tell`;
}

function parseContext(output: string): NativeFinalCutContext {
  const [frontState, frontWindow, selectedCountText, selectedName, selectedRole, undoState, bladeState, focusedName, focusedRole, focusedDescription] = output.split(String.fromCharCode(31));
  const selectedCount = Number(selectedCountText ?? "0");
  const target = selectedCount === 1
    ? { kind: "selected-clip" as const, ...(selectedName ? { name: selectedName } : {}), ...(selectedRole ? { role: selectedRole } : {}) }
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
    target,
    bladeAvailable: bladeState === "true",
    undoAvailable: undoState === "true",
  };
}

function parseMediaMatches(output: string): NativeFinalCutMediaMatch[] {
  return output
    .split(String.fromCharCode(30))
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record, index) => {
      const [name = "", role = ""] = record.split(String.fromCharCode(31));
      return {
        handle: opaqueHandle("media", index),
        name,
        ...(role ? { role } : {}),
        uiIndex: index,
      };
    });
}

function parseOccurrences(output: string, mediaHandle: string): NativeFinalCutOccurrence[] {
  return output
    .split(String.fromCharCode(30))
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record, index) => {
      const [name = "", role = "", start, duration] = record.split(String.fromCharCode(31));
      return {
        handle: opaqueHandle("occurrence", index),
        mediaHandle,
        name,
        ...(role ? { role } : {}),
        ...(start ? { start } : {}),
        ...(duration ? { duration } : {}),
      };
    });
}

function opaqueHandle(kind: string, suffix?: number): string {
  return `${kind}-${Date.now().toString(36)}-${suffix ?? Math.random().toString(36).slice(2, 8)}`;
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

function unavailableContext(code: string, message: string): NativeFinalCutContext {
  return {
    available: false,
    application: "Final Cut Pro",
    frontmost: false,
    target: { kind: "none" },
    undoAvailable: false,
    bladeAvailable: false,
    error: { code, message },
  };
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
  if (message.includes("PERMISSION_REQUIRED") || message.includes("not authorized") || message.includes("-1743") || message.includes("-25211")) return "FINAL_CUT_NATIVE_PERMISSION_REQUIRED";
  if (message.includes("-1719") || message.includes("window 1") || message.includes("Invalid index")) return "FINAL_CUT_NATIVE_NOT_FRONTMOST";
  if (message.includes("MODAL")) return "FINAL_CUT_NATIVE_MODAL_BLOCKED";
  return message.match(/FINAL_CUT_NATIVE_[A-Z_]+/)?.[0] ?? "FINAL_CUT_NATIVE_AUTOMATION_FAILED";
}

function nativeErrorMessage(error: unknown): string {
  const message = String(error);
  if (message.includes("-1719") || message.includes("window 1") || message.includes("Invalid index")) return "Final Cut has no accessible timeline window; bring a project timeline to the front";
  if (message.includes("PERMISSION_REQUIRED") || message.includes("not authorized") || message.includes("-1743") || message.includes("-25211")) return "Grant Accessibility and Automation permission to the MCP host for Final Cut Pro";
  const executionError = message.split("\n").find((line) => line.includes("execution error:"));
  return executionError?.trim() ?? message;
}
