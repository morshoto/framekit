import { createHash } from "node:crypto";
import { acceptCreativeBrief, assertBriefSourceCoverage, assertCurrentAcceptedBrief, reviewCreativeBrief } from "@framekit/runtime";
import type { CreativeBrief, CreativeBriefReview, CreativeBriefStore, FramekitProjectDocument, MediaSourceIdentity, StoredCreativeBrief, ContextRevision } from "@framekit/runtime";

export interface CreativeBriefTarget {
  projectId: string;
  sequenceId: string;
  expectedRevision: ContextRevision;
}
export interface CreativeBriefView {
  record: StoredCreativeBrief;
  review: CreativeBriefReview;
  sourceCoverage: "matched" | "unavailable";
  notice: string;
}
export interface HeadlessCreativeBriefOptions {
  /** The project loader must validate registered source bytes before returning. */
  openProject(projectId: string): Promise<FramekitProjectDocument>;
  storeForProject(projectId: string): CreativeBriefStore;
}

/** Headless brief review only; acceptance is not editor-operation authorization. */
export class HeadlessCreativeBriefService {
  constructor(private readonly options: HeadlessCreativeBriefOptions) {}

  async create(input: CreativeBriefTarget & { brief: CreativeBrief }): Promise<CreativeBriefView> {
    const project = await this.openTarget(input);
    const record = await this.options.storeForProject(input.projectId).create(input.projectId, input.brief);
    return view(record, project);
  }

  async inspect(input: CreativeBriefTarget): Promise<CreativeBriefView> {
    const project = await this.openTarget(input);
    return view(await this.options.storeForProject(input.projectId).read(input.projectId), project);
  }

  async revise(input: CreativeBriefTarget & { expectedDigest: string; brief: CreativeBrief }): Promise<CreativeBriefView> {
    const project = await this.openTarget(input);
    const record = await this.options.storeForProject(input.projectId).revise(input.projectId, input.expectedDigest, input.brief);
    return view(record, project);
  }

  async accept(input: CreativeBriefTarget & { expectedDigest: string; confirmed: boolean }): Promise<CreativeBriefView> {
    if (input.confirmed !== true) throw new Error("BRIEF_CONFIRMATION_REQUIRED: acceptance requires explicit confirmation");
    const before = await this.openTarget(input);
    const store = this.options.storeForProject(input.projectId);
    const draft = await store.read(input.projectId);
    if (draft.digest !== input.expectedDigest) throw new Error("STALE_BRIEF: reviewed brief changed");
    const acceptance = acceptCreativeBrief(draft.brief);
    assertBriefSourceCoverage(acceptance, draft.brief, registeredMedia(before));
    const accepted = await store.accept(input.projectId, input.expectedDigest);
    try {
      const after = await this.openTarget(input);
      if (projectDigest(before) !== projectDigest(after)) throw new Error("STALE_CONTEXT: project changed during brief acceptance");
      assertBriefSourceCoverage(acceptance, accepted.brief, registeredMedia(after));
      await assertCurrentAcceptedBrief(store, input.projectId, acceptance);
      return view(accepted, after);
    } catch (error) {
      // If the project drifted after acceptance, preserve no usable acceptance.
      // A competing or interrupted writer requires explicit reconciliation.
      try {
        const current = await store.read(input.projectId);
        if (current.state === "accepted" && current.digest === accepted.digest) await store.revise(input.projectId, accepted.digest, accepted.brief);
      } catch (reconcileError) { throw new Error("BRIEF_RECONCILIATION_REQUIRED: acceptance may need inspection", { cause: reconcileError }); }
      throw error;
    }
  }

  private async openTarget(input: CreativeBriefTarget): Promise<FramekitProjectDocument> {
    if (!input.projectId?.trim() || !input.sequenceId?.trim() || !input.expectedRevision) throw new Error("INVALID_BRIEF_TARGET: project, sequence and revision are required");
    const project = await this.options.openProject(input.projectId);
    const actual = project.timeline.revision;
    if (project.timeline.project.id !== input.projectId || project.timeline.sequence.id !== input.sequenceId
      || actual.id !== input.expectedRevision.id || actual.sequence !== input.expectedRevision.sequence || actual.timestamp !== input.expectedRevision.timestamp) {
      throw new Error("STALE_CONTEXT: project, sequence or revision differs from the reviewed target");
    }
    return project;
  }
}

function projectDigest(project: FramekitProjectDocument): string {
  return createHash("sha256").update(JSON.stringify(project.timeline)).digest("hex");
}
function registeredMedia(project: FramekitProjectDocument): MediaSourceIdentity[] {
  return project.timeline.resources.flatMap((resource) => {
    const duration = resource.metadata?.durationTime;
    if (resource.sourceKind !== "local-file" || !resource.source || !resource.sourceDigest || !duration
      || !/^-?\d+$/.test(duration.value) || !/^\d+$/.test(duration.timescale) || BigInt(duration.timescale) <= 0n) return [];
    const seconds = Number(duration.value) / Number(duration.timescale);
    if (!Number.isFinite(seconds) || seconds <= 0) return [];
    return [{ mediaId: resource.id, source: resource.source, sourceDigest: resource.sourceDigest, duration: seconds,
      ...(resource.mediaKind === "video" || resource.mediaKind === "audio" ? { mediaKind: resource.mediaKind } : {}) }];
  });
}
function view(record: StoredCreativeBrief, project: FramekitProjectDocument): CreativeBriefView {
  const review = reviewCreativeBrief(record.brief);
  const media = registeredMedia(project);
  const sourceCoverage = review.missingCoverage.length === 0 && record.brief.sourceCoverage.every((coverage) => {
    const matches = media.filter((source) => source.mediaId === coverage.sourceId);
    const source = matches.length === 1 ? matches[0] : undefined;
    return !!source && !!coverage.sourceDigest && !!source.sourceDigest
      && source.sourceDigest.replace(/^sha256:/, "") === coverage.sourceDigest.replace(/^sha256:/, "")
      && source.duration !== undefined && source.duration >= coverage.end;
  }) ? "matched" : "unavailable";
  return { record, review, sourceCoverage, notice: "Source identity and range do not establish content meaning; review the content. Brief acceptance does not authorize an edit." };
}
