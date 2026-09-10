import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { EditorLiveState } from "@framekit/runtime";

const execFile = promisify(execFileCallback);

export interface FinalCutProjectPublishResult {
  sourceTransactionId: string;
  sourcePath: string;
  sourceTarget: {
    kind: "artifact";
    artifactPath: string;
  };
  importedPath: string;
  projectName: string;
  createdTarget: {
    kind: "editor.project";
    projectId?: string;
    sequenceId?: string;
    projectName: string;
    sequenceName?: string;
  };
  activeProject: {
    before?: { id: string; name: string };
    after?: { id: string; name: string };
    changed?: boolean;
  };
  verified: boolean;
  liveProject?: string;
  liveSequence?: string;
}

export interface FinalCutProjectPublishRequest {
  sourceTransactionId: string;
  artifactPath: string;
  artifactDigest: string;
  confirm: boolean;
}

export interface FinalCutProjectPublisherOptions {
  enabled?: boolean;
  sourcePath: string;
  executor?: (script: string) => Promise<string>;
  liveState?: () => Promise<EditorLiveState>;
  verificationTimeoutMs?: number;
  pollIntervalMs?: number;
  /** @deprecated Use pollIntervalMs. */
  waitMs?: number;
}

/** Imports a validated FCPXML artifact as a new Final Cut project. */
export class FinalCutProjectPublisher {
  private readonly enabled: boolean;
  private readonly sourcePath: string;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly verificationTimeoutMs: number;
  private readonly pollIntervalMs: number;

  public constructor(options: FinalCutProjectPublisherOptions) {
    this.enabled = options.enabled ?? false;
    this.sourcePath = options.sourcePath;
    this.executor = options.executor ?? runAppleScript;
    this.liveState = options.liveState;
    this.verificationTimeoutMs = Math.max(0, options.verificationTimeoutMs ?? 15_000);
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? options.waitMs ?? 100);
  }

  public isAvailable(): boolean {
    return this.enabled;
  }

  public async publishNewProject(request: FinalCutProjectPublishRequest): Promise<FinalCutProjectPublishResult> {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing is disabled; configure FRAMEKIT_EDITOR=final-cut-live and FRAMEKIT_FCPXML_PATH, and ensure Final Cut is reachable through FRAMEKIT_FINAL_CUT_SOCKET");
    if (!request.confirm) throw new Error("PUBLISH_CONFIRMATION_REQUIRED: set confirm=true to create a new Final Cut project");
    if (!request.sourceTransactionId.trim()) throw new Error("INVALID_PUBLISH_REQUEST: sourceTransactionId is required");
    if (!request.artifactDigest.trim()) throw new Error("INVALID_PUBLISH_REQUEST: artifactDigest is required");
    if (request.artifactPath !== this.sourcePath) {
      throw new Error(`PUBLISH_TARGET_MISMATCH: requested artifact ${request.artifactPath} is not managed by this publisher`);
    }
    const source = await readFile(this.sourcePath, "utf8");
    if (hash(source) !== request.artifactDigest) {
      throw new Error("PUBLISH_SOURCE_CHANGED: managed FCPXML artifact changed after transaction verification");
    }
    if (!source.includes("<fcpxml") || !source.includes("<project")) {
      throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: source is not a valid FCPXML project artifact");
    }
    const identity = projectIdentityFromXml(source);
    if (!this.liveState) {
      throw new Error("FINAL_CUT_PUBLISH_VERIFICATION_UNAVAILABLE: live project and sequence state is required");
    }
    const beforeLive = await readLiveState(this.liveState, "before import");
    const directory = await mkdtemp(join(tmpdir(), "framekit-finalcut-publish-"));
    const importedPath = join(directory, basename(this.sourcePath));
    await writeFile(importedPath, source, "utf8");
    try {
      await this.executor(importXmlScript(importedPath));
      const live = await waitForImportedProject(
        this.liveState,
        identity,
        beforeLive,
        this.verificationTimeoutMs,
        this.pollIntervalMs,
      );
      return {
        sourceTransactionId: request.sourceTransactionId,
        sourcePath: this.sourcePath,
        sourceTarget: { kind: "artifact", artifactPath: this.sourcePath },
        importedPath,
        projectName: identity.projectName,
        createdTarget: {
          kind: "editor.project",
          ...(live?.project?.id ? { projectId: live.project.id } : {}),
          ...(live?.sequence?.id ? { sequenceId: live.sequence.id } : {}),
          projectName: identity.projectName,
          ...(live?.sequence?.name ? { sequenceName: live.sequence.name } : {}),
        },
        activeProject: {
          ...(beforeLive.project ? { before: beforeLive.project } : {}),
          ...(live.project ? { after: live.project } : {}),
          ...(beforeLive.project && live.project
            ? { changed: beforeLive.project.id !== live.project.id || beforeLive.project.name !== live.project.name }
            : {}),
        },
        verified: true,
        ...(live.project?.name ? { liveProject: live.project.name } : {}),
        ...(live.sequence?.name ? { liveSequence: live.sequence.name } : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    throw new Error(`FINAL_CUT_PUBLISH_AUTOMATION_FAILED: ${detail}`);
  }
}

function importXmlScript(path: string): string {
  return `
using terms from application "System Events"

on waitForMenuItem(container, expectedNames, timeoutSeconds, timeoutMessage)
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
end waitForMenuItem

on waitForSubmenu(menuItem, submenuName, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists menu submenuName of menuItem then return menu submenuName of menuItem
    end try
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end waitForSubmenu

on waitForWindow(finalCut, windowName, timeoutSeconds, timeoutMessage)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists window windowName of finalCut then return window windowName of finalCut
    end try
    if (current date) > deadline then error timeoutMessage
    delay 0.1
  end repeat
end waitForWindow

on waitForImportSheet(importWindow, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if exists sheet 1 of importWindow then return sheet 1 of importWindow
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_SHEET_TIMEOUT: Import XML sheet did not appear"
    delay 0.1
  end repeat
end waitForImportSheet

on matchesImportPathField(candidate)
  set candidateIdentifier to ""
  set candidateDescription to ""
  try
    set candidateIdentifier to value of attribute "AXIdentifier" of candidate as text
  end try
  try
    set candidateDescription to description of candidate as text
  end try
  if candidateIdentifier is "path" or candidateIdentifier is "location" then return true
  if candidateDescription contains "Go to the folder" then return true
  if candidateDescription contains "path" or candidateDescription contains "location" then return true
  return false
end matchesImportPathField

on locateImportPathField(pathSheet)
  set matchingFields to {}
  repeat with candidate in (text fields of pathSheet)
    if matchesImportPathField(candidate) then set end of matchingFields to candidate
  end repeat
  if (count of matchingFields) is 0 then error "FINAL_CUT_PUBLISH_PATH_CONTROL_UNAVAILABLE: Import XML path control had no accessibility identifier or description"
  if (count of matchingFields) is not 1 then error "FINAL_CUT_PUBLISH_PATH_CONTROL_AMBIGUOUS: Import XML path control was not unique"
  return item 1 of matchingFields
end locateImportPathField

on waitForImportSheetDismissal(importWindow, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if not (exists sheet 1 of importWindow) then return
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_SHEET_DISMISS_TIMEOUT: Import XML sheet did not disappear"
    delay 0.1
  end repeat
end waitForImportSheetDismissal

on waitForImportWindowDismissal(finalCut, timeoutSeconds)
  set deadline to (current date) + timeoutSeconds
  repeat
    try
      if not (exists window "Import XML" of finalCut) then return
    end try
    if (current date) > deadline then error "FINAL_CUT_PUBLISH_IMPORT_TIMEOUT: Import XML window did not close"
    delay 0.1
  end repeat
end waitForImportWindowDismissal

on cancelImportIfOpen(finalCut)
  try
    if exists window "Import XML" of finalCut then
      set importWindow to window "Import XML" of finalCut
      repeat with candidate in (buttons of importWindow)
        try
          if (name of candidate as text) is "Cancel" then
            perform action "AXPress" of candidate
            exit repeat
          end if
        end try
      end repeat
    end if
  end try
end cancelImportIfOpen

end using terms from

tell application "System Events"
  tell process "Final Cut Pro"
    set finalCut to it
    set importWindow to missing value
    try
      if not frontmost then error number -1719
      set fileMenu to menu "File" of menu bar 1
      set importMenuItem to my waitForMenuItem(fileMenu, {"Import"}, 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: File > Import was not exposed")
      perform action "AXPress" of importMenuItem
      set importMenu to my waitForSubmenu(importMenuItem, "Import", 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: Import submenu was not exposed")
      set xmlMenuItem to my waitForMenuItem(importMenu, {"XML…", "XML..."}, 10, "FINAL_CUT_PUBLISH_IMPORT_MENU_TIMEOUT: Import XML command was not exposed")
      perform action "AXPress" of xmlMenuItem
      set importWindow to my waitForWindow(finalCut, "Import XML", 10, "FINAL_CUT_PUBLISH_IMPORT_SHEET_TIMEOUT: Import XML sheet did not appear")
      keystroke "g" using {command down, shift down}
      set pathSheet to my waitForImportSheet(importWindow, 10)
      set pathField to my locateImportPathField(pathSheet)
      set value of pathField to ${appleScriptString(path)}
      key code 36
      my waitForImportSheetDismissal(importWindow, 10)
      key code 36
      my waitForImportWindowDismissal(finalCut, 60)
    on error errorMessage number errorNumber
      my cancelImportIfOpen(finalCut)
      error errorMessage number errorNumber
    end try
  end tell
end tell`;
}

function projectIdentityFromXml(source: string): { projectName: string; sequenceName: string } {
  const projectMatch = source.match(/<project\b[^>]*\bname="([^"]+)"/);
  if (!projectMatch?.[1]) throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: FCPXML project has no name");
  const projectName = decodeXml(projectMatch[1]);
  const sequenceMatch = source.match(/<sequence\b[^>]*\bname="([^"]+)"/);
  return { projectName, sequenceName: sequenceMatch?.[1] ? decodeXml(sequenceMatch[1]) : projectName };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
}

async function readLiveState(
  liveState: () => Promise<EditorLiveState>,
  phase: string,
): Promise<EditorLiveState> {
  try {
    return await liveState();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL_CUT_PUBLISH_STATE_UNAVAILABLE: ${phase}: ${detail}`);
  }
}

async function waitForImportedProject(
  liveState: () => Promise<EditorLiveState>,
  identity: { projectName: string; sequenceName: string },
  before: EditorLiveState,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<EditorLiveState> {
  const deadline = Date.now() + timeoutMs;
  let latest: EditorLiveState | undefined;
  do {
    latest = await readLiveState(liveState, "after import");
    if (isImportedProject(latest, identity, before)) return latest;
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (true);

  const observedProject = latest?.project?.name ?? "none";
  const observedSequence = latest?.sequence?.name ?? "none";
  throw new Error(
    `FINAL_CUT_PUBLISH_VERIFICATION_FAILED: expected new project ${identity.projectName} / sequence ${identity.sequenceName}, observed ${observedProject} / ${observedSequence}`,
  );
}

function isImportedProject(
  live: EditorLiveState,
  identity: { projectName: string; sequenceName: string },
  before: EditorLiveState,
): boolean {
  if (!live.project || !live.sequence) return false;
  if (live.project.name !== identity.projectName || live.sequence.name !== identity.sequenceName) return false;
  if (before.project && live.project.id === before.project.id) return false;
  if (before.sequence && live.sequence.id === before.sequence.id) return false;
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
