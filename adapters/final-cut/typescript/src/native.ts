import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { EditorLiveState } from "@framekit/runtime";

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

export interface NativeFinalCutContext {
  available: boolean;
  application: "Final Cut Pro";
  frontmost: boolean;
  frontWindow?: string;
  project?: string;
  sequence?: string;
  playheadTime?: string;
  target: {
    kind: "selected-clip" | "playhead" | "unknown" | "none";
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
}

export class FinalCutNativeAutomationAdapter implements NativeFinalCutEditor {
  private readonly enabled: boolean;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly now: () => number;
  private readonly operations = new Set<string>();
  private readonly mediaHandles = new Map<string, NativeFinalCutMediaMatch>();
  private readonly occurrenceHandles = new Map<string, NativeFinalCutOccurrence>();
  private readonly ambiguousMediaHandles = new Set<string>();
  private readonly bladePreviews = new Map<string, { occurrence: NativeFinalCutOccurrence; expiresAt: number }>();

  public constructor(options: NativeFinalCutAutomationOptions = {}) {
    this.enabled = options.enabled ?? process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES === "1";
    this.executor = options.executor ?? runAppleScript;
    this.liveState = options.liveState;
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
      requiresAccessibility: true,
      requiresFinalCutFrontmost: true,
    };
  }

  public async inspect(): Promise<NativeFinalCutContext> {
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
    if (after.target.kind !== "selected-clip" || (match.name && after.target.name !== match.name)) {
      throw new Error("FINAL_CUT_NATIVE_SELECTION_VERIFICATION_FAILED: Final Cut did not expose the requested Browser item as selected");
    }
    return after;
  }

  public async locateOccurrence(mediaHandle: string): Promise<NativeFinalCutOccurrenceSearchResult> {
    this.assertEnabled();
    const match = this.mediaHandles.get(mediaHandle);
    if (!match) throw new Error(`FINAL_CUT_NATIVE_MEDIA_HANDLE_STALE: unknown media handle ${mediaHandle}`);
    const context = await this.requireAvailableContext();
    if (!context.frontmost) throw new Error("FINAL_CUT_NATIVE_NOT_FRONTMOST: Final Cut's timeline must be frontmost");
    try {
      const occurrences = parseOccurrences(await this.executor(locateOccurrenceScript(match)), mediaHandle);
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
      await this.executor(locateOccurrenceScript({ handle: preview.occurrence.mediaHandle, name: preview.occurrence.name })),
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

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are disabled");
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

function inspectScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    set frontWindow to front window
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
      set bladeEnabled to enabled of menu item "Blade" of menu "Modify" of menu bar 1
    end try
    set frontState to frontmost as text
    return frontState & (ASCII character 31) & frontWindowName & (ASCII character 31) & selectedCount & (ASCII character 31) & selectedName & (ASCII character 31) & selectedRole & (ASCII character 31) & undoEnabled & (ASCII character 31) & bladeEnabled
  end tell
end tell`;
}

function searchMediaScript(query: string): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    set searchQuery to ${appleScriptString(query)}
    keystroke "f" using {command down}
    delay 0.2
    try
      set value of first text field of front window to searchQuery
      key code 36
    end try
    delay 0.5
    set output to ""
    repeat with candidate in entire contents of front window
      try
        set candidateRole to role of candidate as text
        set candidateName to name of candidate as text
        if candidateName is not "" and (candidateRole contains "row" or candidateRole contains "cell") then
          set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 30)
        end if
      end try
    end repeat
    return output
  end tell
end tell`;
}

function selectMediaScript(match: NativeFinalCutMediaMatch): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    set matchIndex to 0
    repeat with candidate in entire contents of front window
      try
        if (name of candidate as text) is ${appleScriptString(match.name)} and (role of candidate as text) contains "row" then
          if matchIndex is ${match.uiIndex ?? 0} then
            click candidate
            return "selected"
          end if
          set matchIndex to matchIndex + 1
        end if
      on error
        -- Ignore inaccessible transient elements while the Browser redraws.
      end try
    end repeat
    repeat with candidate in entire contents of front window
      try
        if (name of candidate as text) is ${appleScriptString(match.name)} then
          click candidate
          return "selected"
        end if
      end try
    end repeat
    error number -1728
  end tell
end tell`;
}

function locateOccurrenceScript(match: NativeFinalCutMediaMatch): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    set output to ""
    repeat with candidate in entire contents of front window
      try
        set candidateRole to role of candidate as text
        set candidateName to name of candidate as text
        if candidateName is ${appleScriptString(match.name)} and (candidateRole contains "row" or candidateRole contains "cell") then
          set output to output & candidateName & (ASCII character 31) & candidateRole & (ASCII character 30)
        end if
      end try
    end repeat
    return output
  end tell
end tell`;
}

function bladeScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    try
      click menu item "Blade" of menu "Modify" of menu bar 1
    on error
      keystroke "b"
    end try
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
    ${action}
  end tell
end tell`;
}

function undoScript(): string {
  return `
tell application "System Events"
  tell process "Final Cut Pro"
    keystroke "z" using {command down}
  end tell
end tell`;
}

function parseContext(output: string): NativeFinalCutContext {
  const [frontState, frontWindow, selectedCountText, selectedName, selectedRole, undoState, bladeState] = output.split(String.fromCharCode(31));
  const selectedCount = Number(selectedCountText ?? "0");
  const target = selectedCount === 1
    ? { kind: "selected-clip" as const, ...(selectedName ? { name: selectedName } : {}), ...(selectedRole ? { role: selectedRole } : {}) }
    : selectedCount > 1
      ? { kind: "unknown" as const }
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
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\\r\\n]/g, " ")}"`;
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
