import { isAbsolute } from "node:path";
import type { FileCanonicalRecoveryGuard } from "@framekit/final-cut";

/** Immutable data recorded before dispatch. A local dispatch ID is not a receiver receipt. */
export interface RecoveryBinding {
  kind: "publish" | "materialization";
  reservationId: string;
  dispatchId: string;
  jobId: string;
  executorIdentity: string;
  target: Record<string, string>;
  expectedDigest: string;
  outcome: "completed" | "restored";
}

/** The source must establish that this receiver cannot resume the identified operation. */
export interface ReceiverObservation {
  reservationId: string;
  dispatchId: string;
  jobId: string;
  executorIdentity: string;
  state: "running" | "terminal";
  outcome: "completed" | "failed";
  receiptId: string;
}

/** Obtained independently after receiver quiescence, never inferred from the dispatch response. */
export interface CanonicalRecoveryObservation {
  target: Record<string, string>;
  digest: string;
  complete: boolean;
  sourceIntegrity: boolean;
  unrelatedProjectsUnchanged: boolean;
}

/** Only a trusted receiver and a separately trusted canonical reader may implement these ports. */
export interface NativeRecoveryEvidenceSource {
  observeReceiver(binding: Readonly<RecoveryBinding>): Promise<ReceiverObservation>;
  readCanonical(binding: Readonly<RecoveryBinding>): Promise<CanonicalRecoveryObservation>;
}

function invalid(): never {
  throw new Error("RECOVERY_EVIDENCE_INVALID: recovery evidence is incomplete or does not match the reserved operation");
}

/** Read an immutable v4 intent; a receiver must independently authenticate the identity. */
export async function recoveryBindingFromReservation(
  guard: Pick<FileCanonicalRecoveryGuard, "inspectNativeReservation">,
  expectedReservationId: string,
  outcome: RecoveryBinding["outcome"],
): Promise<RecoveryBinding> {
  const reservation = await guard.inspectNativeReservation();
  return bindingFromRecord(reservation, expectedReservationId, outcome);
}

function bindingFromRecord(
  reservation: Awaited<ReturnType<FileCanonicalRecoveryGuard["inspectNativeReservation"]>>,
  expectedReservationId: string,
  outcome: RecoveryBinding["outcome"],
): RecoveryBinding {
  const context = reservation?.recoveryContext;
  if (!reservation || reservation.reservationId !== expectedReservationId || !context
    || typeof context.executorIdentity !== "string" || !("canonicalTarget" in context)
    || (outcome !== "completed" && outcome !== "restored")) invalid();
  const expectedDigest = outcome === "completed" ? context.expectedCanonicalDigest : context.expectedRestoreDigest;
  if (!expectedDigest) invalid();
  return { kind: context.kind, reservationId: reservation.reservationId, dispatchId: context.dispatchId, jobId: context.jobId,
    executorIdentity: context.executorIdentity, target: structuredClone(context.canonicalTarget), expectedDigest, outcome };
}

/** Internal only: production does not configure an authoritative receiver source. */
export async function recoverVerifiedNative(
  guard: Pick<FileCanonicalRecoveryGuard, "completeVerifiedNative">,
  expectedReservationId: string,
  outcome: RecoveryBinding["outcome"],
  source: NativeRecoveryEvidenceSource,
): Promise<{ outcome: RecoveryBinding["outcome"]; alreadyReleased: boolean }> {
  return guard.completeVerifiedNative(expectedReservationId, outcome, async (reservation) => {
    const binding = bindingFromRecord(reservation, expectedReservationId, outcome);
    return verifyNativeRecovery(binding, source);
  });
}

function targetMatches(kind: RecoveryBinding["kind"], expected: Record<string, string>, observed: Record<string, string>): boolean {
  const keys = kind === "publish" ? ["libraryPath", "projectUid", "sequenceUid"] : ["libraryUid", "eventUid", "projectUid", "sequenceUid"];
  if (!expected || !observed || Object.keys(expected).length !== keys.length || Object.keys(observed).length !== keys.length) return false;
  return keys.every((key) => typeof expected[key] === "string" && expected[key].trim().length > 0
    && expected[key].length <= 4096 && observed[key] === expected[key]);
}

/**
 * Validate evidence only. This does not release a reservation or implement a receiver.
 * No source is configured by default; an executor promise is not a suitable source.
 */
export async function verifyNativeRecovery(binding: RecoveryBinding, source: NativeRecoveryEvidenceSource): Promise<{ receiptId: string; outcome: RecoveryBinding["outcome"] }> {
  const expected = structuredClone(binding);
  if (!/^[a-f0-9]{64}$/.test(expected.reservationId) || !/^[a-f0-9]{64}$/.test(expected.expectedDigest)
    || ![expected.dispatchId, expected.jobId, expected.executorIdentity].every((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1024)
    || (expected.kind !== "publish" && expected.kind !== "materialization")
    || (expected.outcome !== "completed" && expected.outcome !== "restored")
    || !targetMatches(expected.kind, expected.target, expected.target)
    || (expected.kind === "publish" && (!isAbsolute(expected.target.libraryPath) || !expected.target.libraryPath.endsWith(".fcpbundle")))) invalid();
  const receipt = await source.observeReceiver(structuredClone(expected));
  if (!receipt || receipt.state !== "terminal" || receipt.reservationId !== expected.reservationId
    || receipt.dispatchId !== expected.dispatchId || receipt.jobId !== expected.jobId
    || receipt.executorIdentity !== expected.executorIdentity
    || (receipt.outcome !== "completed" && receipt.outcome !== "failed")
    || (expected.outcome === "completed" && receipt.outcome !== "completed")
    || typeof receipt.receiptId !== "string" || !receipt.receiptId.trim() || receipt.receiptId.length > 1024) invalid();
  const firstReceipt = structuredClone(receipt);
  const observed = await source.readCanonical(structuredClone(expected));
  if (!observed || !targetMatches(expected.kind, expected.target, observed.target)
    || observed.digest !== expected.expectedDigest || observed.complete !== true
    || observed.sourceIntegrity !== true || observed.unrelatedProjectsUnchanged !== true) invalid();
  const finalReceipt = await source.observeReceiver(structuredClone(expected));
  if (!finalReceipt || finalReceipt.state !== "terminal" || finalReceipt.reservationId !== firstReceipt.reservationId
    || finalReceipt.dispatchId !== firstReceipt.dispatchId || finalReceipt.jobId !== firstReceipt.jobId
    || finalReceipt.executorIdentity !== firstReceipt.executorIdentity || finalReceipt.outcome !== firstReceipt.outcome
    || finalReceipt.receiptId !== firstReceipt.receiptId) invalid();
  return { receiptId: firstReceipt.receiptId, outcome: expected.outcome };
}
