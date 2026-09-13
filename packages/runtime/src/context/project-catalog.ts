import { parseRational } from "../timeline/rational-time.js";
import type {
  EditorLiveState,
  ProjectCatalog,
  ProjectCatalogIdentityMatch,
  ProjectCatalogLiveSource,
  ProjectCatalogProvenance,
} from "../domain/context.js";
import type { ContextRevision, RationalTime } from "../domain/primitives.js";

export interface ProjectCatalogReconciliationOptions {
  before?: EditorLiveState;
  after?: EditorLiveState;
  provenance: {
    catalog: ProjectCatalogProvenance["catalog"];
    live?: ProjectCatalogLiveSource;
    selection: ProjectCatalogProvenance["selection"];
  };
}

export function reconcileProjectCatalog(
  catalog: ProjectCatalog,
  options: ProjectCatalogReconciliationOptions,
): ProjectCatalog {
  validateCatalog(catalog);
  if (options.before) validateLiveState(options.before);
  if (options.after) validateLiveState(options.after);

  const state = options.after ?? options.before;
  const beforeRevision = options.before?.revision;
  const afterRevision = options.after?.revision;
  const project = state?.project
    ? matchIdentity(catalog.projects, state.project.id, state.project.name, (candidate) => candidate.id, (candidate) => candidate.name)
    : unresolvedIdentity();
  const projectDescriptor = project.catalogId
    ? catalog.projects.find((candidate) => candidate.id === project.catalogId)
    : undefined;
  const sequence = state?.sequence && projectDescriptor
    ? matchIdentity(
        projectDescriptor.sequences,
        state.sequence.id,
        state.sequence.name,
        (candidate) => candidate.id,
        (candidate) => candidate.name,
      )
    : unresolvedIdentity(state?.sequence?.id);

  let status: NonNullable<ProjectCatalogProvenance["reconciliation"]>["status"] = project.method === "stable-id"
    && sequence.method === "stable-id"
    ? "matched"
    : "unresolved";
  let reason = status === "unresolved" ? "stable project and sequence IDs could not be reconciled" : undefined;

  if (options.before && options.after) {
    if (options.after.revision.sequence < options.before.revision.sequence) {
      throw new Error("PROJECT_CATALOG_INVALID: live revision sequence regressed");
    }
    if (!sameTarget(options.before, options.after)) {
      status = "stale";
      reason = "live target changed during project catalog reconciliation";
    } else if (!sameRevision(options.before.revision, options.after.revision)) {
      status = "stale";
      reason = "live revision changed during project catalog reconciliation";
    }
  }

  const result = structuredClone(catalog);
  if (status === "matched" && state?.project && state.sequence) {
    result.activeProjectId = project.catalogId;
    result.activeSequenceId = sequence.catalogId;
  } else {
    delete result.activeProjectId;
    delete result.activeSequenceId;
  }
  result.provenance = {
    catalog: { ...options.provenance.catalog },
    ...(state && options.provenance.live
      ? { live: { ...options.provenance.live, state: structuredClone(state) } }
      : {}),
    reconciliation: {
      status,
      project,
      sequence,
      ...(beforeRevision ? { beforeRevision: { ...beforeRevision } } : {}),
      ...(afterRevision ? { afterRevision: { ...afterRevision } } : {}),
      ...(reason ? { reason } : {}),
    },
    selection: { ...options.provenance.selection },
  };
  return result;
}

function matchIdentity<T>(
  values: T[],
  liveId: string,
  liveName: string,
  id: (value: T) => string,
  name: (value: T) => string,
): ProjectCatalogIdentityMatch {
  const stable = values.find((value) => id(value) === liveId);
  if (stable) return { method: "stable-id", catalogId: id(stable), liveId };
  const named = values.filter((value) => name(value) === liveName);
  if (named.length === 1) return { method: "name-only", catalogId: id(named[0]!), liveId };
  return unresolvedIdentity(liveId);
}

function unresolvedIdentity(liveId?: string): ProjectCatalogIdentityMatch {
  return { method: "unresolved", ...(liveId ? { liveId } : {}) };
}

function sameTarget(left: EditorLiveState, right: EditorLiveState): boolean {
  return left.project?.id === right.project?.id
    && left.sequence?.id === right.sequence?.id;
}

function sameRevision(left: ContextRevision, right: ContextRevision): boolean {
  return left.id === right.id && left.sequence === right.sequence;
}

function validateCatalog(catalog: ProjectCatalog): void {
  if (!Array.isArray(catalog.projects)) throw new Error("PROJECT_CATALOG_INVALID: projects must be an array");
  const projectIds = new Set<string>();
  for (const project of catalog.projects) {
    if (!project || typeof project !== "object") throw new Error("PROJECT_CATALOG_INVALID: project must be an object");
    if (!project.id.trim()) throw new Error("PROJECT_CATALOG_INVALID: project id must be non-empty");
    if (projectIds.has(project.id)) throw new Error(`PROJECT_CATALOG_INVALID: duplicate project id ${project.id}`);
    projectIds.add(project.id);
    if (!project.name.trim()) throw new Error(`PROJECT_CATALOG_INVALID: project ${project.id} name must be non-empty`);
    if (!Array.isArray(project.sequences)) throw new Error(`PROJECT_CATALOG_INVALID: project ${project.id} sequences must be an array`);
    const sequenceIds = new Set<string>();
    for (const sequence of project.sequences) {
      if (!sequence || typeof sequence !== "object") {
        throw new Error(`PROJECT_CATALOG_INVALID: sequence in project ${project.id} must be an object`);
      }
      if (!sequence.id.trim()) throw new Error(`PROJECT_CATALOG_INVALID: sequence in project ${project.id} id must be non-empty`);
      if (sequenceIds.has(sequence.id)) throw new Error(`PROJECT_CATALOG_INVALID: duplicate sequence id ${sequence.id} in project ${project.id}`);
      sequenceIds.add(sequence.id);
      if (!sequence.name.trim()) throw new Error(`PROJECT_CATALOG_INVALID: sequence ${sequence.id} name must be non-empty`);
    }
  }
}

function validateLiveState(state: EditorLiveState): void {
  validateRevision(state.revision);
  if (state.sequence) {
    validateRational(state.sequence.startTime, "live sequence start time");
    validateRational(state.sequence.duration, "live sequence duration");
    validateRational(state.sequence.frameDuration, "live sequence frame duration");
  }
  if (state.playheadTime) validateRational(state.playheadTime, "live playhead time");
  if (state.sequenceTimeRange) {
    validateRational(state.sequenceTimeRange.start, "live sequence range start");
    validateRational(state.sequenceTimeRange.duration, "live sequence range duration");
  }
}

function validateRevision(revision: ContextRevision): void {
  if (!revision.id.trim()) throw new Error("PROJECT_CATALOG_INVALID: live revision id must be non-empty");
  if (!Number.isInteger(revision.sequence) || revision.sequence < 0) {
    throw new Error("PROJECT_CATALOG_INVALID: live revision sequence must be a non-negative integer");
  }
  if (!revision.timestamp.trim()) throw new Error("PROJECT_CATALOG_INVALID: live revision timestamp must be non-empty");
}

function validateRational(value: RationalTime, field: string): void {
  try {
    parseRational(value, "PROJECT_CATALOG_INVALID");
  } catch {
    throw new Error(`PROJECT_CATALOG_INVALID: ${field} must use an integer value and positive timescale`);
  }
}
