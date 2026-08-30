import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EditorIdentity, RuntimeCapabilities } from "@framekit/runtime";
import { withCapabilityFamilies } from "@framekit/runtime";
import { createFinalCutLiveAdapter, DEFAULT_FINAL_CUT_LIVE_SOCKET } from "./live.js";

const execFile = promisify(execFileCallback);

export type FinalCutConnectionState =
  | "disconnected"
  | "detecting"
  | "installing"
  | "launching"
  | "restarting"
  | "activating"
  | "waiting-for-socket"
  | "ready"
  | "needs-user-action"
  | "unavailable";

export interface FinalCutConnectionStatus {
  state: FinalCutConnectionState;
  editorDetected: boolean;
  extensionInstalled: boolean;
  extensionPath: string;
  socketPath: string;
  identity?: EditorIdentity;
  capabilities?: RuntimeCapabilities;
  lastError?: { code: string; message: string };
  updatedAt: string;
}

export interface FinalCutConnectionOptions {
  /** Probe an existing Workflow Extension socket without launching or activating Final Cut. */
  headless?: boolean;
  socketPath?: string;
  extensionSourcePath?: string;
  extensionInstallPath?: string;
  finalCutApp?: string;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  detectFinalCut?: () => Promise<boolean>;
  launchFinalCut?: () => Promise<void>;
  installExtension?: () => Promise<void>;
  launchExtension?: () => Promise<void>;
  registerExtension?: () => Promise<void>;
  activateExtension?: (options?: FinalCutActivationOptions) => Promise<void>;
  restartFinalCut?: () => Promise<void>;
  restartAfterInstall?: boolean;
  probe?: () => Promise<{ identity: EditorIdentity; capabilities: RuntimeCapabilities }>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FinalCutActivationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface StatusPatch {
  state?: FinalCutConnectionState;
  editorDetected?: boolean;
  extensionInstalled?: boolean;
  identity?: EditorIdentity;
  capabilities?: RuntimeCapabilities;
  lastError?: { code: string; message: string };
}

const DEFAULT_EXTENSION_NAME = "FramekitFinalCutWorkflow.app";
/**
 * Owns the user-facing lifecycle around the native Workflow Extension.
 * The live adapter remains the source of truth for Final Cut state; this class
 * only installs, activates, probes, and reconnects the bridge.
 */
export class FinalCutConnectionManager {
  private readonly socketPath: string;
  private readonly headless: boolean;
  private readonly extensionSourcePath?: string;
  private readonly extensionInstallPath: string;
  private readonly finalCutApp: string;
  private readonly pollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly activationRetryIntervalMs: number;
  private readonly detectFinalCut: () => Promise<boolean>;
  private readonly launchFinalCut: () => Promise<void>;
  private readonly installExtensionAction: () => Promise<void>;
  private readonly launchExtension: () => Promise<void>;
  private readonly registerExtension: () => Promise<void>;
  private readonly activateExtension: (options?: FinalCutActivationOptions) => Promise<void>;
  private readonly restartFinalCut: () => Promise<void>;
  private readonly restartAfterInstall: boolean;
  private readonly probe: () => Promise<{ identity: EditorIdentity; capabilities: RuntimeCapabilities }>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private status: FinalCutConnectionStatus;
  private attempt?: Promise<FinalCutConnectionStatus>;
  private interval?: NodeJS.Timeout;

  public constructor(options: FinalCutConnectionOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.FRAMEKIT_FINAL_CUT_SOCKET ?? DEFAULT_FINAL_CUT_LIVE_SOCKET;
    this.headless = options.headless ?? process.env.FRAMEKIT_FINAL_CUT_HEADLESS === "1";
    this.extensionInstallPath = options.extensionInstallPath
      ?? process.env.FRAMEKIT_EXTENSION_INSTALL_PATH
      ?? join(homedir(), "Applications", DEFAULT_EXTENSION_NAME);
    this.extensionSourcePath = options.extensionSourcePath
      ?? process.env.FRAMEKIT_EXTENSION_APP_PATH
      ?? (existsSync(this.extensionInstallPath) ? undefined : defaultExtensionSourcePath());
    this.finalCutApp = options.finalCutApp ?? "/Applications/Final Cut Pro.app";
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
    this.activationRetryIntervalMs = 2_000;
    this.detectFinalCut = options.detectFinalCut ?? (() => defaultDetectFinalCut(this.finalCutApp));
    this.launchFinalCut = options.launchFinalCut ?? (() => defaultLaunchFinalCut(this.finalCutApp));
    this.installExtensionAction = options.installExtension ?? (() => this.installExtensionIfAvailable());
    // Final Cut must host the Workflow Extension. Opening the container app
    // directly can create an unhosted extension process that never publishes
    // the bridge socket, so the default launch action is intentionally a no-op.
    this.launchExtension = options.launchExtension ?? (async () => {});
    this.registerExtension = options.registerExtension ?? (() => defaultRegisterExtension(this.extensionInstallPath));
    this.activateExtension = options.activateExtension ?? ((activationOptions) => defaultActivateFinalCut(activationOptions));
    this.restartAfterInstall = options.restartAfterInstall ?? false;
    this.restartFinalCut = options.restartFinalCut ?? (() => defaultRestartFinalCut(
      this.detectFinalCut,
      this.launchFinalCut,
      this.sleep,
    ));
    this.probe = options.probe ?? defaultProbe(this.socketPath);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.status = {
      state: "disconnected",
      editorDetected: false,
      extensionInstalled: false,
      extensionPath: this.extensionInstallPath,
      socketPath: this.socketPath,
      updatedAt: new Date().toISOString(),
    };
  }

  public getStatus(): FinalCutConnectionStatus {
    return structuredClone(this.status);
  }

  public startAutoConnect(): void {
    if (this.interval) return;
    void this.ensureConnected();
    this.interval = setInterval(() => void this.ensureConnected(), this.pollIntervalMs);
  }

  public stopAutoConnect(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  public async ensureConnected(): Promise<FinalCutConnectionStatus> {
    if (this.attempt) return this.attempt;
    this.attempt = this.connect().finally(() => {
      this.attempt = undefined;
    });
    return this.attempt;
  }

  private async connect(): Promise<FinalCutConnectionStatus> {
    try {
      this.update({ state: "detecting", lastError: undefined });
      const existing = await this.tryProbe();
      if (existing) return this.ready(existing);

      if (this.headless) {
        return this.fail(
          "FINAL_CUT_HEADLESS_SOCKET_UNAVAILABLE",
          `Headless mode only probes the existing Workflow Extension socket at ${this.socketPath}; it does not launch or activate Final Cut Pro`,
          "unavailable",
        );
      }

      const editorDetected = await this.detectFinalCut();
      this.update({ editorDetected });
      if (!editorDetected) {
        this.update({ state: "launching" });
        await this.launchFinalCut();
        const deadline = Date.now() + Math.min(5_000, this.startupTimeoutMs);
        while (Date.now() < deadline && !(await this.detectFinalCut())) {
          await this.sleep(250);
        }
        const detectedAfterLaunch = await this.detectFinalCut();
        this.update({ editorDetected: detectedAfterLaunch });
        if (!detectedAfterLaunch) {
          return this.fail("FINAL_CUT_NOT_RUNNING", "Final Cut Pro could not be launched", "unavailable");
        }
      }

      const installed = await pathExists(this.extensionInstallPath);
      this.update({ extensionInstalled: installed });
      const shouldInstall = !installed
        || (this.extensionSourcePath && resolve(this.extensionSourcePath) !== resolve(this.extensionInstallPath));
      const extensionChanged = Boolean(shouldInstall);
      if (shouldInstall) {
        this.update({ state: "installing" });
        await this.installExtensionAction();
      }

      const installedAfterSetup = await pathExists(this.extensionInstallPath);
      this.update({ extensionInstalled: installedAfterSetup });
      if (!installedAfterSetup) {
        return this.fail(
          "EXTENSION_NOT_INSTALLED",
          "Framekit's Final Cut Workflow Extension is not installed and no installable artifact was found",
          "needs-user-action",
        );
      }
      if (extensionChanged) await this.registerExtension();

      if (this.restartAfterInstall && extensionChanged && editorDetected) {
        this.update({ state: "restarting" });
        await this.restartFinalCut();
        this.update({ editorDetected: true });
      }

      this.update({ state: "launching" });
      await this.launchExtension();
      this.update({ state: "activating" });
      const deadline = Date.now() + this.startupTimeoutMs;
      await this.activateUntil(deadline);
      this.update({ state: "waiting-for-socket" });

      let nextActivationAt = Date.now() + this.activationRetryIntervalMs;
      while (Date.now() < deadline) {
        const result = await this.tryProbe();
        if (result) return this.ready(result);
        if (Date.now() >= nextActivationAt) {
          try {
            await this.activateWithDeadline(deadline);
          } catch (error) {
            if (isPermissionError(error)) throw error;
          }
          nextActivationAt = Date.now() + this.activationRetryIntervalMs;
        }
        await this.sleep(Math.min(250, Math.max(25, deadline - Date.now())));
      }
      return this.fail(
        "FINAL_CUT_LIVE_TIMEOUT",
        `The Workflow Extension did not publish ${this.socketPath} within ${this.startupTimeoutMs}ms; Final Cut Pro may need to be reopened after installing the extension`,
        "unavailable",
      );
    } catch (error) {
      const message = String(error);
      const code = isPermissionError(error)
        ? "MACOS_PERMISSION_REQUIRED"
        : message.match(/\bFINAL_CUT_[A-Z_]+\b/)?.[0] ?? "FINAL_CUT_CONNECTION_FAILED";
      const state = code === "MACOS_PERMISSION_REQUIRED" || code === "FINAL_CUT_RESTART_TIMEOUT"
        ? "needs-user-action"
        : "unavailable";
      return this.fail(code, message, state);
    }
  }

  private async tryProbe(): Promise<{ identity: EditorIdentity; capabilities: RuntimeCapabilities } | undefined> {
    try {
      return await this.probe();
    } catch {
      return undefined;
    }
  }

  private ready(result: { identity: EditorIdentity; capabilities: RuntimeCapabilities }): FinalCutConnectionStatus {
    this.update({
      state: "ready",
      editorDetected: true,
      extensionInstalled: true,
      identity: result.identity,
      capabilities: withCapabilityFamilies(result.capabilities, {
        backend: result.identity.backend,
        connectionBackend: result.identity.backend,
      }),
      lastError: undefined,
    });
    return this.getStatus();
  }

  private fail(code: string, message: string, state: FinalCutConnectionState): FinalCutConnectionStatus {
    this.update({ state, lastError: { code, message } });
    return this.getStatus();
  }

  private update(patch: StatusPatch): void {
    this.status = {
      ...this.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  private async activateUntil(deadline: number): Promise<void> {
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.activateWithDeadline(deadline);
        return;
      } catch (error) {
        if (isPermissionError(error)) throw error;
        lastError = error;
        await this.sleep(Math.min(250, Math.max(25, deadline - Date.now())));
      }
    }
    const detail = lastError ? ` (${String(lastError)})` : "";
    throw new Error(`FINAL_CUT_ACTIVATION_TIMEOUT: Framekit extension menu was not available before the connection deadline${detail}`);
  }

  private async activateWithDeadline(deadline: number): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("FINAL_CUT_ACTIVATION_TIMEOUT: Framekit extension activation deadline expired");

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const activation = Promise.resolve().then(() => this.activateExtension({ signal: controller.signal, timeoutMs: remainingMs }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("FINAL_CUT_ACTIVATION_TIMEOUT: Framekit extension activation exceeded the connection deadline"));
      }, remainingMs);
    });
    try {
      await Promise.race([activation, timeout]);
    } catch (error) {
      if (timedOut || isActivationTimeout(error)) {
        throw new Error(`FINAL_CUT_ACTIVATION_TIMEOUT: Framekit extension activation did not complete (${String(error)})`);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!timedOut) controller.abort();
      void activation.catch(() => {});
    }
  }

  private async installExtensionIfAvailable(): Promise<void> {
    if (!this.extensionSourcePath) return;
    const source = resolve(this.extensionSourcePath);
    const destination = resolve(this.extensionInstallPath);
    if (source === destination) return;
    if (!(await pathExists(source))) return;

    const staging = `${destination}.staging-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, staging, { recursive: true, force: true });
    const backup = `${destination}.previous-${Date.now()}`;
    let backedUp = false;
    try {
      if (await pathExists(destination)) {
        await rename(destination, backup);
        backedUp = true;
      }
      await rename(staging, destination);
      if (backedUp) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (backedUp && !(await pathExists(destination))) await rename(backup, destination);
      throw error;
    }
  }
}

function defaultProbe(socketPath: string): () => Promise<{ identity: EditorIdentity; capabilities: RuntimeCapabilities }> {
  const adapter = createFinalCutLiveAdapter(socketPath);
  return async () => ({
    identity: await adapter.getIdentity(),
    capabilities: await adapter.getCapabilities(),
  });
}

async function defaultDetectFinalCut(appPath: string): Promise<boolean> {
  try {
    await access(appPath);
    const result = await execFile("pgrep", ["-f", `${appPath}/Contents/MacOS/Final Cut Pro`]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function defaultLaunchFinalCut(appPath: string): Promise<void> {
  if (appPath === "/Applications/Final Cut Pro.app") {
    await execFile("open", ["-a", "Final Cut Pro"]);
    return;
  }
  await execFile("open", [appPath]);
}

async function defaultRegisterExtension(extensionPath: string): Promise<void> {
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister";
  await execFile(lsregister, ["-f", "-R", "-trusted", extensionPath]);
}

async function defaultRestartFinalCut(
  detectFinalCut: () => Promise<boolean>,
  launchFinalCut: () => Promise<void>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  await execFile("osascript", ["-e", 'quit app "Final Cut Pro"']);
  const quitDeadline = Date.now() + 15_000;
  while (await detectFinalCut()) {
    if (Date.now() >= quitDeadline) {
      throw new Error("FINAL_CUT_RESTART_TIMEOUT: Final Cut Pro did not quit; close it and retry");
    }
    await sleep(250);
  }

  // Reuse the configured launcher so tests and nonstandard app paths remain
  // injectable; the default launcher opens the Final Cut Pro application.
  const launchDeadline = Date.now() + 15_000;
  let lastLaunchError: unknown;
  while (Date.now() < launchDeadline) {
    try {
      await launchFinalCut();
      lastLaunchError = undefined;
    } catch (error) {
      lastLaunchError = error;
    }
    if (await detectFinalCut()) return;
    await sleep(500);
  }
  const detail = lastLaunchError ? ` (${String(lastLaunchError)})` : "";
  throw new Error(`FINAL_CUT_RESTART_TIMEOUT: Final Cut Pro did not reopen; open it and retry${detail}`);
}

async function defaultActivateFinalCut(options: FinalCutActivationOptions = {}): Promise<void> {
  const script = [
    'tell application "System Events"',
    'tell process "Final Cut Pro"',
    'set frontmost to true',
    'click menu item "Framekit" of menu 1 of menu item "Extensions" of menu 1 of menu bar item "Window" of menu bar 1',
    "end tell",
    "end tell",
  ].join("\n");
  await execFile("osascript", ["-e", script], {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultExtensionSourcePath(): string | undefined {
  const candidates = [
    join("/Applications", DEFAULT_EXTENSION_NAME),
    join(process.cwd(), "resources", DEFAULT_EXTENSION_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function isPermissionError(error: unknown): boolean {
  const message = String(error);
  return message.includes("not authorized") || message.includes("Automation");
}

function isActivationTimeout(error: unknown): boolean {
  const message = String(error);
  return message.includes("-1712") || message.includes("ETIMEDOUT") || message.includes("timed out");
}
