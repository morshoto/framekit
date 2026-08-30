import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { EditorLiveState } from "@framekit/runtime";

const execFile = promisify(execFileCallback);

export interface FinalCutProjectPublishResult {
  sourceTransactionId: string;
  sourcePath: string;
  importedPath: string;
  projectName: string;
  verified: boolean;
  liveProject?: string;
  liveSequence?: string;
}

export interface FinalCutProjectPublisherOptions {
  enabled?: boolean;
  sourcePath: string;
  executor?: (script: string) => Promise<string>;
  liveState?: () => Promise<EditorLiveState>;
  waitMs?: number;
}

/** Imports a validated FCPXML artifact as a new Final Cut project. */
export class FinalCutProjectPublisher {
  private readonly enabled: boolean;
  private readonly sourcePath: string;
  private readonly executor: (script: string) => Promise<string>;
  private readonly liveState?: () => Promise<EditorLiveState>;
  private readonly waitMs: number;

  public constructor(options: FinalCutProjectPublisherOptions) {
    this.enabled = options.enabled ?? false;
    this.sourcePath = options.sourcePath;
    this.executor = options.executor ?? runAppleScript;
    this.liveState = options.liveState;
    this.waitMs = options.waitMs ?? 1_500;
  }

  public isAvailable(): boolean {
    return this.enabled;
  }

  public async publishNewProject(sourceTransactionId: string): Promise<FinalCutProjectPublishResult> {
    if (!this.enabled) throw new Error("CAPABILITY_UNAVAILABLE: Final Cut project publishing is disabled; set FRAMEKIT_FINAL_CUT_NATIVE_WRITES=1");
    const source = await readFile(this.sourcePath, "utf8");
    if (!source.includes("<fcpxml") || !source.includes("<project")) {
      throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: source is not a valid FCPXML project artifact");
    }
    const projectName = projectNameFromXml(source);
    const directory = await mkdtemp(join(tmpdir(), "framekit-finalcut-publish-"));
    const importedPath = join(directory, basename(this.sourcePath));
    await copyFile(this.sourcePath, importedPath);
    try {
      await this.executor(importXmlScript(importedPath));
      await delay(this.waitMs);
      const live = this.liveState ? await this.liveState() : undefined;
      if (live && live.project?.name !== projectName) {
        throw new Error(`FINAL_CUT_PUBLISH_VERIFICATION_FAILED: expected new project ${projectName}, observed ${live.project?.name ?? "none"}`);
      }
      return {
        sourceTransactionId,
        sourcePath: this.sourcePath,
        importedPath,
        projectName,
        verified: true,
        ...(live?.project?.name ? { liveProject: live.project.name } : {}),
        ...(live?.sequence?.name ? { liveSequence: live.sequence.name } : {}),
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
tell application "System Events"
  tell process "Final Cut Pro"
    if not frontmost then error number -1719
    click menu item "XML..." of menu item "Import" of menu "File" of menu bar 1
    delay 0.4
    keystroke "g" using {command down}
    delay 0.2
    set value of first text field of front window to ${appleScriptString(path)}
    key code 36
    delay 0.5
    key code 36
  end tell
end tell`;
}

function projectNameFromXml(source: string): string {
  const match = source.match(/<project\b[^>]*\bname="([^"]+)"/);
  if (!match?.[1]) throw new Error("FINAL_CUT_PUBLISH_VALIDATION_FAILED: FCPXML project has no name");
  return decodeXml(match[1]);
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
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\\r\\n]/g, " ")}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
