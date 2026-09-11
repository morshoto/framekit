import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  canonicalSnapshotDigest,
  withCapabilityFamilies,
  type ContextRevision,
  type EditorChange,
  type EditorIdentity,
  type EditorLiveState,
  type EditOperation,
  type EditorPort,
  type LiveEditorStatePort,
  type ProjectCatalog,
  type ProjectSelection,
  type ProjectSnapshot,
  type RuntimeCapabilities,
} from "@framekit/runtime";
import type {
  NativeFinalCutEditor,
} from "./native.js";
import { FcpxmlDocumentAdapter } from "./fcpxml.js";

const execFile = promisify(execFileCallback);

export interface CanonicalNativeMutationPort {
  renameSelectedClip(name: string): Promise<{ operationId: string; undoAvailable: boolean }>;
  undo(operationId: string): Promise<{ undone: boolean; verification?: { verified: boolean } }>;
}

export type CanonicalNativeTargetResolver = (
  clip: ProjectSnapshot["timeline"]["clips"][number],
  snapshot: ProjectSnapshot,
) => Promise<void>;

export interface FinalCutCanonicalNativeProviderOptions {
  live: LiveEditorStatePort & { getIdentity(): Promise<EditorIdentity> };
  native: CanonicalNativeMutationPort;
  readSnapshot: () => Promise<ProjectSnapshot>;
  resolveTarget: CanonicalNativeTargetResolver;
}

export interface FinalCutCanonicalSnapshotSourceOptions {
  executor?: (script: string) => Promise<string>;
  exportTimeoutMs?: number;
  pollIntervalMs?: number;
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
      await waitForExportFile(exportPath, this.exportTimeoutMs, this.pollIntervalMs);
      return new FcpxmlDocumentAdapter(exportPath).readProject();
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
  }

  public async getIdentity(): Promise<EditorIdentity> {
    const identity = await this.live.getIdentity();
    return { ...identity, backend: "final-cut-native-canonical" };
  }

  public async getCapabilities(): Promise<RuntimeCapabilities> {
    return withCapabilityFamilies({
      editor: {
        projectRead: true,
        timelineSnapshotRead: true,
        timelineWrite: true,
        timelineArtifactWrite: false,
        readAfterWrite: true,
        incrementalChanges: true,
        rollback: true,
        assetDiscovery: false,
        liveStateRead: true,
        playheadWrite: false,
        frameCapture: false,
        playbackControl: false,
        projectCatalogRead: true,
        projectSelection: true,
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
      canonicalDocument: { read: true, write: true, artifactWrite: false },
    });
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

  public async apply(operation: EditOperation, expectedRevision: ContextRevision): Promise<ContextRevision> {
    const before = await this.readProject();
    assertSameRevision(expectedRevision, before.revision);
    if (operation.type !== "rename-clip") {
      throw new Error(`CAPABILITY_UNAVAILABLE: final-cut native canonical provider does not support ${operation.type}`);
    }
    const clip = before.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!clip) throw new Error(`CLIP_NOT_FOUND: ${operation.clipId}`);

    await this.resolveTarget(clip, before);
    const nativeResult = await this.native.renameSelectedClip(operation.name);
    if (!nativeResult.operationId || !nativeResult.undoAvailable) {
      throw new Error("FINAL_CUT_CANONICAL_UNDO_UNAVAILABLE: native rename did not expose Undo");
    }
    this.pending = {
      operationId: nativeResult.operationId,
      beforeDigest: canonicalSnapshotDigest(before),
      beforeRevision: before.revision,
      afterRevision: before.revision,
    };

    const after = await this.readProject();
    const afterClip = after.timeline.clips.find(({ id }) => id === operation.clipId);
    if (!afterClip || afterClip.name !== operation.name) {
      throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: renamed occurrence was not read back from Final Cut");
    }
    if (canonicalSnapshotDigest(after) === this.pending.beforeDigest) {
      throw new Error("FINAL_CUT_CANONICAL_READBACK_FAILED: native edit did not change the canonical digest");
    }
    this.pending.afterRevision = after.revision;
    return after.revision;
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
    const snapshot = await this.readProject();
    return {
      projects: [{
        id: snapshot.projectId,
        name: snapshot.projectName,
        sequences: [{ id: snapshot.timeline.id, name: snapshot.timeline.name }],
      }],
      activeProjectId: snapshot.projectId,
      activeSequenceId: snapshot.timeline.id,
    };
  }

  public async selectProject(selection: ProjectSelection): Promise<ProjectCatalog> {
    const catalog = await this.listProjects();
    const project = catalog.projects.find(({ id }) => id === selection.projectId);
    if (!project) throw new Error(`TARGET_MISMATCH: active project is not ${selection.projectId}`);
    const sequenceId = selection.sequenceId ?? (project.sequences.length === 1 ? project.sequences[0]?.id : undefined);
    if (!sequenceId) throw new Error(`AMBIGUOUS_PROJECT_TARGET: sequenceId is required for ${selection.projectId}`);
    if (sequenceId !== catalog.activeSequenceId) throw new Error(`TARGET_MISMATCH: active sequence is not ${sequenceId}`);
    return catalog;
  }

  public async readLiveState(): Promise<EditorLiveState> {
    return this.live.readLiveState();
  }

  public async liveChangesSince(revision: ContextRevision, waitMs = 0): Promise<EditorChange[]> {
    return this.live.liveChangesSince(revision, waitMs);
  }

  private async assertActiveTarget(snapshot: ProjectSnapshot): Promise<void> {
    const live = await this.live.readLiveState();
    if (live.project && live.project.name !== snapshot.projectName) {
      throw new Error(`TARGET_MISMATCH: exported project ${snapshot.projectName} is not active Final Cut project ${live.project.name}`);
    }
    if (live.sequence && live.sequence.name !== snapshot.timeline.name) {
      throw new Error(`TARGET_MISMATCH: exported sequence ${snapshot.timeline.name} is not active Final Cut sequence ${live.sequence.name}`);
    }
  }
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

async function waitForExportFile(path: string, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const details = await stat(path);
      if (details.isFile() && details.size > 0) return;
    } catch {
      // The Save dialog may still be open.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(`FINAL_CUT_CANONICAL_EXPORT_TIMEOUT: Final Cut did not create ${path}`);
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
