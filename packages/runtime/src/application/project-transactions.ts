import type { ContextRevision } from "../domain/primitives.js";
import {
  EditingSession,
  timelineIrDigest,
  type TimelineIrEditOperation,
  type TimelineIrPreview,
} from "../timeline/editing-session.js";
import {
  FramekitProjectStore,
  ProjectPersistenceError,
  type FramekitProjectDocument,
} from "./project-store.js";

export const PROJECT_EDIT_COMMAND_SCHEMA_VERSION = 1 as const;

export interface ProjectEditCommand {
  schemaVersion: typeof PROJECT_EDIT_COMMAND_SCHEMA_VERSION;
  target: {
    projectId: string;
    sequenceId: string;
  };
  expectedRevision: ContextRevision;
  operations: TimelineIrEditOperation[];
}

export interface ProjectEditDiff {
  beforeDigest: string;
  afterDigest: string;
  operations: TimelineIrEditOperation[];
  changedOccurrenceIds: string[];
  changedMarkerIds: string[];
}

export interface ProjectEditPreview {
  command: ProjectEditCommand;
  before: FramekitProjectDocument;
  after: FramekitProjectDocument;
  diff: ProjectEditDiff;
  changedOccurrenceIds: string[];
  changedMarkerIds: string[];
}

export interface ProjectEditResult extends ProjectEditPreview {
  committed: true;
}

export class ProjectTransactionError extends Error {
  public readonly code: "PROJECT_EDIT_INVALID" | "PROJECT_EDIT_STALE_REVISION" | "PROJECT_EDIT_TARGET_MISMATCH";
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: ProjectTransactionError["code"],
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProjectTransactionError";
    this.code = code;
    this.details = details;
  }
}

export class ProjectTransactionService {
  private readonly clock: () => string;

  public constructor(
    private readonly store: FramekitProjectStore,
    options: { clock?: () => string } = {},
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public async preview(command: ProjectEditCommand): Promise<ProjectEditPreview> {
    const project = await this.loadAndGuard(command);
    try {
      const session = EditingSession.create({ base: project.timeline, clock: this.clock });
      const preview = session.preview(command.operations, command.expectedRevision);
      return buildPreview(command, project, preview);
    } catch (error) {
      throw this.invalid(error);
    }
  }

  public async execute(command: ProjectEditCommand): Promise<ProjectEditResult> {
    const project = await this.loadAndGuard(command);
    let applied;
    try {
      const session = EditingSession.create({ base: project.timeline, clock: this.clock });
      applied = session.apply(command.operations, command.expectedRevision);
    } catch (error) {
      throw this.invalid(error);
    }

    if (applied.after.revision.sequence !== project.timeline.revision.sequence + 1) {
      throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "successful edit did not advance the project revision exactly once", {
        beforeRevision: project.timeline.revision,
        afterRevision: applied.after.revision,
      });
    }

    const next = structuredClone(project);
    next.timeline = applied.after;
    next.metadata.updatedAt = this.clock();
    try {
      const saved = await this.store.save(next, project.timeline.revision);
      return {
        ...buildPreview(command, project, applied),
        after: saved,
        committed: true,
      };
    } catch (error) {
      if (error instanceof ProjectPersistenceError && error.code === "PROJECT_STALE_REVISION") {
        throw new ProjectTransactionError("PROJECT_EDIT_STALE_REVISION", "project became stale before the edit could commit", error.details, { cause: error });
      }
      throw error;
    }
  }

  private async loadAndGuard(command: ProjectEditCommand): Promise<FramekitProjectDocument> {
    validateCommand(command);
    const project = await this.store.load();
    if (project.timeline.project.id !== command.target.projectId || project.timeline.sequence.id !== command.target.sequenceId) {
      throw new ProjectTransactionError("PROJECT_EDIT_TARGET_MISMATCH", "command target does not match the persisted project", {
        expectedTarget: command.target,
        actualTarget: { projectId: project.timeline.project.id, sequenceId: project.timeline.sequence.id },
      });
    }
    if (!sameRevision(project.timeline.revision, command.expectedRevision)) {
      throw new ProjectTransactionError("PROJECT_EDIT_STALE_REVISION", "expected project revision does not match the persisted project", {
        expectedRevision: command.expectedRevision,
        actualRevision: project.timeline.revision,
      });
    }
    return project;
  }

  private invalid(error: unknown): ProjectTransactionError {
    if (error instanceof ProjectTransactionError) return error;
    return new ProjectTransactionError("PROJECT_EDIT_INVALID", error instanceof Error ? error.message : String(error), undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function buildPreview(
  command: ProjectEditCommand,
  project: FramekitProjectDocument,
  result: TimelineIrPreview,
): ProjectEditPreview {
  const before = structuredClone(project);
  const after = structuredClone(project);
  before.timeline = result.before;
  after.timeline = result.after;
  const diff: ProjectEditDiff = {
    beforeDigest: timelineIrDigest(result.before),
    afterDigest: timelineIrDigest(result.after),
    operations: structuredClone(command.operations),
    changedOccurrenceIds: [...result.changedOccurrenceIds],
    changedMarkerIds: [...result.changedMarkerIds],
  };
  return {
    command: structuredClone(command),
    before,
    after,
    diff,
    changedOccurrenceIds: [...result.changedOccurrenceIds],
    changedMarkerIds: [...result.changedMarkerIds],
  };
}

function validateCommand(command: ProjectEditCommand): void {
  if (!command || typeof command !== "object" || command.schemaVersion !== PROJECT_EDIT_COMMAND_SCHEMA_VERSION) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "command schemaVersion must be 1");
  }
  if (!command.target || typeof command.target !== "object" || !text(command.target.projectId) || !text(command.target.sequenceId)) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "command target requires projectId and sequenceId");
  }
  if (!command.expectedRevision || typeof command.expectedRevision !== "object"
    || !text(command.expectedRevision.id)
    || !Number.isSafeInteger(command.expectedRevision.sequence)
    || command.expectedRevision.sequence < 0
    || !text(command.expectedRevision.timestamp)) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "command expectedRevision is invalid");
  }
  if (!Array.isArray(command.operations)) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "command operations must be an array");
  }
  for (const operation of command.operations as unknown[]) validateOperation(operation);
}

function validateOperation(operation: unknown): asserts operation is TimelineIrEditOperation {
  if (!operation || typeof operation !== "object" || !text((operation as { type?: unknown }).type)) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "every operation must include a supported type");
  }
  const candidate = operation as Record<string, unknown>;
  switch (candidate.type) {
    case "rename-occurrence":
      requireOperationText(candidate, "occurrenceId");
      requireOperationText(candidate, "name");
      return;
    case "trim-occurrence":
      requireOperationText(candidate, "occurrenceId");
      requireRationalShape(candidate.durationTime, "durationTime");
      return;
    case "move-occurrence":
      requireOperationText(candidate, "occurrenceId");
      requireRationalShape(candidate.startTime, "startTime");
      if (candidate.track !== undefined && (!Number.isInteger(candidate.track) || (candidate.track as number) < 0)) {
        throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "operation.track must be a non-negative integer");
      }
      return;
    case "set-gain":
      requireOperationText(candidate, "occurrenceId");
      if (typeof candidate.gainDb !== "number" || !Number.isFinite(candidate.gainDb)) {
        throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "operation.gainDb must be finite");
      }
      return;
    case "remove-occurrence":
      requireOperationText(candidate, "occurrenceId");
      return;
    case "add-marker":
      if (!candidate.marker || typeof candidate.marker !== "object") {
        throw new ProjectTransactionError("PROJECT_EDIT_INVALID", "operation.marker is required");
      }
      return;
    default:
      throw new ProjectTransactionError("PROJECT_EDIT_INVALID", `unsupported operation type: ${String(candidate.type)}`);
  }
}

function requireOperationText(operation: Record<string, unknown>, field: string): void {
  if (!text(operation[field])) throw new ProjectTransactionError("PROJECT_EDIT_INVALID", `operation.${field} must be non-empty`);
}

function requireRationalShape(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || !text((value as { value?: unknown }).value) || !text((value as { timescale?: unknown }).timescale)) {
    throw new ProjectTransactionError("PROJECT_EDIT_INVALID", `operation.${field} must be a rational time`);
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}
