import { isDeepStrictEqual } from "node:util";
import { assertCurrentAcceptedBrief, createEditDecisionPlan } from "@framekit/runtime";
import type { AnalysisArtifactStore, AnalysisEvidenceContext, AnalysisRef, AnalysisSourceVerifier, CreativeBriefStore, EditDecisionPlanRequest, EditDecisionPlanResult, ProjectSnapshot } from "@framekit/runtime";

export type HeadlessDecisionRequest = Omit<EditDecisionPlanRequest, "snapshot" | "brief" | "accepted" | "speechContext" | "vadContext" | "audioContext">;

/** Read-only proposal; it neither approves nor executes any editor operation. */
export class HeadlessDecisionPlanService {
  constructor(private readonly options: {
    readProject(projectId: string): Promise<ProjectSnapshot>;
    storeForProject(projectId: string): CreativeBriefStore;
    artifacts: AnalysisArtifactStore;
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
      const result = await createEditDecisionPlan({ ...input, snapshot: before, brief: brief.brief, accepted: brief.accepted,
        speechContext: context(input.speechRef), vadContext: context(input.vadRef), audioContext: context(input.audioRef),
      }, this.options.artifacts, this.options.verifySource, store);
      if (result.status !== "available") return result;
      const after = await this.options.readProject(input.projectId);
      if (!isDeepStrictEqual(before, after)) return { status: "unavailable", reason: "STALE_CONTEXT: project changed during planning" };
      await assertCurrentAcceptedBrief(store, input.projectId, brief.accepted);
      return result;
    } catch (error) {
      return { status: "unavailable", reason: error instanceof Error ? error.message : "Headless decision planning failed" };
    }
  }
}
