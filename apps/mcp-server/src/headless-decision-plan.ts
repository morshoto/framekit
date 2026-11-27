import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertBriefSourceCoverage, assertCurrentAcceptedBrief, createEditDecisionPlan, sameAnalyzerDescriptor } from "@framekit/runtime";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier, CreativeBriefStore, EditDecisionPlan, EditDecisionPlanRequest, EditDecisionPlanResult, ProjectSnapshot, ProjectStore, SemanticMediaIndexStore, MediaUnderstanding, AnalyzerDescriptor } from "@framekit/runtime";

export type HeadlessDecisionRequest = Omit<EditDecisionPlanRequest, "snapshot" | "brief" | "accepted" | "speechContext" | "vadContext" | "audioContext">;

/** Read-only proposal; it neither approves nor executes any editor operation. */
export class HeadlessDecisionPlanService {
  constructor(private readonly options: {
    readProject(projectId: string): Promise<ProjectSnapshot>;
    storeForProject(projectId: string): CreativeBriefStore;
    artifacts: AnalysisArtifactStore;
    index: SemanticMediaIndexStore;
    currentProvider(kind: "speech" | "vad" | "audio"): AnalyzerDescriptor | undefined;
    verifySource: AnalysisSourceVerifier;
  }) {}

  async plan(input: HeadlessDecisionRequest): Promise<EditDecisionPlanResult> {
    try {
      input = structuredClone(input);
      const before = await this.options.readProject(input.projectId);
      const store = this.options.storeForProject(input.projectId);
      const brief = await store.read(input.projectId);
      if (brief.state !== "accepted") return { status: "unavailable", reason: "BRIEF_NOT_ACCEPTED: review and accept the current brief first" };
      const context = (ref: AnalysisRef | undefined): AnalysisEvidenceContext | undefined => ref && ({
        kind: ref.kind, source: ref.source, provider: ref.provider, revision: input.revision, range: ref.range,
      });
      await this.assertCurrentEvidence(input);
      const result = await createEditDecisionPlan({ ...input, snapshot: before, brief: brief.brief, accepted: brief.accepted,
        speechContext: context(input.speechRef), vadContext: context(input.vadRef), audioContext: context(input.audioRef),
      }, this.options.artifacts, this.options.verifySource, store);
      if (result.status !== "available") return result;
      const after = await this.options.readProject(input.projectId);
      if (!isDeepStrictEqual(before, after)) return { status: "unavailable", reason: "STALE_CONTEXT: project changed during planning" };
      await this.assertCurrentEvidence(input);
      await assertCurrentAcceptedBrief(store, input.projectId, brief.accepted);
      this.assertCurrentProviders(input);
      return result;
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : "Headless decision planning failed" };
    }
  }

  /** Hold the cooperating brief-writer lock through the bound operation. */
  async withAcceptedPlan<T>(input: HeadlessDecisionRequest, digest: string, operation: (plan: EditDecisionPlan, lockedProject: ProjectStore) => Promise<T>): Promise<T> {
    input = structuredClone(input);
    const store = this.options.storeForProject(input.projectId);
    const brief = await store.read(input.projectId);
    if (brief.state !== "accepted") throw new Error("BRIEF_NOT_ACCEPTED: the current brief requires review");
    return store.withAcceptedBrief(input.projectId, brief.accepted, async (lockedProject) => {
      const current = await this.plan(input);
      if (current.status !== "available" || current.plan.planDigest !== digest) throw new Error("STALE_DECISION_PLAN: inputs changed after review");
      return operation(current.plan, lockedProject);
    });
  }

  /** Preserve the edit and Undo record if a post-commit check or lock release fails. */
  async executeAcceptedPlan<T>(input: HeadlessDecisionRequest, digest: string, execute: (lockedProject: ProjectStore) => Promise<T>, verify: (edit: T) => Promise<void>) {
    input = structuredClone(input);
    let committed: T | undefined;
    let completed = false;
    try {
      return await this.withAcceptedPlan(input, digest, async (plan, lockedProject) => {
        committed = await execute(lockedProject);
        completed = true;
        committed = structuredClone(committed);
        await verify(structuredClone(committed));
        await this.recheckEvidence(input, plan);
        await verify(structuredClone(committed));
        this.assertCurrentProviders(input);
        return { status: "applied" as const, edit: committed, planDigest: digest,
          notice: "Headless edit only; evidence checks are point-in-time and do not establish native execution or dialogue audibility." };
      });
    } catch (error) {
      if (!completed) throw error;
      return { status: "applied-unverified" as const, edit: committed as T, planDigest: digest,
        notice: "The edit committed, but a post-edit readback, evidence or lock check failed; inspect the project and Undo before continuing." };
    }
  }

  /** Recheck point-in-time source and analysis observations after a committed edit. */
  async recheckEvidence(input: HeadlessDecisionRequest, plan: EditDecisionPlan): Promise<void> {
    input = structuredClone(input);
    plan = structuredClone(plan);
    const store = this.options.storeForProject(input.projectId);
    const brief = await store.read(input.projectId);
    if (brief.state !== "accepted") throw new Error("BRIEF_NOT_ACCEPTED: the current brief requires review");
    await assertCurrentAcceptedBrief(store, input.projectId, plan.acceptedBrief);
    const snapshot = await this.options.readProject(input.projectId);
    assertBriefSourceCoverage(plan.acceptedBrief, brief.brief, snapshot.media);
    await this.assertCurrentEvidence(input);
    const sources = [plan.source, ...brief.brief.sourceCoverage.map((item) => snapshot.media.find((source) => source.mediaId === item.sourceId)!),
      ...[input.speechRef, input.vadRef, input.audioRef].flatMap((ref) => ref ? [ref.source] : []), ...(input.music.music ? [input.music.music] : [])];
    for (const source of sources) await this.options.verifySource(source);
    await this.assertCurrentEvidence(input);
    await assertCurrentAcceptedBrief(store, input.projectId, plan.acceptedBrief);
    this.assertCurrentProviders(input);
  }

  private assertCurrentProviders(input: HeadlessDecisionRequest): void {
    for (const ref of [input.speechRef, input.vadRef, input.audioRef]) {
      if (!ref) continue;
      const configured = this.options.currentProvider(ref.kind);
      if (!configured || !sameAnalyzerDescriptor(configured, ref.provider)) {
        throw new Error("ANALYSIS_STALE_PROVIDER: configured analyzer differs from the pinned reference");
      }
    }
  }

  private async assertCurrentEvidence(input: HeadlessDecisionRequest): Promise<void> {
    for (const ref of [input.speechRef, input.vadRef, input.audioRef]) {
      if (!ref) continue;
      const configured = this.options.currentProvider(ref.kind);
      if (!configured || !sameAnalyzerDescriptor(configured, ref.provider)) {
        throw new Error("ANALYSIS_STALE_PROVIDER: configured analyzer differs from the pinned reference");
      }
      const current = await this.options.index.load(ref.source);
      const bytes = await this.options.artifacts.get(ref.artifactDigest);
      if (!current || !bytes) throw new Error("ANALYSIS_STALE: current analysis or pinned artifact is unavailable");
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.artifactDigest) {
        throw new Error("ANALYSIS_STALE: pinned artifact digest mismatch");
      }
      const pinned = JSON.parse(Buffer.from(bytes).toString("utf8")) as MediaUnderstanding;
      const capability = ref.kind === "audio" ? "audio" : "speech";
      const relevant = (record: MediaUnderstanding) => ({ mediaId: record.mediaId, source: record.source, sourceIdentity: record.sourceIdentity, analysisRevision: record.analysisRevision,
        analysis: record.analysis.filter((item) => item.capability === capability),
        payload: capability === "audio" ? record.audio : record.speech });
      const latest = await this.options.index.load(ref.source);
      if (!latest || !isDeepStrictEqual(relevant(current), relevant(pinned)) || !isDeepStrictEqual(relevant(latest), relevant(pinned))) {
        throw new Error("ANALYSIS_STALE: relevant source analysis changed after pinning");
      }
    }
    this.assertCurrentProviders(input);
  }
}
