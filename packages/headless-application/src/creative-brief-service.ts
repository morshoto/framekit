import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acceptCreativeBrief, assertBriefSourceCoverage, inspectBriefTimelineCoverage, reviewCreativeBrief } from "@framekit/runtime";
import type { CreativeBrief, CreativeBriefProjectBinding, CreativeBriefReview, CreativeBriefStore, FramekitProjectDocument, MediaSourceIdentity, StoredCreativeBrief, ContextRevision } from "@framekit/runtime";
import type { FramekitRenderAndVerifyResult } from "@framekit/runtime";
import type { HeadlessRenderRecord, HeadlessRenderReverification } from "./headless-projects.js";

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
  /** Excludes cooperating project writes until the callback finishes. */
  withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
  storeForProject(projectId: string): CreativeBriefStore;
  render?: { inspect(renderId: string): Promise<HeadlessRenderRecord>; reverify(renderId: string): Promise<HeadlessRenderReverification> };
}

export interface BriefRenderInspection {
  status: "incomplete" | "unavailable";
  nativeAcceptance: "unavailable";
  checks: { name: "duration" | "aspect-ratio" | "source-coverage" | "music" | "captions"; status: "matches" | "does-not-match" | "unavailable"; detail: string; expected?: unknown; observed?: unknown; nextStep?: string }[];
  binding?: { projectId: string; sequenceId: string; revision: ContextRevision; briefDigest: string; timelineDigest: string; artifactDigest: string };
  reviewPrompts: string[];
  notice: string;
}

export interface BriefRenderCorrectionPreview {
  status: "available" | "unavailable";
  reviewRequired: true;
  binding?: NonNullable<BriefRenderInspection["binding"]> & { renderId: string };
  planDigest?: string;
  aspectRatio?: { dimensions: { width: number; height: number }; rationale: string };
  duration: { status: "unavailable" | "not-needed"; detail: string };
  notice: string;
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

  /** Point-in-time source placement inspection; this does not assess a render. */
  async inspectTimelineCoverage(input: CreativeBriefTarget) {
    input = structuredClone(input);
    const store = this.options.storeForProject(input.projectId);
    const record = await store.read(input.projectId);
    if (record.state !== "accepted" || !record.projectBinding) throw new Error("BRIEF_NOT_ACCEPTED: a project-bound accepted brief is required");
    return store.withAcceptedBrief(input.projectId, record.accepted, async () => {
      const before = await this.openTarget(input);
      assertCreativeBriefProjectBinding(record.projectBinding!, before);
      const result = inspectBriefTimelineCoverage(record.brief, record.accepted, before.timeline);
      const after = await this.openTarget(input);
      if (projectDigest(before) !== projectDigest(after)) throw new Error("STALE_CONTEXT: project changed during coverage inspection");
      assertCreativeBriefProjectBinding(record.projectBinding!, after);
      return { ...result, binding: { projectId: input.projectId, sequenceId: input.sequenceId,
        revision: structuredClone(after.timeline.revision), timelineDigest: record.projectBinding!.timelineDigest, briefDigest: record.accepted.digest } };
    });
  }

  /** Compare only measurable output properties; this does not attest the edit chain. */
  async inspectRender(input: CreativeBriefTarget & { renderId: string }): Promise<BriefRenderInspection> {
    input = structuredClone(input);
    const notice = "Point-in-time comparison only; this does not authenticate the render record, editing approvals or execution, establish full brief conformance, or verify native editing.";
    const checks: BriefRenderInspection["checks"] = [
      { name: "duration", status: "unavailable", detail: "A current bound artifact has not been verified.", nextStep: "Reverify a render of the accepted target revision." },
      { name: "aspect-ratio", status: "unavailable", detail: "A current bound artifact or comparable ratio is unavailable.", nextStep: "Reverify the render and review the requested aspect ratio." },
      { name: "source-coverage", status: "unavailable", detail: "Source content in the rendered artifact has not been independently verified.", nextStep: "Independently verify required source content in the output." },
      { name: "music", status: "unavailable", detail: "Music placement and audible output have not been established.", nextStep: "Review music placement and listen to the output." },
      { name: "captions", status: "unavailable", detail: "Editable caption and rendered appearance have not been established.", nextStep: "Review captions in the output and the target editor." },
    ];
    const store = this.options.storeForProject(input.projectId);
    const record = await store.read(input.projectId);
    if (record.state !== "accepted" || !record.projectBinding) throw new Error("BRIEF_NOT_ACCEPTED: a project-bound accepted brief is required");
    const unavailable = (): BriefRenderInspection => ({ status: "unavailable", nativeAcceptance: "unavailable", checks, reviewPrompts: [...record.brief.reviewPrompts], notice });
    if (!this.options.render) return unavailable();
    const render = this.options.render;
    return store.withAcceptedBrief(input.projectId, record.accepted, async () => {
      const before = await this.openTarget(input);
      assertCreativeBriefProjectBinding(record.projectBinding!, before);
      const original = await render.inspect(input.renderId);
      const outcome = original.outcome as FramekitRenderAndVerifyResult | undefined;
      if (original.renderId !== input.renderId || original.status !== "passed" || original.projectId !== input.projectId
        || original.sequenceId !== input.sequenceId || !isDeepStrictEqual(original.requestedRevision, before.timeline.revision)
        || !outcome?.plan || !isDeepStrictEqual(outcome.plan.timeline, before.timeline)) return unavailable();
      const verification = await render.reverify(input.renderId);
      const observation = verification.observation;
      if (verification.renderId !== input.renderId || verification.status !== "verified" || !observation || observation.status !== "passed"
        || observation.target?.projectId !== input.projectId || observation.target?.sequenceId !== input.sequenceId
        || !isDeepStrictEqual(observation.revision, before.timeline.revision) || !/^[a-f0-9]{64}$/.test(observation.fileDigest)
        || !Number.isFinite(observation.durationSeconds) || observation.durationSeconds <= 0
        || !Number.isSafeInteger(observation.width) || observation.width <= 0 || !Number.isSafeInteger(observation.height) || observation.height <= 0) return unavailable();
      const after = await this.openTarget(input);
      assertCreativeBriefProjectBinding(record.projectBinding!, after);
      if (!isDeepStrictEqual(before.timeline, after.timeline) || !isDeepStrictEqual(original, await render.inspect(input.renderId))) return unavailable();
      const finalVerification = await render.reverify(input.renderId);
      if (finalVerification.renderId !== input.renderId || finalVerification.status !== "verified" || !isDeepStrictEqual(observation, finalVerification.observation)) return unavailable();
      const finalProject = await this.openTarget(input);
      assertCreativeBriefProjectBinding(record.projectBinding!, finalProject);
      if (!isDeepStrictEqual(before.timeline, finalProject.timeline) || !isDeepStrictEqual(original, await render.inspect(input.renderId))) return unavailable();
      const duration = record.brief.durationSeconds;
      checks[0]!.status = observation.durationSeconds >= duration.min && observation.durationSeconds <= duration.max ? "matches" : "does-not-match";
      checks[0]!.detail = "Reverified output duration compared with the accepted range.";
      checks[0]!.expected = structuredClone(duration); checks[0]!.observed = observation.durationSeconds;
      if (checks[0]!.status === "does-not-match") checks[0]!.nextStep = "Review a revised edit plan and separately approve any changes.";
      else delete checks[0]!.nextStep;
      const ratio = /^(\d+):(\d+)$/.exec(record.brief.aspectRatio);
      if (ratio && Number.isSafeInteger(Number(ratio[1])) && Number.isSafeInteger(Number(ratio[2])) && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) {
        checks[1]!.status = BigInt(observation.width) * BigInt(ratio[2]!) === BigInt(observation.height) * BigInt(ratio[1]!) ? "matches" : "does-not-match";
        checks[1]!.detail = "Reverified output dimensions compared with the accepted ratio.";
        checks[1]!.expected = record.brief.aspectRatio; checks[1]!.observed = { width: observation.width, height: observation.height };
        if (checks[1]!.status === "does-not-match") checks[1]!.nextStep = "Review a revised output plan and separately approve any changes.";
        else delete checks[1]!.nextStep;
      }
      return { status: "incomplete", nativeAcceptance: "unavailable", checks, reviewPrompts: [...record.brief.reviewPrompts], notice,
        binding: { projectId: input.projectId, sequenceId: input.sequenceId, revision: structuredClone(after.timeline.revision),
          briefDigest: record.accepted.digest, timelineDigest: record.projectBinding!.timelineDigest, artifactDigest: observation.fileDigest } };
    });
  }

  /** Review-only sizing proposal; no export destination or mutation is authorized. */
  async previewRenderCorrection(input: CreativeBriefTarget & { renderId: string }): Promise<BriefRenderCorrectionPreview> {
    input = structuredClone(input);
    const result = await this.inspectRender(input);
    const notice = "Review only; changing output dimensions may stretch or distort footage and reduce resolution. This does not authorize a render or edit; choose a new output path and review the result.";
    const duration = result.checks.find((check) => check.name === "duration")?.status === "matches"
      ? { status: "not-needed" as const, detail: "The verified duration matches the brief." }
      : { status: "unavailable" as const, detail: "Duration correction requires a separately reviewed editorial decision; no cut or extension is proposed." };
    const unavailable = (): BriefRenderCorrectionPreview => ({ status: "unavailable", reviewRequired: true, duration, notice });
    const aspect = result.checks.find((check) => check.name === "aspect-ratio");
    if (result.status !== "incomplete" || !result.binding || aspect?.status !== "does-not-match" || typeof aspect.expected !== "string"
      || !aspect.observed || typeof aspect.observed !== "object") return unavailable();
    const ratio = /^(\d+):(\d+)$/.exec(aspect.expected);
    const observed = aspect.observed as { width?: number; height?: number };
    if (!ratio || !Number.isSafeInteger(Number(ratio[1])) || !Number.isSafeInteger(Number(ratio[2]))
      || Number(ratio[1]) <= 0 || Number(ratio[2]) <= 0 || !Number.isSafeInteger(observed.width) || !Number.isSafeInteger(observed.height)
      || observed.width! <= 0 || observed.height! <= 0) return unavailable();
    let numerator = BigInt(ratio[1]!); let denominator = BigInt(ratio[2]!);
    let a = numerator; let b = denominator;
    while (b !== 0n) [a, b] = [b, a % b];
    numerator /= a; denominator /= a;
    let scale = BigInt(observed.width!) / numerator;
    const heightScale = BigInt(observed.height!) / denominator;
    if (heightScale < scale) scale = heightScale;
    if (numerator % 2n !== 0n || denominator % 2n !== 0n) scale -= scale % 2n;
    if (scale <= 0n) return unavailable();
    const dimensions = { width: Number(numerator * scale), height: Number(denominator * scale) };
    const binding = { ...structuredClone(result.binding), renderId: input.renderId };
    const content = { binding, dimensions, duration };
    return { status: "available", reviewRequired: true, binding, planDigest: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
      aspectRatio: { dimensions, rationale: "Largest even dimensions with the approved ratio that fit within the previous output dimensions." }, duration, notice };
  }

  async revise(input: CreativeBriefTarget & { expectedDigest: string; brief: CreativeBrief }): Promise<CreativeBriefView> {
    const project = await this.openTarget(input);
    const record = await this.options.storeForProject(input.projectId).revise(input.projectId, input.expectedDigest, input.brief);
    return view(record, project);
  }

  async accept(input: CreativeBriefTarget & { expectedDigest: string; confirmed: boolean }): Promise<CreativeBriefView> {
    input = structuredClone(input);
    if (input.confirmed !== true) throw new Error("BRIEF_CONFIRMATION_REQUIRED: acceptance requires explicit confirmation");
    const before = await this.openTarget(input);
    const store = this.options.storeForProject(input.projectId);
    const draft = await store.read(input.projectId);
    if (draft.digest !== input.expectedDigest) throw new Error("STALE_BRIEF: reviewed brief changed");
    const acceptance = acceptCreativeBrief(draft.brief);
    assertBriefSourceCoverage(acceptance, draft.brief, registeredMedia(before));
    let after!: FramekitProjectDocument;
    const accepted = await store.accept(input.projectId, input.expectedDigest, (publish) => this.options.withProjectLock(input.projectId, async () => {
      after = await this.openTarget(input);
      if (projectDigest(before) !== projectDigest(after)) throw new Error("STALE_CONTEXT: project changed during brief acceptance");
      assertBriefSourceCoverage(acceptance, draft.brief, registeredMedia(after));
      return publish();
    }), creativeBriefProjectBinding(before));
    return view(accepted, after);
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
export function creativeBriefProjectBinding(project: FramekitProjectDocument): CreativeBriefProjectBinding {
  return { sequenceId: project.timeline.sequence.id, revision: structuredClone(project.timeline.revision), timelineDigest: projectDigest(project) };
}

export function assertCreativeBriefProjectBinding(expected: CreativeBriefProjectBinding, project: FramekitProjectDocument): void {
  const current = creativeBriefProjectBinding(project);
  if (expected.sequenceId !== current.sequenceId || expected.timelineDigest !== current.timelineDigest
    || expected.revision.id !== current.revision.id || expected.revision.sequence !== current.revision.sequence
    || expected.revision.timestamp !== current.revision.timestamp) {
    throw new Error("STALE_CONTEXT: accepted brief belongs to a different project revision");
  }
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
