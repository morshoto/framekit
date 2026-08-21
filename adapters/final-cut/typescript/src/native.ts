import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { EditorLiveState } from "@framekit/runtime";

const execFile = promisify(execFileCallback);

export type NativeFinalCutEdit =
  | { type: "rename-selected-clip"; name: string }
  | { type: "trim-selected-clip-to-playhead"; edge: "start" | "end" }
  | { type: "set-selected-clip-gain"; gainDb: number }
  | { type: "add-marker-at-playhead"; name: string; duration?: number };

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
  undoAvailable: boolean;
  error?: { code: string; message: string };
}

export interface NativeFinalCutCapabilities {
  selectionEdit: boolean;
  undo: boolean;
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
}

export interface NativeFinalCutEditor {
  capabilities(): NativeFinalCutCapabilities;
  inspect(): Promise<NativeFinalCutContext>;
  edit(operation: NativeFinalCutEdit): Promise<NativeFinalCutEditResult>;
  undo(operationId: string): Promise<NativeFinalCutUndoResult>;
}

export class FinalCutNativeAutomationAdapter implements NativeFinalCutEditor {
  private readonly enabled: boolean;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly operations = new Set<string>();

  public constructor(options: NativeFinalCutAutomationOptions = {}) {
    this.enabled = options.enabled ?? process.env.FRAMEKIT_FINAL_CUT_NATIVE_WRITES === "1";
    this.executor = options.executor ?? runAppleScript;
    this.liveState = options.liveState;
  }

  public capabilities(): NativeFinalCutCapabilities {
    return {
      selectionEdit: this.enabled,
      undo: this.enabled,
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

  private assertEnabled(): void {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut native writes are disabled");
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
    set frontState to frontmost as text
    return frontState & (ASCII character 31) & frontWindowName & (ASCII character 31) & selectedCount & (ASCII character 31) & selectedName & (ASCII character 31) & selectedRole & (ASCII character 31) & undoEnabled
  end tell
end tell`;
}

function editScript(operation: NativeFinalCutEdit): string {
  const action = operation.type === "rename-selected-clip"
    ? `click menu item "Apply Custom Name" of menu "Modify" of menu bar 1\n    delay 0.2\n    set value of focused text field of front window to ${appleScriptString(operation.name)}\n    key code 36`
    : operation.type === "trim-selected-clip-to-playhead"
      ? `click menu item "Trim ${operation.edge === "start" ? "Start" : "End"}" of menu "Trim" of menu bar 1`
      : operation.type === "set-selected-clip-gain"
        ? `click menu item "Adjust Volume" of menu "Modify" of menu bar 1\n    delay 0.2\n    set value of focused text field of front window to ${appleScriptString(`${operation.gainDb}`)}\n    key code 36`
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
  const [frontState, frontWindow, selectedCountText, selectedName, selectedRole, undoState] = output.split(String.fromCharCode(31));
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
    undoAvailable: undoState === "true",
  };
}

function unavailableContext(code: string, message: string): NativeFinalCutContext {
  return {
    available: false,
    application: "Final Cut Pro",
    frontmost: false,
    target: { kind: "none" },
    undoAvailable: false,
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
