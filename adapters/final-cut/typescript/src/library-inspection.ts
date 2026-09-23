import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectCatalog, ProjectDescriptor, ProjectSequence, RationalTime } from "@framekit/runtime";
import { validateProjectCatalog } from "@framekit/runtime";

export const FINAL_CUT_LIBRARY_INSPECTION_BACKEND = "final-cut-background-library" as const;
export const FINAL_CUT_LIBRARY_INSPECTION_TIMEOUT_MS = 30_000;

export type FinalCutLibraryInspectionIssueCode =
  | "FINAL_CUT_LIBRARY_FIELD_UNAVAILABLE"
  | "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE"
  | "FINAL_CUT_LIBRARY_RESPONSE_INVALID"
  | "FINAL_CUT_LIBRARY_TIME_INVALID";

export interface FinalCutLibraryInspectionIssue {
  code: FinalCutLibraryInspectionIssueCode;
  message: string;
  path?: string;
  retryable: boolean;
}

export type FinalCutLibraryInspectionField<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; issue: FinalCutLibraryInspectionIssue };

export interface FinalCutLibraryInspectionSequence {
  id: string;
  name: string;
  startTime: FinalCutLibraryInspectionField<RationalTime>;
  duration: FinalCutLibraryInspectionField<RationalTime>;
  frameDuration: FinalCutLibraryInspectionField<RationalTime>;
}

export interface FinalCutLibraryInspectionProject {
  id: string;
  name: string;
  sequences: FinalCutLibraryInspectionSequence[];
}

export interface FinalCutLibraryInspectionEvent {
  id: string;
  name: string;
  projects: FinalCutLibraryInspectionProject[];
}

export interface FinalCutLibraryInspectionLibrary {
  id: string;
  name: string;
  events: FinalCutLibraryInspectionEvent[];
}

export interface FinalCutLibraryInspectionCatalog {
  libraries: FinalCutLibraryInspectionLibrary[];
}

export interface FinalCutLibraryInspectionError {
  code: FinalCutLibraryInspectionIssueCode;
  message: string;
  retryable: boolean;
}

export type FinalCutLibraryInspectionResult =
  | { status: "available"; catalog: FinalCutLibraryInspectionCatalog }
  | { status: "partial"; catalog: FinalCutLibraryInspectionCatalog; issues: FinalCutLibraryInspectionIssue[] }
  | { status: "unavailable"; error: FinalCutLibraryInspectionError }
  | { status: "error"; error: FinalCutLibraryInspectionError };

type JsonRecord = Record<string, unknown>;

const execFile = promisify(execFileCallback);

export interface FinalCutLibraryInspectionProviderOptions {
  executor?: (script: string, timeoutMs: number) => Promise<string>;
  applicationIdentifier?: string;
}

/** Structured failure raised when project.list cannot use the background provider. */
export class FinalCutLibraryInspectionProviderError extends Error {
  public readonly code: FinalCutLibraryInspectionIssueCode;
  public readonly retryable: boolean;

  public constructor(public readonly failure: FinalCutLibraryInspectionError) {
    super(`${failure.code}: ${failure.message}`);
    this.name = "FinalCutLibraryInspectionProviderError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }

  public toJSON(): FinalCutLibraryInspectionError {
    return { ...this.failure };
  }
}

export function serializeFinalCutLibraryInspectionError(
  error: unknown,
): FinalCutLibraryInspectionError | undefined {
  return error instanceof FinalCutLibraryInspectionProviderError ? error.toJSON() : undefined;
}

/** Read-only Final Cut library inspection through direct Apple Events. */
export class FinalCutLibraryInspectionProvider {
  public readonly backend = FINAL_CUT_LIBRARY_INSPECTION_BACKEND;
  private readonly executor: (script: string, timeoutMs: number) => Promise<string>;
  private readonly applicationIdentifier: string;

  public constructor(options: FinalCutLibraryInspectionProviderOptions = {}) {
    this.executor = options.executor ?? executeFinalCutLibraryInspection;
    this.applicationIdentifier = options.applicationIdentifier ?? "com.apple.FinalCut";
  }

  public async inspect(): Promise<FinalCutLibraryInspectionResult> {
    try {
      const response = await this.executor(
        buildFinalCutLibraryInspectionScript(this.applicationIdentifier),
        FINAL_CUT_LIBRARY_INSPECTION_TIMEOUT_MS,
      );
      return parseFinalCutLibraryInspectionResponse(response);
    } catch (error) {
      return {
        status: "unavailable",
        error: unavailableError(error),
      };
    }
  }

  public async listProjects(): Promise<ProjectCatalog> {
    const result = await this.inspect();
    if (result.status === "unavailable" || result.status === "error") {
      throw new FinalCutLibraryInspectionProviderError(result.error);
    }
    const catalog = toFinalCutProjectCatalog(result.catalog);
    try {
      validateProjectCatalog(catalog);
    } catch (error) {
      throw new FinalCutLibraryInspectionProviderError({
        code: "FINAL_CUT_LIBRARY_RESPONSE_INVALID",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }
    return catalog;
  }
}

/** Build the JXA program used for direct, read-only Final Cut Apple Events. */
export function buildFinalCutLibraryInspectionScript(applicationIdentifier = "com.apple.FinalCut"): string {
  return `
function safeCall(target, property) {
  try {
    var value = target[property]();
    return value === undefined ? null : value;
  } catch (_) {
    try {
      var fallback = target[property];
      return fallback === undefined ? null : fallback;
    } catch (_) {
      return null;
    }
  }
}

function collectionCall(target, property) {
  try {
    var value = target[property]();
    return value === undefined ? null : value;
  } catch (_) {
    return null;
  }
}

function textValue(target, property) {
  var value = safeCall(target, property);
  return value === null ? null : String(value);
}

function mediaTimeValue(target, property) {
  var value = safeCall(target, property);
  if (value === null) return null;
  return {
    value: textValue(value, "value"),
    timescale: textValue(value, "timescale")
  };
}

function sequenceValue(sequence) {
  return {
    id: textValue(sequence, "id"),
    name: textValue(sequence, "name"),
    startTime: mediaTimeValue(sequence, "startTime"),
    duration: mediaTimeValue(sequence, "duration"),
    frameDuration: mediaTimeValue(sequence, "frameDuration")
  };
}

function projectValue(project) {
  var sequence = safeCall(project, "sequence");
  return {
    id: textValue(project, "id"),
    name: textValue(project, "name"),
    sequence: sequence === null ? null : sequenceValue(sequence)
  };
}

function eventValue(event) {
  var projects = collectionCall(event, "projects");
  return {
    id: textValue(event, "id"),
    name: textValue(event, "name"),
    projects: projects === null ? null : projects.map(projectValue)
  };
}

function libraryValue(library) {
  var events = collectionCall(library, "events");
  return {
    id: textValue(library, "id"),
    name: textValue(library, "name"),
    events: events === null ? null : events.map(eventValue)
  };
}

var finalCut = Application(${JSON.stringify(applicationIdentifier)});
var libraries = collectionCall(finalCut, "libraries");
JSON.stringify({
  version: 1,
  libraries: libraries === null ? null : libraries.map(libraryValue)
});`;
}

async function executeFinalCutLibraryInspection(
  script: string,
  timeoutMs = FINAL_CUT_LIBRARY_INSPECTION_TIMEOUT_MS,
): Promise<string> {
  try {
    const result = await execFile("osascript", ["-l", "JavaScript", "-e", script], {
      maxBuffer: 1_000_000,
      timeout: timeoutMs,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(normalizeAppleEventFailure(error));
  }
}

function normalizeAppleEventFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isTimeoutFailure(error)) {
    return `Final Cut library Apple Events timed out: ${detail}`;
  }
  if (detail.includes("not authorized") || detail.includes("-1743") || detail.includes("-25211")) {
    return `Automation permission is required for Final Cut library inspection: ${detail}`;
  }
  return `Final Cut library Apple Events are unavailable: ${detail}`;
}

function isTimeoutFailure(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate.code === "ETIMEDOUT") return true;
    if (typeof candidate.message === "string" && /timed out/i.test(candidate.message)) return true;
  }
  return typeof error === "string" && /timed out/i.test(error);
}

function unavailableError(error: unknown): FinalCutLibraryInspectionError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.startsWith("Automation permission is required")
    || rawMessage.startsWith("Final Cut library Apple Events are unavailable")
    ? rawMessage
    : normalizeAppleEventFailure(error);
  return {
    code: "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE",
    message,
    retryable: !message.includes("Automation permission is required"),
  };
}

/** Parse the JSON envelope returned by the direct Final Cut Apple Event query. */
export function parseFinalCutLibraryInspectionResponse(input: string | unknown): FinalCutLibraryInspectionResult {
  let payload: unknown;
  try {
    payload = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    return invalidResponse(`response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const response = asRecord(payload);
  if (!response) return invalidResponse("response must be an object");
  if (response.status === "unavailable") {
    return {
      status: "unavailable",
      error: parseTopLevelError(response.error, "Final Cut library Apple Events are unavailable"),
    };
  }
  if (response.status === "error") {
    return {
      status: "error",
      error: parseTopLevelError(response.error, "Final Cut library inspection failed"),
    };
  }
  if (!Array.isArray(response.libraries)) return invalidResponse("libraries must be an array");

  const issues: FinalCutLibraryInspectionIssue[] = [];
  const libraries = response.libraries.flatMap((value: unknown, index: number) => {
    const library = parseLibrary(value, `libraries[${index}]`, issues);
    return library ? [library] : [];
  });
  const catalog = { libraries };
  return issues.length > 0 ? { status: "partial", catalog, issues } : { status: "available", catalog };
}

/** Flatten safely discoverable project identities for the existing project.list contract. */
export function toFinalCutProjectCatalog(catalog: FinalCutLibraryInspectionCatalog): ProjectCatalog {
  const projects: ProjectDescriptor[] = [];
  for (const library of catalog.libraries) {
    for (const event of library.events) {
      for (const project of event.projects) {
        const sequences: ProjectSequence[] = project.sequences.map(({ id, name }) => ({ id, name }));
        projects.push({ id: project.id, name: project.name, sequences });
      }
    }
  }
  return { projects };
}

function parseLibrary(value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]): FinalCutLibraryInspectionLibrary | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(requiredFieldIssue(path, "library"));
    return undefined;
  }
  const id = requiredText(record.id, `${path}.id`, "library id", issues);
  const name = requiredText(record.name, `${path}.name`, "library name", issues);
  const events = parseChildren(record.events, `${path}.events`, "event", parseEvent, issues);
  if (!id || !name) return undefined;
  return { id, name, events };
}

function parseEvent(value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]): FinalCutLibraryInspectionEvent | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(requiredFieldIssue(path, "event"));
    return undefined;
  }
  const id = requiredText(record.id, `${path}.id`, "event id", issues);
  const name = requiredText(record.name, `${path}.name`, "event name", issues);
  const projects = parseChildren(record.projects, `${path}.projects`, "project", parseProject, issues);
  if (!id || !name) return undefined;
  return { id, name, projects };
}

function parseProject(value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]): FinalCutLibraryInspectionProject | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(requiredFieldIssue(path, "project"));
    return undefined;
  }
  const id = requiredText(record.id, `${path}.id`, "project id", issues);
  const name = requiredText(record.name, `${path}.name`, "project name", issues);
  const sequences = record.sequence === null || record.sequence === undefined
    ? (() => {
      issues.push(fieldUnavailableIssue(`${path}.sequence`, "project sequence is unavailable"));
      return [];
    })()
    : [parseSequence(record.sequence, `${path}.sequence`, issues)].filter((sequence): sequence is FinalCutLibraryInspectionSequence => Boolean(sequence));
  if (!id || !name) return undefined;
  return { id, name, sequences };
}

function parseSequence(value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]): FinalCutLibraryInspectionSequence | undefined {
  const record = asRecord(value);
  if (!record) {
    issues.push(requiredFieldIssue(path, "sequence"));
    return undefined;
  }
  const id = requiredText(record.id, `${path}.id`, "sequence id", issues);
  const name = requiredText(record.name, `${path}.name`, "sequence name", issues);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    startTime: parseTimeField(record.startTime, `${path}.startTime`, issues),
    duration: parseTimeField(record.duration, `${path}.duration`, issues),
    frameDuration: parseTimeField(record.frameDuration, `${path}.frameDuration`, issues),
  };
}

function parseChildren<T>(
  value: unknown,
  path: string,
  label: string,
  parse: (value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]) => T | undefined,
  issues: FinalCutLibraryInspectionIssue[],
): T[] {
  if (value === undefined || value === null) {
    issues.push(fieldUnavailableIssue(path, `${label} collection is unavailable`));
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push({
      code: "FINAL_CUT_LIBRARY_RESPONSE_INVALID",
      message: `${label} collection must be an array`,
      path,
      retryable: false,
    });
    return [];
  }
  return value.flatMap((child, index) => {
    const parsed = parse(child, `${path}[${index}]`, issues);
    return parsed ? [parsed] : [];
  });
}

function parseTimeField(value: unknown, path: string, issues: FinalCutLibraryInspectionIssue[]): FinalCutLibraryInspectionField<RationalTime> {
  if (value === undefined || value === null) {
    const issue = fieldUnavailableIssue(path, "media-time field is unavailable");
    issues.push(issue);
    return { status: "unavailable", issue };
  }
  const record = asRecord(value);
  const normalizedValue = normalizeInteger(record?.value);
  const normalizedTimescale = normalizeInteger(record?.timescale);
  if (normalizedValue === undefined || normalizedTimescale === undefined || BigInt(normalizedTimescale) <= 0n) {
    const issue: FinalCutLibraryInspectionIssue = {
      code: "FINAL_CUT_LIBRARY_TIME_INVALID",
      message: "media-time field must contain an integer value and positive timescale",
      path,
      retryable: false,
    };
    issues.push(issue);
    return { status: "unavailable", issue };
  }
  return {
    status: "available",
    value: { value: normalizedValue, timescale: normalizedTimescale },
  };
}

function requiredText(
  value: unknown,
  path: string,
  label: string,
  issues: FinalCutLibraryInspectionIssue[],
): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  issues.push(fieldUnavailableIssue(path, `${label} is unavailable`));
  return undefined;
}

function normalizeInteger(value: unknown): string | undefined {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function parseTopLevelError(value: unknown, fallback: string): FinalCutLibraryInspectionError {
  const record = asRecord(value);
  const message = typeof record?.message === "string" && record.message.trim() ? record.message : fallback;
  const code = record?.code === "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE"
    ? record.code
    : "FINAL_CUT_LIBRARY_INSPECTION_UNAVAILABLE";
  return { code, message, retryable: record?.retryable === true };
}

function invalidResponse(message: string): FinalCutLibraryInspectionResult {
  return {
    status: "error",
    error: {
      code: "FINAL_CUT_LIBRARY_RESPONSE_INVALID",
      message: `Final Cut library response is invalid: ${message}`,
      retryable: false,
    },
  };
}

function fieldUnavailableIssue(path: string, message: string): FinalCutLibraryInspectionIssue {
  return {
    code: "FINAL_CUT_LIBRARY_FIELD_UNAVAILABLE",
    message,
    path,
    retryable: false,
  };
}

function requiredFieldIssue(path: string, label: string): FinalCutLibraryInspectionIssue {
  return fieldUnavailableIssue(path, `${label} is unavailable`);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
