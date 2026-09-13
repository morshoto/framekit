import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ContextRevision } from "@framekit/runtime";

export type BackgroundRenderSourceKind = "final-cut-timeline" | "fcpxml-artifact";

export interface BackgroundRenderTarget {
  projectId: string;
  sequenceId: string;
  revision?: ContextRevision;
  digest?: string;
}

export interface BackgroundRenderSource {
  kind: BackgroundRenderSourceKind;
  target: BackgroundRenderTarget;
  artifactPath?: string;
}

export interface BackgroundRenderRequest {
  source: BackgroundRenderSource;
  outputPath: string;
  preset: string;
  overwrite?: boolean;
  timeoutMs?: number;
}

export interface BackgroundRenderProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface BackgroundRenderMetadata extends BackgroundRenderProbeResult {
  outputPath: string;
  sizeBytes: number;
  format: string;
  outputDigest: string;
}

export type BackgroundRenderEvidenceTier = "background-native" | "artifact-rendered" | "external-rendered";

export interface BackgroundRenderProvenance {
  renderer: "external-renderer";
  evidenceTier: Exclude<BackgroundRenderEvidenceTier, "background-native">;
  source: BackgroundRenderSource;
}

export interface BackgroundRenderResult {
  jobId: string;
  outputPath: string;
  preset: string;
  completed: true;
  verified: true;
  metadata: BackgroundRenderMetadata;
  provenance: BackgroundRenderProvenance;
}

export type BackgroundRenderJobState = "queued" | "rendering" | "verifying" | "completed" | "cancelled" | "failed";

export interface BackgroundRenderJobStatus {
  jobId: string;
  state: BackgroundRenderJobState;
  progress: number;
  message: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface BackgroundRenderExecutionContext {
  request: BackgroundRenderRequest;
  stagingPath: string;
  signal: AbortSignal;
  reportProgress(progress: number, message?: string): void;
}

export type BackgroundRenderExecutor = (context: BackgroundRenderExecutionContext) => Promise<void>;
export type BackgroundRenderProbe = (stagingPath: string) => Promise<BackgroundRenderProbeResult>;
export type BackgroundRenderProgressListener = (status: BackgroundRenderJobStatus) => void;

export interface BackgroundRenderJob {
  readonly id: string;
  status(): BackgroundRenderJobStatus;
  onProgress(listener: BackgroundRenderProgressListener): () => void;
  result(): Promise<BackgroundRenderResult>;
  cancel(): Promise<void>;
}

export interface BackgroundRenderExportProviderOptions {
  enabled?: boolean;
  renderer?: BackgroundRenderExecutor;
  probe?: BackgroundRenderProbe;
  defaultTimeoutMs?: number;
}

/**
 * Runs an injected background renderer against a staged output.
 *
 * This provider is intentionally external/artifact-derived. It does not invoke
 * Final Cut UI and never labels its result as native Final Cut rendering.
 */
export class BackgroundRenderExportProvider {
  private readonly enabled: boolean;
  private readonly renderer?: BackgroundRenderExecutor;
  private readonly probe?: BackgroundRenderProbe;
  private readonly defaultTimeoutMs: number;

  public constructor(options: BackgroundRenderExportProviderOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.renderer = options.renderer;
    this.probe = options.probe;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  public isAvailable(): boolean {
    return this.enabled && this.renderer !== undefined && this.probe !== undefined;
  }

  public start(request: BackgroundRenderRequest): BackgroundRenderJob {
    if (!this.isAvailable()) {
      throw new Error("BACKGROUND_RENDER_UNAVAILABLE: no configured background renderer and verifier are available");
    }
    validateRequest(request);
    const job = new BackgroundRenderJobHandle(
      request,
      this.renderer!,
      this.probe!,
      this.defaultTimeoutMs,
    );
    job.start();
    return job;
  }
}

class BackgroundRenderJobHandle implements BackgroundRenderJob {
  public readonly id = `background-render-${randomUUID()}`;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<BackgroundRenderProgressListener>();
  private readonly completion: Promise<BackgroundRenderResult>;
  private resolveCompletion!: (result: BackgroundRenderResult) => void;
  private rejectCompletion!: (error: unknown) => void;
  private current: BackgroundRenderJobStatus = {
    jobId: this.id,
    state: "queued",
    progress: 0,
    message: "background render queued",
  };
  private cancelRequested = false;
  private committed = false;

  public constructor(
    private readonly request: BackgroundRenderRequest,
    private readonly renderer: BackgroundRenderExecutor,
    private readonly probe: BackgroundRenderProbe,
    private readonly defaultTimeoutMs: number,
  ) {
    this.completion = new Promise<BackgroundRenderResult>((resolveCompletion, rejectCompletion) => {
      this.resolveCompletion = resolveCompletion;
      this.rejectCompletion = rejectCompletion;
    });
  }

  public start(): void {
    queueMicrotask(() => void this.run());
  }

  public status(): BackgroundRenderJobStatus {
    return { ...this.current, ...(this.current.error ? { error: { ...this.current.error } } : {}) };
  }

  public onProgress(listener: BackgroundRenderProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public result(): Promise<BackgroundRenderResult> {
    return this.completion;
  }

  public async cancel(): Promise<void> {
    if (isTerminal(this.current.state)) return;
    this.cancelRequested = true;
    this.controller.abort(backgroundRenderError("BACKGROUND_RENDER_CANCELLED", "background render cancelled by caller"));
    await this.completion.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const outputPath = resolve(this.request.outputPath.trim());
    const stagingPath = createStagingPath(outputPath);
    const timeout = setTimeout(() => {
      this.controller.abort(backgroundRenderError("BACKGROUND_RENDER_TIMEOUT", "background render exceeded its deadline"));
    }, this.request.timeoutMs ?? this.defaultTimeoutMs);

    try {
      if (this.controller.signal.aborted) throw this.controller.signal.reason;
      await assertSourceBinding(this.request.source, this.controller.signal);
      await assertOutputDirectory(outputPath);
      await assertOutputCanBeReplaced(outputPath, this.request.overwrite ?? false);
      this.update("rendering", 0, "background renderer started");
      await this.runRenderer(stagingPath);
      throwIfAborted(this.controller.signal);
      this.update("verifying", 0.9, "verifying staged output");
      const details = await stat(stagingPath);
      throwIfAborted(this.controller.signal);
      if (!details.isFile() || details.size <= 0) {
        throw backgroundRenderError("BACKGROUND_RENDER_VERIFICATION_FAILED", "renderer produced no non-empty staged output");
      }
      const probed = await this.probe(stagingPath);
      throwIfAborted(this.controller.signal);
      validateProbe(probed);
      const outputDigest = await sha256File(stagingPath, this.controller.signal);
      throwIfAborted(this.controller.signal);
      const metadata: BackgroundRenderMetadata = {
        outputPath,
        sizeBytes: details.size,
        format: outputFormat(outputPath),
        outputDigest,
        ...probed,
      };
      await commitOutput(stagingPath, outputPath, this.request.overwrite ?? false, this.controller.signal);
      this.committed = true;
      const result: BackgroundRenderResult = {
        jobId: this.id,
        outputPath,
        preset: this.request.preset,
        completed: true,
        verified: true,
        metadata,
        provenance: {
          renderer: "external-renderer",
          evidenceTier: this.request.source.kind === "fcpxml-artifact" ? "artifact-rendered" : "external-rendered",
          source: this.request.source,
        },
      };
      this.update("completed", 1, "background render verified and committed");
      this.resolveCompletion(result);
    } catch (error) {
      const normalized = normalizeBackgroundRenderError(error, this.cancelRequested);
      const cancelled = normalized.code === "BACKGROUND_RENDER_CANCELLED";
      this.update(cancelled ? "cancelled" : "failed", this.current.progress, normalized.message, normalized);
      this.rejectCompletion(normalized);
    } finally {
      clearTimeout(timeout);
      if (!this.committed) await removeIfPresent(stagingPath);
    }
  }

  private async runRenderer(stagingPath: string): Promise<void> {
    throwIfAborted(this.controller.signal);
    const renderPromise = this.renderer({
      request: this.request,
      stagingPath,
      signal: this.controller.signal,
      reportProgress: (progress, message) => {
        if (this.current.state !== "rendering") return;
        this.update("rendering", progress, message ?? "background renderer in progress");
      },
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (this.controller.signal.aborted) {
        reject(this.controller.signal.reason);
        return;
      }
      this.controller.signal.addEventListener("abort", () => reject(this.controller.signal.reason), { once: true });
    });
    try {
      await Promise.race([renderPromise, abortPromise]);
    } catch (error) {
      if (this.controller.signal.aborted) await renderPromise.catch(() => undefined);
      throw error;
    }
  }

  private update(
    state: BackgroundRenderJobState,
    progress: number,
    message: string,
    error?: { code: string; message: string },
  ): void {
    this.current = {
      jobId: this.id,
      state,
      progress: Math.max(0, Math.min(1, progress)),
      message,
      ...(error ? { error } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch {
        // Progress observers must not affect job execution or settlement.
      }
    }
  }
}

function validateRequest(request: BackgroundRenderRequest): void {
  if (!request.outputPath.trim()) throw backgroundRenderError("BACKGROUND_RENDER_INVALID_REQUEST", "outputPath is required");
  if (!request.preset.trim()) throw backgroundRenderError("BACKGROUND_RENDER_INVALID_REQUEST", "preset is required");
  const { target } = request.source;
  if (!target.projectId.trim() || !target.sequenceId.trim()) {
    throw backgroundRenderError("BACKGROUND_RENDER_INVALID_SOURCE", "source target requires projectId and sequenceId");
  }
  if (!target.revision && !target.digest) {
    throw backgroundRenderError("BACKGROUND_RENDER_INVALID_SOURCE", "source target requires a revision or digest binding");
  }
  if (request.source.kind === "final-cut-timeline") {
    throw backgroundRenderError(
      "BACKGROUND_RENDER_NATIVE_UNAVAILABLE",
      "no supported background-native Final Cut renderer is configured",
    );
  }
  if (target.digest !== undefined && !target.digest.trim()) {
    throw backgroundRenderError("BACKGROUND_RENDER_INVALID_SOURCE", "source digest cannot be empty");
  }
  if (request.source.kind === "fcpxml-artifact" && !request.source.artifactPath?.trim()) {
    throw backgroundRenderError("BACKGROUND_RENDER_INVALID_SOURCE", "fcpxml-artifact source requires artifactPath");
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw backgroundRenderError("BACKGROUND_RENDER_INVALID_REQUEST", "timeoutMs must be a positive finite number");
  }
}

async function assertSourceBinding(source: BackgroundRenderSource, signal: AbortSignal): Promise<void> {
  if (source.kind !== "fcpxml-artifact") return;
  try {
    const observedDigest = await sha256File(source.artifactPath!, signal);
    if (source.target.digest !== undefined && source.target.digest !== observedDigest) {
      throw backgroundRenderError(
        "BACKGROUND_RENDER_SOURCE_CHANGED",
        `source digest changed for ${source.artifactPath}`,
      );
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isNodeError(error) && typeof error.code === "string" && error.code.startsWith("BACKGROUND_RENDER_")) {
      throw error;
    }
    throw backgroundRenderError(
      "BACKGROUND_RENDER_SOURCE_UNAVAILABLE",
      `could not read source artifact ${source.artifactPath} (${String(error)})`,
    );
  }
}

function validateProbe(probe: BackgroundRenderProbeResult): void {
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw backgroundRenderError("BACKGROUND_RENDER_VERIFICATION_FAILED", "output duration is missing or invalid");
  }
  if (!Number.isInteger(probe.width) || probe.width <= 0 || !Number.isInteger(probe.height) || probe.height <= 0) {
    throw backgroundRenderError("BACKGROUND_RENDER_VERIFICATION_FAILED", "output resolution is missing or invalid");
  }
  if (!Number.isFinite(probe.frameRate) || probe.frameRate <= 0 || typeof probe.hasAudio !== "boolean") {
    throw backgroundRenderError("BACKGROUND_RENDER_VERIFICATION_FAILED", "output frame rate or audio presence is missing or invalid");
  }
}

function createStagingPath(outputPath: string): string {
  const extension = extname(outputPath);
  const stem = basename(outputPath, extension);
  return join(dirname(outputPath), `.${stem}.framekit-${randomUUID()}${extension}`);
}

async function assertOutputDirectory(outputPath: string): Promise<void> {
  const parent = dirname(outputPath);
  try {
    const details = await stat(parent);
    if (!details.isDirectory()) throw new Error("parent path is not a directory");
    await access(parent, constants.W_OK);
  } catch (error) {
    throw backgroundRenderError("BACKGROUND_RENDER_PATH_UNAVAILABLE", `output directory is not writable (${String(error)})`);
  }
}

async function assertOutputCanBeReplaced(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    const details = await stat(outputPath);
    if (!details.isFile()) throw backgroundRenderError("BACKGROUND_RENDER_OUTPUT_EXISTS", `output path is not a file: ${outputPath}`);
    if (!overwrite) throw backgroundRenderError("BACKGROUND_RENDER_OUTPUT_EXISTS", `refusing to replace existing output ${outputPath}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function commitOutput(
  stagingPath: string,
  outputPath: string,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (!overwrite) {
    try {
      await stat(outputPath);
      throw backgroundRenderError("BACKGROUND_RENDER_OUTPUT_EXISTS", `output appeared while rendering ${outputPath}`);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
  }
  throwIfAborted(signal);
  try {
    await rename(stagingPath, outputPath);
  } catch (error) {
    throw backgroundRenderError("BACKGROUND_RENDER_COMMIT_FAILED", `could not commit ${outputPath} (${String(error)})`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? backgroundRenderError("BACKGROUND_RENDER_CANCELLED", "background render cancelled");
  }
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function outputFormat(outputPath: string): string {
  return extname(outputPath).slice(1).toLowerCase() || "unknown";
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isTerminal(state: BackgroundRenderJobState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

function backgroundRenderError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizeBackgroundRenderError(error: unknown, cancelRequested: boolean): Error & { code: string } {
  if (isNodeError(error) && typeof error.code === "string" && error.code.startsWith("BACKGROUND_RENDER_")) {
    return error as Error & { code: string };
  }
  if (cancelRequested || error instanceof DOMException && error.name === "AbortError") {
    return backgroundRenderError("BACKGROUND_RENDER_CANCELLED", "background render cancelled by caller");
  }
  return backgroundRenderError("BACKGROUND_RENDER_FAILED", String(error));
}
