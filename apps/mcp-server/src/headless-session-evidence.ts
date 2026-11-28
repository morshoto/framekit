import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ContextRevision, FramekitProjectDocument } from "@framekit/runtime";
import type { HeadlessRenderRecord } from "@framekit/headless-application";

export interface SessionEvidenceBinding {
  projectId: string;
  sequenceId: string;
  revision: ContextRevision;
  timelineDigest: string;
  briefDigest: string;
}
interface ObservedEdit {
  committed: true;
  undoId: string;
  before: { timeline: FramekitProjectDocument["timeline"] };
  after: { timeline: FramekitProjectDocument["timeline"] };
}
interface Step {
  kind: "approved-edit" | "approved-decision";
  planDigest?: string;
  before: ContextRevision;
  after: ContextRevision;
  undoId: string;
}
interface Session {
  base: SessionEvidenceBinding;
  current: SessionEvidenceBinding;
  steps: Step[];
  invalid: boolean;
  render?: HeadlessRenderRecord;
  expiresAt: number;
}
const notice = "Same-process observations start at the caller-confirmed baseline and exclude earlier history. They do not authenticate a human, protect against external tampering, establish continuous source integrity, verify content meaning, or prove native execution.";
const hashTimeline = (timeline: unknown) => createHash("sha256").update(JSON.stringify(timeline)).digest("hex");

/** Ephemeral server-owned journal; no caller-supplied receipts can be inserted through MCP. */
export class HeadlessSessionEvidenceLedger {
  private readonly sessions = new Map<string, Session>();
  hasTarget(projectId: string, sequenceId: string): boolean {
    return [...this.sessions.values()].some((session) => !session.invalid && session.expiresAt > Date.now()
      && session.base.projectId === projectId && session.base.sequenceId === sequenceId);
  }
  begin(binding: SessionEvidenceBinding, confirmed: boolean): string {
    if (confirmed !== true) throw new Error("EVIDENCE_CONFIRMATION_REQUIRED: confirm the current baseline");
    if (!binding.projectId || !binding.sequenceId || !/^[a-f0-9]{64}$/.test(binding.timelineDigest) || !/^[a-f0-9]{64}$/.test(binding.briefDigest)
      || !binding.revision?.id || !Number.isSafeInteger(binding.revision.sequence) || binding.revision.sequence < 0 || !binding.revision.timestamp) throw new Error("EVIDENCE_INVALID_BASELINE: exact target and revision are required");
    const now = Date.now();
    for (const [id, item] of this.sessions) if (item.expiresAt <= now) this.sessions.delete(id);
    while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    const id = `evidence-${randomUUID()}`;
    this.sessions.set(id, { base: structuredClone(binding), current: structuredClone(binding), steps: [], invalid: false, expiresAt: now + 2 * 60 * 60 * 1000 });
    return id;
  }
  invalidate(projectId: string, sequenceId: string): void {
    for (const session of this.sessions.values()) if (session.base.projectId === projectId && session.base.sequenceId === sequenceId) session.invalid = true;
  }
  recordEdit(projectId: string, sequenceId: string, edit: ObservedEdit, kind: Step["kind"], planDigest?: string): void {
    for (const session of this.sessions.values()) {
      if (session.base.projectId !== projectId || session.base.sequenceId !== sequenceId || session.invalid) continue;
      try {
        const before = edit.before.timeline; const after = edit.after.timeline;
        if (session.expiresAt <= Date.now() || session.steps.length >= 128 || edit.committed !== true || !edit.undoId
          || before.project.id !== projectId || after.project.id !== projectId || before.sequence.id !== sequenceId || after.sequence.id !== sequenceId
          || !isDeepStrictEqual(before.revision, session.current.revision) || hashTimeline(before) !== session.current.timelineDigest
          || after.revision.sequence !== before.revision.sequence + 1 || !after.revision.id || !after.revision.timestamp
          || (kind === "approved-decision" && !/^sha256:[a-f0-9]{64}$/.test(planDigest ?? ""))) throw new Error("unbound edit");
        session.steps.push({ kind, ...(planDigest ? { planDigest } : {}), before: structuredClone(before.revision), after: structuredClone(after.revision), undoId: edit.undoId });
        session.current = { ...session.current, revision: structuredClone(after.revision), timelineDigest: hashTimeline(after) };
        delete session.render;
      } catch { session.invalid = true; }
    }
  }
  recordRender(projectId: string, sequenceId: string, record: HeadlessRenderRecord): void {
    for (const session of this.sessions.values()) {
      if (session.base.projectId !== projectId || session.base.sequenceId !== sequenceId || session.invalid) continue;
      try {
        const outcome = record.outcome as { plan?: { timeline?: unknown } };
        const bound = record.projectId === projectId && record.sequenceId === sequenceId
          && isDeepStrictEqual(record.requestedRevision, session.current.revision) && outcome.plan?.timeline
          && hashTimeline(outcome.plan.timeline) === session.current.timelineDigest;
        if (record.status === "failed" && bound) continue;
        delete session.render;
        if (record.status !== "passed" || !bound) continue;
        session.render = JSON.parse(JSON.stringify(record)) as HeadlessRenderRecord;
      } catch { session.invalid = true; }
    }
  }
  inspect(id: string, current: SessionEvidenceBinding, record: HeadlessRenderRecord): { status: "observed" | "unavailable"; steps?: Step[]; baseline?: SessionEvidenceBinding; notice: string } {
    const session = this.sessions.get(id);
    if (!session || session.invalid || session.expiresAt <= Date.now() || !session.steps.length
      || !session.steps.some((step) => step.kind === "approved-decision") || !session.render
      || !isDeepStrictEqual(session.current, current) || !isDeepStrictEqual(session.render, record)) return { status: "unavailable", notice };
    return { status: "observed", baseline: structuredClone(session.base), steps: structuredClone(session.steps), notice };
  }
}
