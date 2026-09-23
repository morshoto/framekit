import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  canonicalSnapshotDigest,
  canonicalTimelineMode,
  createProjectSelectionResult,
  assertTimelineTargetReadAfterWrite,
  createTimelineTarget,
  resolveTimelineTarget,
  reconcileProjectCatalog,
  validateProjectCatalog,
  withCapabilityFamilies,
  CapabilityUnavailableError,
} from "@framekit/runtime";

import {
  type ContextRevision,
  type EditorChange,
  type EditorIdentity,
  type EditorLiveState,
  type EditOperation,
  type EditorPort,
  type LiveEditorStatePort,
  type ProjectCatalog,
  type ProjectSelection,
  type ProjectSelectionResult,
  type ProjectSnapshot,
  type RationalTime,
  type TimeRange,
  type RuntimeCapabilities,
  type CapabilityDescriptor,
  type CapabilityInspectionOptions,
  type WorkflowOperation,
} from "@framekit/runtime";
import type {
  NativeFinalCutEditor,
} from "./native.js";
import { recoverCanonicalNativeMutation } from "./canonical-recovery.js";
import { verifyCanonicalReadback } from "./canonical-verification.js";
import { FcpxmlDocumentAdapter } from "./fcpxml.js";

const execFile = promisify(execFileCallback);

export interface CanonicalNativeMutationPort {
  renameSelectedClip(name: string): Promise<{ operationId: string; undoAvailable: boolean }>;
  trimSelectedClipToRange?(range: { start: RationalTime; end: RationalTime }): Promise<{ operationId: string; undoAvailable: boolean }>;
  addMarkerAtTime?(marker: { start: RationalTime; duration: RationalTime; name: string }): Promise<{ operationId: string; undoAvailable: boolean }>;
  rippleDeleteRange?(range: { start: RationalTime; end: RationalTime }): Promise<{ operationId: string; undoAvailable: boolean }>;
  setSelectedClipGain?(gainDb: number): Promise<{ operationId: string; undoAvailable: boolean }>;
  undo(operationId: string): Promise<{ undone: boolean; verification?: { verified: boolean } }>;
}

export type CanonicalNativeTargetResolver = (
  clip: ProjectSnapshot["timeline"]["clips"][number],
  snapshot: ProjectSnapshot,
) => Promise<void>;

export interface FinalCutBackgroundCatalogProvider {
  listProjects(): Promise<ProjectCatalog>;
  backend?: string;
}

export interface FinalCutCanonicalNativeProviderOptions {
  live: LiveEditorStatePort & {
    getIdentity(): Promise<EditorIdentity>;
    getCapabilities?(): Promise<RuntimeCapabilities>;
    listProjects?(): Promise<ProjectCatalog>;
  };
  native: CanonicalNativeMutationPort;
  readSnapshot: () => Promise<ProjectSnapshot>;
  resolveTarget: CanonicalNativeTargetResolver;
  backgroundCatalog?: FinalCutBackgroundCatalogProvider;
}

export interface FinalCutCanonicalSnapshotSourceOptions {
  executor?: (script: string) => Promise<string>;
  exportTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CanonicalLiveReadiness {
  ready: boolean;
  mode: ReturnType<typeof canonicalTimelineMode>;
  missing: string[];
}

/** Report the complete guarantees required before claiming canonical live support. */
export function assessCanonicalLiveReadiness(capabilities: RuntimeCapabilities): CanonicalLiveReadiness {
  const mode = canonicalTimelineMode(capabilities);
  const editor = capabilities.editor;
  const missing = [
    ...(mode === "canonical-write" ? [] : ["canonical-write"]),
    ...(!editor.projectCatalogRead ? ["projectCatalogRead"] : []),
    ...(!editor.projectSelection ? ["projectSelection"] : []),
    ...(!editor.timelineSnapshotRead ? ["timelineSnapshotRead"] : []),
    ...(!editor.timelineWrite ? ["timelineWrite"] : []),
    ...(!editor.readAfterWrite ? ["readAfterWrite"] : []),
    ...(!editor.rollback ? ["rollback"] : []),
  ];
  return { ready: missing.length === 0, mode, missing };
}

/** Reads the active Final Cut project through its headed Export XML command. */
export class FinalCutCanonicalSnapshotSource {
  private readonly executor: (script: string) => Promise<string>;
  private readonly exportTimeoutMs: number;
  private readonly pollIntervalMs: number;

  public constructor(options: FinalCutCanonicalSnapshotSourceOptions = {}) {
    this.executor = options.executor ?? executeCanonicalAppleScript;
    this.exportTimeoutMs = Math.max(1_000, options.exportTimeoutMs ?? 30_000);
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  }

  public async readSnapshot(): Promise<ProjectSnapshot> {
    const directory = await mkdtemp(join(tmpdir(), "framekit-finalcut-canonical-"));
    const exportPath = join(directory, "active.fcpxml");
    try {
      await this.executor(buildFinalCutCanonicalExportScript(exportPath));
      return await readCanonicalExport(exportPath, this.exportTimeoutMs, this.pollIntervalMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes("FINAL_CUT_CANONICAL_")) throw error;
      throw new Error(`FINAL_CUT_CANONICAL_EXPORT_FAILED: ${detail}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function buildFinalCutCanonicalExportScript(exportPath: string): string {
  return `
using terms from application "System Events"

on findMenuItem(container, expectedNames, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    repeat with candidate in (menu items of container)
      try
        set candidateName to name of candidate as text
        repeat with expectedName in expectedNames
          if candidateName is (expectedName as text) then return candidate
        end repeat
      end try
    end repeat
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end findMenuItem

on findWindow(finalCut, expectedNames, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    repeat with expectedName in expectedNames
      try
        if exists window (expectedName as text) of finalCut then return window (expectedName as text) of finalCut
      end try
    end repeat
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end findWindow

on pressButtonIfPresent(targetWindow, expectedNames)
  repeat with candidate in (buttons of targetWindow)
    try
      set candidateName to name of candidate as text
      repeat with expectedName in expectedNames
        if candidateName is (expectedName as text) and enabled of candidate then
          perform action "AXPress" of candidate
          return true
        end if
      end repeat
    end try
  end repeat
  return false
end pressButtonIfPresent

end using terms from

tell application "System Events"
  tell process "Final Cut Pro"
    set frontmost to true
    delay 0.1
    if not frontmost then error "FINAL_CUT_CANONICAL_NOT_FRONTMOST: Final Cut Pro must be frontmost"
    set finalCut to it
    set fileMenu to menu "File" of menu bar 1
    set exportCommand to missing value
    try
      set exportCommand to my findMenuItem(fileMenu, {"Export XML…", "Export XML..."}, 10, "FINAL_CUT_CANONICAL_EXPORT_MENU_UNAVAILABLE: File > Export XML was not exposed")
    on error
      set exportMenuItem to my findMenuItem(fileMenu, {"Export"}, 10, "FINAL_CUT_CANONICAL_EXPORT_MENU_UNAVAILABLE: File > Export was not exposed")
      perform action "AXPress" of exportMenuItem
      set exportMenu to missing value
      repeat 100 times
        try
          if exists menu "Export" of exportMenuItem then
            set exportMenu to menu "Export" of exportMenuItem
            exit repeat
          end if
        end try
        delay 0.1
      end repeat
      if exportMenu is missing value then error "FINAL_CUT_CANONICAL_EXPORT_MENU_UNAVAILABLE: Export submenu was not exposed"
      set exportCommand to my findMenuItem(exportMenu, {"XML…", "XML..."}, 10, "FINAL_CUT_CANONICAL_EXPORT_MENU_UNAVAILABLE: Export XML command was not exposed")
    end try
    perform action "AXPress" of exportCommand
    set exportWindow to my findWindow(finalCut, {"Export XML", "XML"}, 15, "FINAL_CUT_CANONICAL_EXPORT_WINDOW_UNAVAILABLE: Export XML window did not appear")
    my pressButtonIfPresent(exportWindow, {"Next…", "Next...", "Export"})
    delay 0.2
    set saveWindow to my findWindow(finalCut, {"Save", "Export XML"}, 15, "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE: XML save window did not appear")
    keystroke "g" using {command down, shift down}
    repeat 50 times
      try
        if exists sheet 1 of saveWindow then exit repeat
      end try
      delay 0.1
    end repeat
    if not (exists sheet 1 of saveWindow) then error "FINAL_CUT_CANONICAL_SAVE_WINDOW_UNAVAILABLE: save path sheet did not appear"
    set pathSheet to sheet 1 of saveWindow
    if (count of text fields of pathSheet) is 0 then error "FINAL_CUT_CANONICAL_SAVE_PATH_UNAVAILABLE: save path field did not appear"
    set value of text field 1 of pathSheet to ${appleScriptString(exportPath)}
    key code 36
    delay 0.2
    if exists button "Save" of saveWindow then click button "Save" of saveWindow
    delay 0.2
    if exists button "Replace" of saveWindow then click button "Replace" of saveWindow
    return "canonical-export-requested"
  end tell
end tell`;
}

export function createFinalCutNativeTargetResolver(
  native: Pick<NativeFinalCutEditor, "searchMedia" | "locateOccurrence">,
): CanonicalNativeTargetResolver {
  return async (clip, snapshot) => {
    if (!clip.mediaId) throw new Error(`TARGET_MISMATCH: occurrence ${clip.id} has no media binding`);
    const media = snapshot.media.find(({ mediaId }) => mediaId === clip.mediaId);
    if (!media?.source) throw new Error(`TARGET_MISMATCH: media ${clip.mediaId} has no source binding`);
    const query = sourceBasename(media.source);
    if (!query) throw new Error(`TARGET_MISMATCH: media ${clip.mediaId} has no searchable source basename`);

    const matches = (await native.searchMedia(query)).filter((match) => match.name.toLocaleLowerCase() === query.toLocaleLowerCase());
    if (matches.length === 0) throw new Error(`TARGET_MISMATCH: Final Cut Browser has no exact media match for ${query}`);
    if (matches.length > 1) throw new Error(`AMBIGUOUS_PROJECT_TARGET: Final Cut Browser has multiple exact media matches for ${query}`);
    const match = matches[0]!;
    if (!match.sourceIdentity) throw new Error("TARGET_MISMATCH: exact Browser media has no stable source identity");

    const located = await native.locateOccurrence(match.handle);
    if (located.status === "none" || located.occurrences.length === 0) {
      throw new Error(`TARGET_MISMATCH: Final Cut timeline has no occurrence for ${query}`);
    }
    if (located.status !== "unique" || located.occurrences.length !== 1) {
      throw new Error(`AMBIGUOUS_PROJECT_TARGET: Final Cut timeline has multiple occurrences for ${query}`);
    }
    const occurrence = located.occurrences[0]!;
    const occurrenceIdentity = occurrence.identity ?? occurrence.nativeIdentity;
    if (!occurrenceIdentity) {
      throw new Error(`TARGET_MISMATCH: native occurrence has no stable identity for ${clip.id}`);
    }
    if (!occurrence.sequenceId) {
      throw new Error(`TARGET_MISMATCH: native occurrence has no stable sequence identity for ${clip.id}`);
    }
    if (occurrence.sequenceId !== snapshot.timeline.id) {
      throw new Error(`TARGET_MISMATCH: native occurrence sequence changed for ${clip.id}`);
    }
    if (occurrence.sourceIdentity && occurrence.sourceIdentity !== match.sourceIdentity) {
      throw new Error(`TARGET_MISMATCH: native occurrence source identity changed for ${clip.id}`);
    }
    if (!occurrence.start || !occurrence.duration || !clip.startTime || !clip.durationTime) {
      throw new Error(`TARGET_MISMATCH: exact timeline coordinates are unavailable for ${clip.id}`);
    }
    if (!sameRationalText(occurrence.start, clip.startTime) || !sameRationalText(occurrence.duration, clip.durationTime)) {
      throw new Error(`TARGET_MISMATCH: native occurrence coordinates changed for ${clip.id}`);
    }
  };
}

interface PendingNativeOperation {
  operationId: string;
  beforeDigest: string;
  beforeRevision: ContextRevision;
  afterRevision: ContextRevision;
}

/**
 * Canonical provider for the headed Final Cut UI path.
 *
 * `readSnapshot` must export the currently active Final Cut project through
 * Final Cut itself. It is deliberately injected so the provider cannot fall
 * back to an arbitrary FCPXML artifact. Native mutation is separately bound
 * to one exported occurrence before Accessibility is allowed to edit it.
 */
export class FinalCutCanonicalNativeProvider implements EditorPort, LiveEditorStatePort {
  private readonly live: FinalCutCanonicalNativeProviderOptions["live"];
  private readonly native: CanonicalNativeMutationPort;
  private readonly readSnapshotSource: () => Promise<ProjectSnapshot>;
  private readonly resolveTarget: CanonicalNativeTargetResolver;
  private readonly backgroundCatalog?: FinalCutBackgroundCatalogProvider;
  private lastDigest?: string;
  private lastSnapshot?: ProjectSnapshot;
  private revisionSequence = 0;
  private revision?: ContextRevision;
  private pending?: PendingNativeOperation;

  public constructor(options: FinalCutCanonicalNativeProviderOptions) {
    this.live = options.live;
    this.native = options.native;
    this.readSnapshotSource = options.readSnapshot;
    this.resolveTarget = options.resolveTarget;
    this.backgroundCatalog = options.backgroundCatalog;
  }

  public async getIdentity(): Promise<EditorIdentity> {
    const identity = await this.live.getIdentity();
    return { ...identity, backend: "final-cut-native-canonical" };
  }

  public async getCapabilities(options: CapabilityInspectionOptions = {}): Promise<RuntimeCapabilities> {
    const backgroundCatalog = await this.resolveBackgroundCatalog();
    const snapshotProbe = backgroundCatalog && options.probeCanonicalSnapshot !== false
      ? await this.probeCanonicalSnapshot()
      : {
          available: false as const,
          reason: backgroundCatalog
            ? "canonical snapshot availability was not checked"
            : "canonical timeline snapshot requires a background project catalog",
        };
    const canonicalSnapshotCapability = snapshotProbe.available
      ? true
      : unavailableCanonicalSnapshot(snapshotProbe.reason);
    const capabilities = withCapabilityFamilies({
      editor: {
        projectRead: snapshotProbe.available,
        timelineSnapshotRead: snapshotProbe.available,
        timelineWrite: snapshotProbe.available,
        timelineArtifactWrite: false,
        readAfterWrite: snapshotProbe.available,
        incrementalChanges: true,
        rollback: snapshotProbe.available,
        assetDiscovery: false,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        playbackControl: false,
        projectCatalogRead: Boolean(backgroundCatalog),
        projectSelection: false,
        projectSelectionMode: "unavailable",
        backgroundLibraryInspection: Boolean(backgroundCatalog),
        compositeTransactions: snapshotProbe.available,
        semanticOperations: {
          "rename-clip": snapshotProbe.available,
          "trim-clip": snapshotProbe.available && Boolean(this.native.trimSelectedClipToRange),
          "add-marker": snapshotProbe.available && Boolean(this.native.addMarkerAtTime),
          "ripple-delete": snapshotProbe.available && Boolean(this.native.rippleDeleteRange),
          "set-gain": snapshotProbe.available && Boolean(this.native.setSelectedClipGain),
        },
      },
      analyzers: {
        speechTranscribe: false,
        speechVad: false,
        audioLoudness: false,
        visualTrack: false,
      },
    }, {
      backend: "final-cut-native-canonical",
      connectionBackend: "workflow-extension-ipc",
      canonicalDocument: {
        read: canonicalSnapshotCapability,
        write: canonicalSnapshotCapability,
        artifactWrite: false,
      },
      observation: {
        library: this.backgroundCatalog
          ? {
              available: true,
              backend: this.backgroundCatalog.backend ?? "final-cut-background-library",
              guarantee: "observed" as const,
            }
          : false,
      },
    });
    const readiness = assessCanonicalLiveReadiness(capabilities);
    if (readiness.ready) return capabilities;
    return withCapabilityFamilies({
      ...capabilities,
      editor: {
        ...capabilities.editor,
        projectRead: false,
        timelineSnapshotRead: false,
        timelineWrite: false,
        readAfterWrite: false,
        rollback: false,
        compositeTransactions: false,
      },
    });
  }

  private async probeCanonicalSnapshot(): Promise<{ available: true } | { available: false; reason: string }> {
    try {
      await this.readSnapshotSource();
      return { available: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        reason: `canonical snapshot provider unavailable: ${detail}`,
      };
    }
  }

  public async read(): Promise<ProjectSnapshot> {
    return this.readProject();
  }

  public async readProject(): Promise<ProjectSnapshot> {
    const snapshot = await this.readSnapshotSource();
    await this.assertActiveTarget(snapshot);
    const digest = canonicalSnapshotDigest(snapshot);
    if (digest !== this.lastDigest || !this.revision) {
      this.revisionSequence = Math.max(this.revisionSequence + 1, snapshot.revision.sequence + 1);
      this.lastDigest = digest;
      this.revision = {
        id: `canonical:${digest}`,
        sequence: this.revisionSequence,
        timestamp: new Date().toISOString(),
      };
    }
    this.lastSnapshot = { ...snapshot, revision: this.revision };
    return structuredClone(this.lastSnapshot);
  }

  public async previewTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<ProjectSnapshot> {
    const before = await this.readProject();
    assertSameRevision(expectedRevision, before.revision);
    const operation = supportedCanonicalOperation(operations);
    assertCanonicalOperationAvailable(this.native, operation);
    const preview = projectCanonicalOperation(before, operation);
    preview.revision = previewRevision(preview, before.revision);
    return preview;
  }

  public async applyTransaction(
    operations: WorkflowOperation[],
    expectedRevision: ContextRevision,
  ): Promise<void> {
    const operation = supportedCanonicalOperation(operations);
    await this.apply(operation, expectedRevision);
  }

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    const before = await this.readProject();
    assertSameRevision(expectedRevision, before.revision);
    const supported = supportedCanonicalOperation([operation]);
    const markerRange = supported.type === "add-marker" ? canonicalMarkerRange(before, supported.marker) : undefined;
    const clipTarget = supported.type === "rename-clip" || supported.type === "trim-clip" || supported.type === "set-gain"
      ? canonicalTargetForOperation(before, supported)
      : undefined;
    const clip = clipTarget?.clip;
    const rippleTarget = supported.type === "ripple-delete" ? canonicalTargetForOperation(before, supported) : undefined;
    const targetClip = clip;
    const trimDuration = supported.type === "trim-clip"
      ? validateCanonicalTrim(supported, clip!, before)
      : undefined;

    const timelineTarget = createTimelineTarget(before, {
      ...(targetClip ? { occurrenceId: targetClip.id, mediaId: targetClip.mediaId } : {}),
      ...(rippleTarget?.range ? { range: rippleTarget.range } : {}),
      ...(markerRange && compareRational(markerRange.duration, zeroRational()) > 0
        ? { range: { start: markerRange.start, end: markerRange.end } }
        : {}),
    });
    resolveTimelineTarget(before, timelineTarget);
    if (targetClip) await this.resolveTarget(targetClip, before);
    assertCanonicalOperationAvailable(this.native, supported);
    const nativeResult = supported.type === "rename-clip"
      ? await this.native.renameSelectedClip(supported.name)
      : supported.type === "trim-clip"
        ? await this.native.trimSelectedClipToRange!({
          start: structuredClone(clip!.startTime),
          end: addRational(clip!.startTime, trimDuration!),
        })
        : supported.type === "ripple-delete"
          ? await this.native.rippleDeleteRange!(rippleTarget!.range!)
          : supported.type === "set-gain"
            ? await this.native.setSelectedClipGain!(supported.gainDb)
            : await this.native.addMarkerAtTime!({
              start: markerRange!.start,
              duration: markerRange!.duration,
              name: supported.marker.name,
            });
    if (!nativeResult.operationId || !nativeResult.undoAvailable) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_UNAVAILABLE: native edit did not expose Undo");
    }
    this.pending = {
      operationId: nativeResult.operationId,
      beforeDigest: canonicalSnapshotDigest(before),
      beforeRevision: before.revision,
      afterRevision: before.revision,
    };

    try {
      const after = await this.readProject();
      if (supported.type === "rename-clip") {
        const readback = verifyCanonicalReadback(before, after, timelineTarget, {
          validateDiff: (diff) => {
            const afterClip = after.timeline.clips.find(({ id }) => id === supported.clipId);
            const changed = diff.modified.filter(({ itemId }) => itemId === supported.clipId);
            if (!afterClip || afterClip.name !== supported.name
              || diff.added.length !== 0
              || diff.removed.length !== 0
              || diff.modified.length !== 1
              || changed.length !== 1
              || diff.markerChanges.length !== 0
              || diff.storyElementChanges.length !== 0
              || diff.captionChanges.length !== 0
              || diff.mediaChanges.length !== 0) {
              throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: renamed occurrence was not read back as a rename-only diff from Final Cut");
            }
          },
        });
        if (readback.beforeDigest !== this.pending.beforeDigest) {
          throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: canonical before digest changed during verification");
        }
      } else if (supported.type === "trim-clip") {
        const afterClip = after.timeline.clips.find(({ id }) => id === supported.clipId);
        if (!afterClip || !sameRational(afterClip.startTime, clip!.startTime)
          || !sameRational(afterClip.durationTime, trimDuration!)) {
          throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: trimmed occurrence range was not read back from Final Cut");
        }
      } else if (supported.type === "set-gain") {
        const afterClip = after.timeline.clips.find(({ id }) => id === supported.clipId);
        if (!afterClip || (afterClip.gainDb ?? 0) !== supported.gainDb) {
          throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: gain was not read back from Final Cut");
        }
      } else if (supported.type === "ripple-delete") {
        assertRippleDeleteReadback(before, after, rippleTarget!.clip, rippleTarget!.range!);
      } else {
        assertMarkerReadback(before, after, supported.marker, markerRange!);
      }
      if (canonicalSnapshotDigest(after) === this.pending.beforeDigest) {
        throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: native edit did not change the canonical digest");
      }
      assertTimelineTargetReadAfterWrite(
        timelineTarget,
        before,
        after,
        supported.type === "ripple-delete" ? { allowOccurrenceRemoval: true } : undefined,
      );
      this.pending.afterRevision = after.revision;
      return after.revision;
    } catch (error) {
      try {
        await recoverCanonicalNativeMutation({
          operationId: nativeResult.operationId,
          before,
          target: timelineTarget,
          undo: this.native.undo,
          readSnapshot: () => this.readProject(),
        });
      } catch (rollbackError) {
        const original = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`FINAL_CUT_CANONICAL_ROLLBACK_FAILED: ${rollback}; original error: ${original}`);
      } finally {
        this.pending = undefined;
      }
      throw error;
    }
  }

  public async restore(snapshot: ProjectSnapshot, expectedRevision: ContextRevision): Promise<void> {
    const current = await this.readProject();
    assertSameRevision(expectedRevision, current.revision);
    const pending = this.pending;
    if (!pending || !sameRevision(pending.afterRevision, expectedRevision)) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_STALE: native operation is not the current canonical edit");
    }
    if (canonicalSnapshotDigest(snapshot) !== pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_TARGET_MISMATCH: rollback target differs from the applied edit");
    }
    const undone = await this.native.undo(pending.operationId);
    if (!undone.undone || undone.verification?.verified !== true) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_FAILED: Final Cut did not verify native Undo");
    }
    const restored = await this.readProject();
    if (canonicalSnapshotDigest(restored) !== pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_FAILED: restored canonical digest does not match the pre-edit state");
    }
    this.pending = undefined;
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const backgroundCatalog = await this.resolveBackgroundCatalog();
    if (!backgroundCatalog) {
      throw new CapabilityUnavailableError("project.list", "editor.projectCatalogRead", {
        available: false,
        backend: "final-cut-native-canonical",
        guarantee: "none",
        unavailableReason: "background project catalog is unavailable; canonical timeline snapshot export (File > Export XML) requires a headed Final Cut UI",
      });
    }
    return this.readBackgroundCatalog(backgroundCatalog);
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectSelectionResult> {
    throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project selection is not exposed by the background provider");
  }

  public async readLiveState(): Promise<EditorLiveState> {
    return this.live.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    return this.live.liveChangesSince(revision, waitMs);
  }

  private async assertActiveTarget(snapshot: ProjectSnapshot): Promise<void> {
    const live = await this.live.readLiveState();
    if (!live.project || live.project.id !== snapshot.projectId) {
      throw new Error(`TARGET_MISMATCH: active project identity ${live.project?.id ?? "<unavailable>"} does not match exported project ${snapshot.projectId}`);
    }
    if (live.project.name !== snapshot.projectName) {
      throw new Error(`TARGET_MISMATCH: exported project ${snapshot.projectName} is not active Final Cut project ${live.project.name}`);
    }
    if (!live.sequence || live.sequence.id !== snapshot.timeline.id) {
      throw new Error(`TARGET_MISMATCH: active sequence identity ${live.sequence?.id ?? "<unavailable>"} does not match exported sequence ${snapshot.timeline.id}`);
    }
    if (live.sequence.name !== snapshot.timeline.name) {
      throw new Error(`TARGET_MISMATCH: exported sequence ${snapshot.timeline.name} is not active Final Cut sequence ${live.sequence.name}`);
    }
  }

  private async resolveBackgroundCatalog(): Promise<FinalCutBackgroundCatalogProvider | undefined> {
    if (this.backgroundCatalog) return this.backgroundCatalog;
    if (!this.live.listProjects || !this.live.getCapabilities) return undefined;
    try {
      const capabilities = await this.live.getCapabilities();
      if (!capabilities.editor.projectCatalogRead) return undefined;
      const identity = await this.live.getIdentity();
      return {
        backend: identity.backend,
        listProjects: () => this.live.listProjects!(),
      };
    } catch {
      return undefined;
    }
  }

  private async readBackgroundCatalog(provider: FinalCutBackgroundCatalogProvider): Promise<ProjectCatalog> {
    const before = await this.readLiveStateSafely();
    const catalog = await provider.listProjects();
    validateProjectCatalog(catalog);
    const after = await this.readLiveStateSafely();
    const liveIdentity = before && after ? await this.live.getIdentity() : undefined;
    return reconcileProjectCatalog(catalog, {
      ...(before && after ? { before, after } : {}),
      provenance: {
        catalog: {
          source: "background-library",
          backend: provider.backend ?? "final-cut-background-library",
          guarantee: "observed",
        },
        ...(liveIdentity ? {
          live: {
            source: "live-socket",
            backend: liveIdentity.backend,
            guarantee: "observed" as const,
          },
        } : {}),
        selection: {
          available: false,
          mode: "unavailable",
          unavailableReason: "project selection is not exposed by the background provider",
        },
      },
    });
  }

  private async readLiveStateSafely(): Promise<EditorLiveState | undefined> {
    try {
      return await this.live.readLiveState();
    } catch {
      return undefined;
    }
  }
}

type CanonicalOperation = Extract<WorkflowOperation, { type: "rename-clip" | "trim-clip" | "add-marker" | "ripple-delete" | "set-gain" }>;

function supportedCanonicalOperation(operations: WorkflowOperation[]): CanonicalOperation {
  if (operations.length !== 1 || (operations[0]?.type !== "rename-clip" && operations[0]?.type !== "trim-clip" && operations[0]?.type !== "add-marker" && operations[0]?.type !== "ripple-delete" && operations[0]?.type !== "set-gain")) {
    throw new Error("CAPABILITY_UNAVAILABLE: final-cut native canonical provider supports one rename-clip, trim-clip, add-marker, ripple-delete, or set-gain transaction");
  }
  return operations[0].type === "rename-clip"
    ? validateCanonicalRename(operations[0])
    : operations[0].type === "add-marker"
      ? validateCanonicalMarker(operations[0])
      : operations[0].type === "set-gain"
        ? validateCanonicalGain(operations[0])
        : operations[0];
}

interface CanonicalOperationTarget {
  clip: ProjectSnapshot["timeline"]["clips"][number];
  range?: { start: RationalTime; end: RationalTime };
}

function canonicalTargetForOperation(
  snapshot: ProjectSnapshot,
  operation: Extract<CanonicalOperation, { type: "rename-clip" | "trim-clip" | "ripple-delete" | "set-gain" }>,
): CanonicalOperationTarget {
  if (operation.type === "rename-clip" || operation.type === "trim-clip" || operation.type === "set-gain") {
    const clip = snapshot.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!clip) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);
    return { clip };
  }
  if (operation.timelineId !== snapshot.timeline.id) {
    throw new Error(`TIMELINE_NOT_FOUND: ${operation.timelineId}`);
  }
  const range = canonicalRippleRange(snapshot, operation.range);
  const candidates = snapshot.timeline.clips.filter((candidate) => {
    const end = addRational(candidate.startTime, candidate.durationTime);
    return compareRational(candidate.startTime, range.end) < 0 && compareRational(end, range.start) > 0;
  });
  if (candidates.length === 0) {
    throw new Error("TARGET_NOT_FOUND: ripple-delete range does not intersect a timeline occurrence");
  }
  if (candidates.length > 1) {
    throw new Error("AMBIGUOUS_TIMELINE_TARGET: ripple-delete range intersects multiple timeline occurrences");
  }
  const clip = candidates[0]!;
  const clipEnd = addRational(clip.startTime, clip.durationTime);
  if (compareRational(range.start, clip.startTime) < 0 || compareRational(range.end, clipEnd) > 0) {
    throw new Error("INVALID_OPERATION: ripple-delete range must fit inside one timeline occurrence");
  }
  if (compareRational(range.start, clip.startTime) > 0 && compareRational(range.end, clipEnd) < 0) {
    throw new Error("INVALID_OPERATION: ripple-delete middle-of-clip range requires a source-preserving split");
  }
  return { clip, range };
}

function projectCanonicalOperation(snapshot: ProjectSnapshot, operation: CanonicalOperation): ProjectSnapshot {
  if (operation.type === "rename-clip" || operation.type === "set-gain") {
    const { clip } = canonicalTargetForOperation(snapshot, operation);
    return {
      ...structuredClone(snapshot),
      timeline: {
        ...structuredClone(snapshot.timeline),
        clips: snapshot.timeline.clips.map((candidate) => {
          if (candidate.id !== clip.id) return candidate;
          return operation.type === "rename-clip"
            ? { ...candidate, name: operation.name }
            : { ...candidate, gainDb: operation.gainDb };
        }),
      },
    };
  }
  if (operation.type === "trim-clip") {
    const preview = structuredClone(snapshot);
    const { clip } = canonicalTargetForOperation(preview, operation);
    const trimDuration = validateCanonicalTrim(operation, clip, preview);
    const updatedClip = {
      ...clip,
      duration: rationalSeconds(trimDuration),
      durationTime: trimDuration,
    };
    preview.timeline.clips = preview.timeline.clips.map((candidate) => (
      candidate.id === clip.id ? updatedClip : candidate
    ));
    preview.timeline.storyElements = preview.timeline.storyElements.map((element) => (
      element.id === clip.id
        ? { ...element, duration: updatedClip.duration, durationTime: updatedClip.durationTime }
        : element
    ));
    const oldTimelineEnd = snapshot.timeline.durationTime
      ? addRational(clip.startTime, clip.durationTime)
      : undefined;
    if (oldTimelineEnd && snapshot.timeline.durationTime && sameRational(oldTimelineEnd, snapshot.timeline.durationTime)) {
      const nextTimelineEnd = addRational(clip.startTime, trimDuration);
      preview.timeline.durationTime = nextTimelineEnd;
      preview.timeline.duration = rationalSeconds(nextTimelineEnd);
    }
    return preview;
  }
  if (operation.type === "ripple-delete") {
    const target = canonicalTargetForOperation(snapshot, operation);
    return projectCanonicalRippleDelete(snapshot, target.range!);
  }
  const range = canonicalMarkerRange(snapshot, operation.marker);
  if (snapshot.timeline.markers.some(({ id }) => id === operation.marker.id)) {
    throw new Error(`MARKER_ALREADY_EXISTS: ${operation.marker.id}`);
  }
  const marker = {
    ...structuredClone(operation.marker),
    start: rationalSeconds(range.start),
    duration: rationalSeconds(range.duration),
    startTime: range.start,
    durationTime: range.duration,
  };
  return {
    ...structuredClone(snapshot),
    timeline: {
      ...structuredClone(snapshot.timeline),
      markers: [...snapshot.timeline.markers, marker],
    },
  };
}

function projectCanonicalRippleDelete(
  snapshot: ProjectSnapshot,
  range: { start: RationalTime; end: RationalTime },
): ProjectSnapshot {
  const duration = subtractRational(range.end, range.start);
  const clips = snapshot.timeline.clips.flatMap((clip) => projectClipAfterRippleDelete(clip, range, duration));
  const storyElements = snapshot.timeline.storyElements.flatMap((element) => projectStoryElementAfterRippleDelete(element, range, duration));
  const markers = snapshot.timeline.markers.flatMap((marker) => projectMarkerAfterRippleDelete(marker, range, duration));
  const captions = snapshot.timeline.captions.flatMap((caption) => projectCaptionAfterRippleDelete(caption, range, duration));
  const timelineDuration = subtractRational(snapshot.timeline.durationTime ?? secondsToRational(snapshot.timeline.duration, snapshot.timeline.frameDuration), duration);
  return {
    ...structuredClone(snapshot),
    timeline: {
      ...structuredClone(snapshot.timeline),
      duration: rationalSeconds(timelineDuration),
      durationTime: timelineDuration,
      clips,
      storyElements,
      markers,
      captions,
    },
  };
}

function projectClipAfterRippleDelete(
  clip: ProjectSnapshot["timeline"]["clips"][number],
  range: { start: RationalTime; end: RationalTime },
  removedDuration: RationalTime,
): ProjectSnapshot["timeline"]["clips"] {
  const clipEnd = addRational(clip.startTime, clip.durationTime);
  if (compareRational(clipEnd, range.start) <= 0) return [structuredClone(clip)];
  if (compareRational(clip.startTime, range.end) >= 0) {
    const startTime = subtractRational(clip.startTime, removedDuration);
    return [{ ...structuredClone(clip), start: rationalSeconds(startTime), startTime }];
  }
  if (compareRational(clip.startTime, range.start) < 0) {
    const duration = subtractRational(range.start, clip.startTime);
    return compareRational(duration, zeroRational()) > 0
      ? [{ ...structuredClone(clip), duration: rationalSeconds(duration), durationTime: duration }]
      : [];
  }
  if (compareRational(clipEnd, range.end) > 0) {
    const duration = subtractRational(clipEnd, range.end);
    return [{
      ...structuredClone(clip),
      start: rationalSeconds(range.start),
      startTime: structuredClone(range.start),
      duration: rationalSeconds(duration),
      durationTime: duration,
    }];
  }
  return [];
}

function projectStoryElementAfterRippleDelete(
  element: ProjectSnapshot["timeline"]["storyElements"][number],
  range: { start: RationalTime; end: RationalTime },
  removedDuration: RationalTime,
): ProjectSnapshot["timeline"]["storyElements"] {
  if (!element.startTime || !element.durationTime) return [structuredClone(element)];
  const elementEnd = addRational(element.startTime, element.durationTime);
  if (compareRational(elementEnd, range.start) <= 0) return [structuredClone(element)];
  if (compareRational(element.startTime, range.end) >= 0) {
    const startTime = subtractRational(element.startTime, removedDuration);
    return [{ ...structuredClone(element), start: rationalSeconds(startTime), startTime }];
  }
  if (compareRational(element.startTime, range.start) < 0) {
    const duration = subtractRational(range.start, element.startTime);
    return compareRational(duration, zeroRational()) > 0
      ? [{ ...structuredClone(element), duration: rationalSeconds(duration), durationTime: duration }]
      : [];
  }
  if (compareRational(elementEnd, range.end) > 0) {
    const duration = subtractRational(elementEnd, range.end);
    return [{
      ...structuredClone(element),
      start: rationalSeconds(range.start),
      startTime: structuredClone(range.start),
      duration: rationalSeconds(duration),
      durationTime: duration,
    }];
  }
  return [];
}

function projectMarkerAfterRippleDelete(
  marker: ProjectSnapshot["timeline"]["markers"][number],
  range: { start: RationalTime; end: RationalTime },
  removedDuration: RationalTime,
): ProjectSnapshot["timeline"]["markers"] {
  const start = marker.startTime ?? secondsToRational(marker.start, undefined);
  const duration = marker.durationTime ?? secondsToRational(marker.duration, undefined);
  const end = addRational(start, duration);
  if (compareRational(end, range.start) <= 0) return [structuredClone(marker)];
  if (compareRational(start, range.end) >= 0) {
    const shifted = subtractRational(start, removedDuration);
    return [{ ...structuredClone(marker), start: rationalSeconds(shifted), startTime: shifted }];
  }
  return [];
}

function projectCaptionAfterRippleDelete(
  caption: ProjectSnapshot["timeline"]["captions"][number],
  range: { start: RationalTime; end: RationalTime },
  removedDuration: RationalTime,
): ProjectSnapshot["timeline"]["captions"] {
  const start = caption.startTime ?? secondsToRational(caption.start, undefined);
  const duration = caption.durationTime ?? secondsToRational(caption.duration, undefined);
  const end = addRational(start, duration);
  if (compareRational(end, range.start) <= 0) return [structuredClone(caption)];
  if (compareRational(start, range.end) >= 0) {
    const shifted = subtractRational(start, removedDuration);
    return [{ ...structuredClone(caption), start: rationalSeconds(shifted), startTime: shifted }];
  }
  return [];
}

function canonicalRippleRange(snapshot: ProjectSnapshot, range: TimeRange): { start: RationalTime; end: RationalTime } {
  const frameDuration = snapshot.timeline.frameDuration;
  if (!frameDuration) throw new Error("CAPABILITY_UNAVAILABLE: ripple-delete requires sequence frame duration");
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
    throw new Error("INVALID_OPERATION: ripple-delete range must be finite and increasing");
  }
  const start = range.startTime ?? secondsToRational(range.start, frameDuration);
  const duration = range.durationTime ?? secondsToRational(range.end - range.start, frameDuration);
  if (Math.abs(rationalSeconds(start) - range.start) > 0.000001
    || Math.abs(rationalSeconds(duration) - (range.end - range.start)) > 0.000001) {
    throw new Error("INVALID_OPERATION: ripple-delete rational range disagrees with its numeric coordinates");
  }
  if (compareRational(duration, zeroRational()) <= 0) {
    throw new Error("INVALID_OPERATION: ripple-delete range must have positive duration");
  }
  const end = addRational(start, duration);
  if (!isFrameAligned(start, zeroRational(), frameDuration) || !isFrameAligned(end, zeroRational(), frameDuration)) {
    throw new Error("INVALID_OPERATION: ripple-delete range must be frame-aligned");
  }
  const timelineDuration = snapshot.timeline.durationTime ?? secondsToRational(snapshot.timeline.duration, frameDuration);
  if (compareRational(start, zeroRational()) < 0 || compareRational(end, timelineDuration) > 0) {
    throw new Error("INVALID_OPERATION: ripple-delete range must fit inside the active timeline");
  }
  return { start, end };
}

function assertRippleDeleteReadback(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  targetClip: ProjectSnapshot["timeline"]["clips"][number],
  range: { start: RationalTime; end: RationalTime },
): void {
  const expected = projectCanonicalRippleDelete(before, range);
  if (canonicalSnapshotDigest(normalizeRippleSnapshot(after)) !== canonicalSnapshotDigest(normalizeRippleSnapshot(expected))) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: ripple-delete readback differed from the exact canonical projection");
  }
  if (!after.timeline.durationTime || !expected.timeline.durationTime
    || !sameRational(after.timeline.durationTime, expected.timeline.durationTime)) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: ripple-delete duration was not read back exactly");
  }
  const expectedTarget = expected.timeline.clips.find(({ id }) => id === targetClip.id);
  const actualTarget = after.timeline.clips.find(({ id }) => id === targetClip.id);
  if (Boolean(expectedTarget) !== Boolean(actualTarget)) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: ripple-delete target occurrence changed unexpectedly");
  }
  if (expectedTarget && actualTarget && (
    !sameRational(expectedTarget.startTime, actualTarget.startTime)
    || !sameRational(expectedTarget.durationTime, actualTarget.durationTime)
  )) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: ripple-delete target range was not read back exactly");
  }
  for (const expectedClip of expected.timeline.clips) {
    const beforeClip = before.timeline.clips.find(({ id }) => id === expectedClip.id);
    if (!beforeClip || compareRational(beforeClip.startTime, range.end) < 0) continue;
    const actualClip = after.timeline.clips.find(({ id }) => id === expectedClip.id);
    if (!actualClip || !sameRational(actualClip.startTime, expectedClip.startTime)) {
      throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: ripple-delete did not preserve the shifted occurrence coordinates");
    }
  }
}

function normalizeRippleSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  const normalized = structuredClone(snapshot);
  normalized.timeline.durationTime = normalized.timeline.durationTime
    ? normalizeRationalTime(normalized.timeline.durationTime)
    : normalized.timeline.durationTime;
  normalized.timeline.clips = normalized.timeline.clips.map((clip) => ({
    ...clip,
    startTime: normalizeRationalTime(clip.startTime),
    durationTime: normalizeRationalTime(clip.durationTime),
  }));
  normalized.timeline.storyElements = normalized.timeline.storyElements.map((element) => ({
    ...element,
    ...(element.startTime ? { startTime: normalizeRationalTime(element.startTime) } : {}),
    ...(element.durationTime ? { durationTime: normalizeRationalTime(element.durationTime) } : {}),
  }));
  normalized.timeline.markers = normalized.timeline.markers.map((marker) => ({
    ...marker,
    ...(marker.startTime ? { startTime: normalizeRationalTime(marker.startTime) } : {}),
    ...(marker.durationTime ? { durationTime: normalizeRationalTime(marker.durationTime) } : {}),
  }));
  normalized.timeline.captions = normalized.timeline.captions.map((caption) => ({
    ...caption,
    ...(caption.startTime ? { startTime: normalizeRationalTime(caption.startTime) } : {}),
    ...(caption.durationTime ? { durationTime: normalizeRationalTime(caption.durationTime) } : {}),
  }));
  return normalized;
}

function normalizeRationalTime(value: RationalTime): RationalTime {
  const [numerator, denominator] = rationalParts(value);
  return normalizeRational(numerator, denominator);
}

function canonicalMarkerRange(snapshot: ProjectSnapshot, marker: Extract<CanonicalOperation, { type: "add-marker" }>["marker"]): { start: RationalTime; duration: RationalTime; end: RationalTime } {
  if (!marker.id.trim() || !marker.name.trim()) throw new Error("INVALID_OPERATION: marker id and name are required");
  if (!Number.isFinite(marker.start) || !Number.isFinite(marker.duration) || marker.start < 0 || marker.duration < 0) {
    throw new Error("INVALID_OPERATION: marker position and duration must be finite and non-negative");
  }
  const frameDuration = snapshot.timeline.frameDuration;
  if (!frameDuration) throw new Error("CAPABILITY_UNAVAILABLE: marker requires sequence frame duration");
  const start = marker.startTime ?? secondsToRational(marker.start, frameDuration);
  const duration = marker.durationTime ?? secondsToRational(marker.duration, frameDuration);
  if (Math.abs(rationalSeconds(start) - marker.start) > 0.000001
    || Math.abs(rationalSeconds(duration) - marker.duration) > 0.000001) {
    throw new Error("INVALID_OPERATION: marker rational coordinates disagree with numeric coordinates");
  }
  const end = addRational(start, duration);
  const timelineDuration = snapshot.timeline.durationTime ?? secondsToRational(snapshot.timeline.duration, frameDuration);
  if (!isFrameAligned(start, zeroRational(), frameDuration) || !isFrameAligned(duration, zeroRational(), frameDuration)
    || compareRational(end, timelineDuration) > 0) {
    throw new Error("INVALID_OPERATION: marker must be frame-aligned and fit inside the active timeline");
  }
  return { start, duration, end };
}

function assertMarkerReadback(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  marker: Extract<CanonicalOperation, { type: "add-marker" }>["marker"],
  range: { start: RationalTime; duration: RationalTime },
): void {
  const matches = after.timeline.markers.filter((candidate) => candidate.name === marker.name
    && sameRational(candidate.startTime ?? secondsToRational(candidate.start), range.start)
    && sameRational(candidate.durationTime ?? secondsToRational(candidate.duration), range.duration));
  const beforeMatches = before.timeline.markers.filter((candidate) => candidate.name === marker.name
    && sameRational(candidate.startTime ?? secondsToRational(candidate.start), range.start)
    && sameRational(candidate.durationTime ?? secondsToRational(candidate.duration), range.duration));
  if (matches.length !== beforeMatches.length + 1) {
    throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: native marker was not uniquely read back at the requested rational position");
  }
}

function assertCanonicalOperationAvailable(
  native: CanonicalNativeMutationPort,
  operation: CanonicalOperation,
): void {
  if (operation.type === "trim-clip" && !native.trimSelectedClipToRange) {
    throw new Error("CAPABILITY_UNAVAILABLE: final-cut native canonical trim");
  }
}

function parseRationalTime(value: RationalTime, label: string): { value: bigint; timescale: bigint } {
  if (!value || !/^-?\d+$/.test(value.value) || !/^\d+$/.test(value.timescale) || value.timescale === "0") {
    throw new Error(`${label} must be an integer rational`);
  }
  return { value: BigInt(value.value), timescale: BigInt(value.timescale) };
}

function validateCanonicalTrim(
  operation: Extract<CanonicalOperation, { type: "trim-clip" }>,
  clip: ProjectSnapshot["timeline"]["clips"][number],
  snapshot: ProjectSnapshot,
): RationalTime {
  if (!operation.durationTime) {
    throw new Error("INVALID_OPERATION: native trim requires an exact durationTime");
  }
  const duration = parseRationalTime(operation.durationTime, "INVALID_OPERATION: trim durationTime");
  const currentDuration = parseRationalTime(clip.durationTime, "INVALID_PROJECT_STATE: clip durationTime");
  if (duration.value <= 0n || compareRational(operation.durationTime, clip.durationTime) >= 0) {
    throw new Error("INVALID_OPERATION: native trim duration must be shorter than the current occurrence");
  }
  if (!Number.isFinite(operation.duration)
    || Math.abs(operation.duration - Number(duration.value) / Number(duration.timescale)) > 1e-9) {
    throw new Error("INVALID_OPERATION: trim duration and durationTime must agree");
  }
  const frame = snapshot.timeline.frameDuration;
  if (!frame || !isFrameAligned(operation.durationTime, zeroRational(), frame)) {
    throw new Error("FRAME_ALIGNMENT_REQUIRED: native trim duration must align to the sequence frame duration");
  }
  if (currentDuration.value <= 0n) throw new Error("INVALID_PROJECT_STATE: clip durationTime must be positive");
  return structuredClone(operation.durationTime);
}

function validateCanonicalRename(
  operation: Extract<EditOperation, { type: "rename-clip" }>,
): Extract<EditOperation, { type: "rename-clip" }> {
  if (!operation.name.trim()) throw new Error("INVALID_OPERATION: clip name cannot be empty");
  return operation;
}

function validateCanonicalMarker(
  operation: Extract<EditOperation, { type: "add-marker" }>,
): Extract<EditOperation, { type: "add-marker" }> {
  return operation;
}

function validateCanonicalGain(
  operation: Extract<EditOperation, { type: "set-gain" }>,
): Extract<EditOperation, { type: "set-gain" }> {
  if (!Number.isFinite(operation.gainDb)) throw new Error("INVALID_OPERATION: gain must be finite");
  if (operation.gainDb < -6 || operation.gainDb > 6) {
    throw new Error("INVALID_OPERATION: gain must be between -6 and 6 dB");
  }
  return operation;
}

function sameRational(left: RationalTime, right: RationalTime): boolean {
  try {
    const [leftValue, leftScale] = rationalParts(left);
    const [rightValue, rightScale] = rationalParts(right);
    return leftValue * rightScale === rightValue * leftScale;
  } catch {
    return false;
  }
}

function rationalParts(value: RationalTime): [bigint, bigint] {
  const numerator = BigInt(value.value);
  const denominator = BigInt(value.timescale);
  if (denominator <= 0n) throw new Error("INVALID_OPERATION: rational timescale must be positive");
  return [numerator, denominator];
}

function normalizeRational(numerator: bigint, denominator: bigint): RationalTime {
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { value: (numerator / divisor).toString(), timescale: (denominator / divisor).toString() };
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

function isFrameAligned(value: RationalTime, origin: RationalTime, frameDuration: RationalTime): boolean {
  const [valueNumerator, valueDenominator] = rationalParts(normalizeRational(
    rationalParts(value)[0] * rationalParts(origin)[1] - rationalParts(origin)[0] * rationalParts(value)[1],
    rationalParts(value)[1] * rationalParts(origin)[1],
  ));
  const [frameNumerator, frameDenominator] = rationalParts(frameDuration);
  return (valueNumerator * frameDenominator) % (valueDenominator * frameNumerator) === 0n;
}

function zeroRational(): RationalTime {
  return { value: "0", timescale: "1" };
}

function rationalSeconds(value: RationalTime): number {
  const [numerator, denominator] = rationalParts(value);
  return Number(numerator) / Number(denominator);
}

function secondsToRational(seconds: number, frameDuration?: RationalTime): RationalTime {
  if (!Number.isFinite(seconds)) throw new Error("INVALID_OPERATION: time must be finite");
  if (frameDuration) {
    const frameSeconds = rationalSeconds(frameDuration);
    const frames = Math.round(seconds / frameSeconds);
    if (Math.abs(seconds - frames * frameSeconds) > 0.000001) throw new Error("INVALID_OPERATION: time must be frame-aligned");
    const [frameValue, frameScale] = rationalParts(frameDuration);
    return normalizeRational(BigInt(frames) * frameValue, frameScale);
  }
  const scaled = BigInt(Math.round(seconds * 1_000_000_000));
  return normalizeRational(scaled, 1_000_000_000n);
}

function unavailableCanonicalSnapshot(reason: string): CapabilityDescriptor {
  return {
    available: false,
    backend: "final-cut-native-canonical",
    guarantee: "none",
    unavailableReason: reason,
  };
}

function previewRevision(snapshot: ProjectSnapshot, before: ContextRevision): ContextRevision {
  return {
    id: `canonical:${canonicalSnapshotDigest(snapshot)}`,
    sequence: before.sequence + 1,
    timestamp: new Date().toISOString(),
  };
}

function assertSameRevision(expected: ContextRevision, actual: ContextRevision): void {
  if (!sameRevision(expected, actual)) throw new Error("STALE_CONTEXT: canonical Final Cut revision changed before mutation");
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

async function executeCanonicalAppleScript(script: string): Promise<string> {
  try {
    const result = await execFile("osascript", ["-e", script], { maxBuffer: 1_000_000 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
      throw new Error(`FINAL_CUT_CANONICAL_PERMISSION_REQUIRED: ${detail}`);
    }
    throw new Error(`FINAL_CUT_CANONICAL_AUTOMATION_FAILED: ${detail}`);
  }
}

async function readCanonicalExport(path: string, timeoutMs: number, pollIntervalMs: number): Promise<ProjectSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let previousSignature: string | undefined;
  let lastReadError: unknown;

  while (Date.now() <= deadline) {
    let signature: string | undefined;
    try {
      const details = await stat(path);
      if (details.isFile() && details.size > 0) {
        signature = `${details.size}:${details.mtimeMs}`;
      }
    } catch {
      // The Save dialog may still be open.
    }

    if (signature && signature === previousSignature) {
      try {
        return await new FcpxmlDocumentAdapter(path).readProject();
      } catch (error) {
        lastReadError = error;
      }
    }
    previousSignature = signature;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
  const detail = lastReadError instanceof Error ? `: ${lastReadError.message}` : "";
  throw new Error(`FINAL_CUT_CANONICAL_EXPORT_TIMEOUT: Final Cut did not provide a complete export at ${path}${detail}`);
}

function sourceBasename(source: string): string {
  const withoutQuery = source.split(/[?#]/, 1)[0] ?? source;
  try {
    const url = new URL(withoutQuery);
    return basename(decodeURIComponent(url.pathname));
  } catch {
    return basename(withoutQuery.replace(/^file:\/\//, ""));
  }
}

function sameRationalText(value: string, expected: { value: string; timescale: string }): boolean {
  const match = value.trim().match(/^(-?\d+)\/(\d+)$/);
  if (!match || Number(match[2]) <= 0 || Number(expected.timescale) <= 0) return false;
  return BigInt(match[1]!) * BigInt(expected.timescale) === BigInt(expected.value) * BigInt(match[2]!);
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
}
