import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertCurrentAcceptedBrief, createEditDecisionPlan, sameAnalyzerDescriptor } from "@framekit/runtime";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier, CreativeBriefStore, EditDecisionPlanRequest, EditDecisionPlanResult, ProjectSnapshot, SemanticMediaIndexStore, MediaUnderstanding, AnalyzerDescriptor } from "@framekit/runtime";

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
      return result;
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : "Headless decision planning failed" };
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
      if (!isDeepStrictEqual(relevant(current), relevant(pinned))) {
        throw new Error("ANALYSIS_STALE: relevant source analysis changed after pinning");
      }
    }
  }
}
