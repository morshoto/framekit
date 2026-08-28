import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentVideoRuntime, type ContextRevision, type EditOperation, type ProjectSnapshot, type RationalTime, type TimelineDiff, type WorkflowOperation } from "@framekit/runtime";
import { InMemoryEditorAdapter, type InMemoryFixture } from "@framekit/testkit";

export interface GoldenScenario {
  id: string;
  family: string;
  description: string;
  mode: "single" | "composite";
  fixture: InMemoryFixture;
  operation?: EditOperation;
  operations?: WorkflowOperation[];
  expected: GoldenExpected;
}

export interface GoldenExpected {
  before: ProjectSnapshot;
  after: ProjectSnapshot;
  diff: TimelineDiff;
  afterRevision: ContextRevision;
  undoRevision: ContextRevision;
  rollbackRevision: ContextRevision;
  staleErrorCode: string;
}

export interface GoldenCorpus {
  schemaVersion: number;
  corpusVersion: string;
  runtimeContract: string;
  scenarios: GoldenScenario[];
}

const corpusPath = fileURLToPath(new URL("./corpus.json", import.meta.url));

export function loadGoldenCorpus(): GoldenCorpus {
  const parsed: unknown = JSON.parse(readFileSync(corpusPath, "utf8"));
  assertCorpus(parsed);
  return parsed;
}

export async function runGoldenScenario(scenario: GoldenScenario): Promise<void> {
  assert.match(scenario.id, /^(phase0|phase1)\./, `invalid golden scenario id: ${scenario.id}`);
  assert.ok(scenario.family.length > 0, `golden scenario ${scenario.id} has no family`);
  assert.ok(scenario.description.length > 0, `golden scenario ${scenario.id} has no description`);
  validateGoldenSnapshot(scenario.expected.before, scenario.id);
  validateGoldenSnapshot(scenario.expected.after, scenario.id);
  assert.deepEqual(scenario.expected.diff.from, scenario.expected.before.revision, `${scenario.id}: diff source revision mismatch`);
  assert.deepEqual(scenario.expected.diff.to, scenario.expected.after.revision, `${scenario.id}: diff target revision mismatch`);

  const runtime = new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture));
  const before = await runtime.inspectProject();
  validateGoldenSnapshot(before, scenario.id);
  assert.deepEqual(before, scenario.expected.before, `${scenario.id}: before snapshot mismatch`);

  let transaction;
  if (scenario.mode === "single") {
    assert.ok(scenario.operation, `${scenario.id}: single scenario has no operation`);
    transaction = await runtime.edit(scenario.operation);
  } else {
    assert.ok(scenario.operations, `${scenario.id}: composite scenario has no operations`);
    const preview = await runtime.previewEdit({ baseRevision: before.revision, operations: scenario.operations });
    assert.deepEqual(preview.expectedDiff, scenario.expected.diff, `${scenario.id}: preview diff mismatch`);
    transaction = await runtime.executeEdit(preview.previewToken);
  }

  assert.equal(transaction.status, "VERIFIED", `${scenario.id}: workflow was not verified`);
  validateGoldenSnapshot(transaction.after, scenario.id);
  assert.deepEqual(transaction.after, scenario.expected.after, `${scenario.id}: after snapshot mismatch`);
  assert.deepEqual(transaction.diff, scenario.expected.diff, `${scenario.id}: diff mismatch`);
  assert.deepEqual(transaction.after.revision, scenario.expected.afterRevision, `${scenario.id}: after revision mismatch`);
  assert.deepEqual(await runtime.inspectProject(), scenario.expected.after, `${scenario.id}: read-after-write mismatch`);

  const undone = await runtime.undo(transaction.id);
  assert.deepEqual(undone, { ...scenario.expected.before, revision: scenario.expected.undoRevision }, `${scenario.id}: undo snapshot mismatch`);

  const rollbackRuntime = new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture), {
    verificationEngine: {
      verify: async () => ({
        passed: false,
        checks: [{ name: "golden-forced-failure", passed: false, detail: "exercise rollback gate" }],
      }),
    },
  });
  let rollbackTransaction;
  const rollbackBefore = await rollbackRuntime.inspectProject();
  if (scenario.mode === "single") {
    assert.ok(scenario.operation, `${scenario.id}: single scenario has no operation for rollback`);
    rollbackTransaction = await rollbackRuntime.edit(scenario.operation);
  } else {
    assert.ok(scenario.operations, `${scenario.id}: composite scenario has no operations for rollback`);
    const rollbackPreview = await rollbackRuntime.previewEdit({
      baseRevision: rollbackBefore.revision,
      operations: scenario.operations,
    });
    rollbackTransaction = await rollbackRuntime.executeEdit(rollbackPreview.previewToken);
  }
  assert.equal(rollbackTransaction.status, "ROLLED_BACK", `${scenario.id}: failed verification did not roll back`);
  const rollbackExpected = { ...scenario.expected.before, revision: scenario.expected.rollbackRevision };
  assert.deepEqual(rollbackTransaction.after, rollbackExpected, `${scenario.id}: rollback snapshot mismatch`);
  assert.deepEqual(await rollbackRuntime.inspectProject(), rollbackExpected, `${scenario.id}: rollback read mismatch`);

  const staleRuntime = new AgentVideoRuntime(new InMemoryEditorAdapter(scenario.fixture));
  const staleBase = await staleRuntime.inspectProject();
  if (scenario.mode === "single") {
    assert.ok(scenario.operation, `${scenario.id}: single scenario has no operation for stale-write check`);
    await staleRuntime.edit(scenario.operation);
    await assert.rejects(
      staleRuntime.edit({ ...scenario.operation, baseRevision: staleBase.revision }),
      new RegExp(scenario.expected.staleErrorCode),
    );
  } else {
    assert.ok(scenario.operations, `${scenario.id}: composite scenario has no operations for stale-write check`);
    const stalePreview = await staleRuntime.previewEdit({ baseRevision: staleBase.revision, operations: scenario.operations });
    await staleRuntime.executeEdit(stalePreview.previewToken);
    await assert.rejects(
      staleRuntime.previewEdit({ baseRevision: staleBase.revision, operations: scenario.operations }),
      new RegExp(scenario.expected.staleErrorCode),
    );
  }
  assert.deepEqual(await staleRuntime.inspectProject(), scenario.expected.after, `${scenario.id}: stale write mutated state`);
}

export function validateGoldenSnapshot(snapshot: ProjectSnapshot, scenarioId: string): void {
  const label = `${scenarioId}: snapshot`;
  assert.equal(typeof snapshot.projectId, "string", `${label} project identity is required`);
  assert.equal(typeof snapshot.timeline?.id, "string", `${label} timeline identity is required`);
  assert.ok(Array.isArray(snapshot.timeline?.clips), `${label} clips are required`);
  assert.ok(Array.isArray(snapshot.timeline?.storyElements), `${label} story elements are required`);
  assert.ok(Array.isArray(snapshot.timeline?.markers), `${label} markers are required`);
  assert.ok(Array.isArray(snapshot.timeline?.captions), `${label} captions are required`);
  assert.ok(Array.isArray(snapshot.media), `${label} media registry is required`);
  assert.equal(typeof snapshot.revision?.id, "string", `${label} revision identity is required`);
  assert.equal(Number.isInteger(snapshot.revision?.sequence), true, `${label} revision sequence is required`);
  assertUniqueIds(snapshot.timeline.clips, `${label} clip`);
  assertUniqueIds(snapshot.timeline.storyElements, `${label} story element`);
  assertUniqueIds(snapshot.timeline.markers, `${label} marker`);
  assertUniqueIds(snapshot.timeline.captions, `${label} caption`);
  assertUniqueIds(snapshot.media, `${label} media` , (media) => media.mediaId);
  assertRationalTiming(snapshot.timeline.clips, `${label} clip`);
  assertRationalTiming(snapshot.timeline.storyElements, `${label} story element`);
  assertRationalTiming(snapshot.timeline.markers, `${label} marker`);
  assertRationalTiming(snapshot.timeline.captions, `${label} caption`);
  const mediaIds = new Set(snapshot.media.map((media) => media.mediaId));
  for (const clip of snapshot.timeline.clips) {
    if (clip.mediaId) assert.equal(mediaIds.has(clip.mediaId), true, `${label} media reference ${clip.mediaId} is unresolved`);
  }
  for (const element of snapshot.timeline.storyElements) {
    if (element.mediaId) assert.equal(mediaIds.has(element.mediaId), true, `${label} media reference ${element.mediaId} is unresolved`);
  }
}

interface TimedSnapshotItem {
  id: string;
  start: number;
  duration: number;
  startTime?: RationalTime;
  durationTime?: RationalTime;
}

function assertRationalTiming(items: TimedSnapshotItem[], label: string): void {
  for (const item of items) {
    assert.equal(rationalMatchesNumber(item.startTime, item.start), true, `${label} ${item.id} startTime disagrees with start`);
    assert.equal(rationalMatchesNumber(item.durationTime, item.duration), true, `${label} ${item.id} durationTime disagrees with duration`);
  }
}

function rationalMatchesNumber(time: RationalTime | undefined, seconds: number): boolean {
  if (!time || !Number.isFinite(seconds) || typeof time.value !== "string" || typeof time.timescale !== "string") return false;
  try {
    const value = BigInt(time.value);
    const timescale = BigInt(time.timescale);
    if (timescale <= 0n) return false;
    const numeric = numberAsRational(seconds);
    const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(seconds));
    if (!Number.isFinite(tolerance)) return value * numeric.scale === numeric.value * timescale;
    const toleranceRational = numberAsRational(tolerance);
    const difference = (value * numeric.scale - numeric.value * timescale);
    return (difference < 0n ? -difference : difference) * toleranceRational.scale
      <= toleranceRational.value * timescale * numeric.scale;
  } catch {
    return false;
  }
}

function numberAsRational(value: number): { value: bigint; scale: bigint } {
  const [coefficient, exponentText = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const exponent = BigInt(exponentText.replace(/^\+/, ""));
  const coefficientValue = BigInt(`${whole}${fraction}`);
  const decimalPlaces = BigInt(fraction.length) - exponent;
  if (decimalPlaces >= 0n) return { value: coefficientValue, scale: 10n ** decimalPlaces };
  return { value: coefficientValue * (10n ** -decimalPlaces), scale: 1n };
}

function assertCorpus(value: unknown): asserts value is GoldenCorpus {
  assert.ok(value && typeof value === "object", "golden corpus must be an object");
  const corpus = value as Partial<GoldenCorpus>;
  assert.equal(corpus.schemaVersion, 1, "unsupported golden corpus schema");
  assert.equal(typeof corpus.corpusVersion, "string", "golden corpus version is required");
  assert.equal(typeof corpus.runtimeContract, "string", "golden corpus runtime contract is required");
  assert.ok(Array.isArray(corpus.scenarios), "golden corpus scenarios are required");

  const ids = new Set<string>();
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario && typeof scenario === "object", "golden scenario must be an object");
    assert.equal(typeof scenario.id, "string", "golden scenario id is required");
    assert.equal(typeof scenario.family, "string", `golden scenario ${scenario.id} family is required`);
    assert.equal(typeof scenario.description, "string", `golden scenario ${scenario.id} description is required`);
    assert.ok(scenario.mode === "single" || scenario.mode === "composite", `golden scenario ${scenario.id} mode is invalid`);
    assert.ok(scenario.fixture && typeof scenario.fixture === "object", `golden scenario ${scenario.id} fixture is required`);
    assert.ok(scenario.operation || scenario.operations, `golden scenario ${scenario.id} operation is required`);
    assert.ok(scenario.expected && typeof scenario.expected === "object", `golden scenario ${scenario.id} expected evidence is required`);
    assert.ok(scenario.expected.before && typeof scenario.expected.before === "object", `golden scenario ${scenario.id} before snapshot is required`);
    assert.ok(scenario.expected.after && typeof scenario.expected.after === "object", `golden scenario ${scenario.id} after snapshot is required`);
    assert.ok(scenario.expected.diff && typeof scenario.expected.diff === "object", `golden scenario ${scenario.id} diff is required`);
    assert.ok(scenario.expected.rollbackRevision && typeof scenario.expected.rollbackRevision === "object", `golden scenario ${scenario.id} rollback revision is required`);
    assert.equal(scenario.expected.staleErrorCode, "STALE_CONTEXT", `golden scenario ${scenario.id} stale diagnostic is required`);
    assert.equal(ids.has(scenario.id), false, `duplicate golden scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
}

function assertUniqueIds<T>(items: T[], label: string, idOf: (item: T) => string = (item) => (item as { id: string }).id): void {
  const ids = items.map(idOf);
  assert.equal(new Set(ids).size, ids.length, `${label} identities must be unique`);
}
