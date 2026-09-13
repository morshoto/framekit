import type { ProjectCatalog, ProjectDescriptor, ProjectSequence, RationalTime } from "@framekit/runtime";

export const FINAL_CUT_LIBRARY_INSPECTION_BACKEND = "final-cut-background-library" as const;

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
  const projectIds = new Set<string>();
  for (const library of catalog.libraries) {
    for (const event of library.events) {
      for (const project of event.projects) {
        if (projectIds.has(project.id)) continue;
        projectIds.add(project.id);
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
    ? []
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
  if (value === undefined || value === null) return { status: "unavailable", issue: fieldUnavailableIssue(path, "media-time field is unavailable") };
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
