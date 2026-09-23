import { createHash } from "node:crypto";
import type { TimelineIr } from "@framekit/runtime";
import { timelineIrDigest, validateTimelineIr } from "@framekit/runtime";
import {
  decodeFinalCutKeyedArchive,
  type FinalCutGroundTruthSnapshot,
  type FinalCutKeyedArchiveJsonDecoder,
  type FinalCutSchemaFingerprint,
} from "./sqlite-experiment.js";

/** An encoder is supplied only after it has been proven against Final Cut output. */
export type FinalCutKeyedArchiveEncoder = (archive: unknown) => Promise<Uint8Array>;

export interface FinalCutArchiveRoundTripProof {
  originalDigest: string;
  encodedDigest: string;
  byteIdentical: true;
}

/**
 * Phase 5 gate. This never invents an NSKeyedArchiver encoder: the caller must
 * provide one and the bytes must be exactly identical for this proof to pass.
 */
export async function proveFinalCutArchiveByteRoundTrip(
  payload: Uint8Array,
  decoder: FinalCutKeyedArchiveJsonDecoder,
  encoder: FinalCutKeyedArchiveEncoder,
): Promise<FinalCutArchiveRoundTripProof> {
  const decoded = await decodeFinalCutKeyedArchive(payload, decoder);
  const encoded = await encoder(decoded);
  if (!Buffer.from(payload).equals(Buffer.from(encoded))) {
    throw new Error("FINAL_CUT_SHADOW_ARCHIVE_ROUND_TRIP_UNPROVEN: decode/encode bytes are not identical");
  }
  return {
    originalDigest: digest(payload),
    encodedDigest: digest(encoded),
    byteIdentical: true,
  };
}

export interface FinalCutGraphAllocationEvidence {
  existingCollectionPrimaryKeys: number[];
  existingMetadataPrimaryKeys: number[];
  existingCatalogPrimaryKeys: number[];
  existingIdentifiers: string[];
  primaryKeyMaxByEntity: Record<string, { entity: number; max: number }>;
  catalogEntity: number;
  metadataEntity: number;
}

export interface FinalCutVersionedGraphNode {
  logicalId: string;
  kind: "project" | "sequence" | "resource" | "occurrence" | "story-element" | "marker" | "caption";
  entity: number;
  primaryKey: number;
  optimisticVersion: 1;
  identifier: string;
  name: string;
  catalogPrimaryKey: number;
  catalogIdentifier: string;
  metadataPrimaryKey: number;
  metadataIdentifier: string;
  archive: Uint8Array;
}

export interface FinalCutVersionedGraphEdge {
  parentPrimaryKey: number;
  childPrimaryKey: number;
}

export interface FinalCutVersionedGraphPrimaryKeyUpdate {
  entity: number;
  expectedMax: number;
  nextMax: number;
}

/**
 * A typed, insert-only graph recipe. It contains no caller-provided SQL. The
 * shadow executor turns this shape into the small allowlisted transaction.
 */
export interface FinalCutVersionedGraphRecipe {
  kind: "versioned-project-materialization";
  fingerprint: FinalCutSchemaFingerprint;
  timelineDigest: string;
  projectUid: string;
  sequenceUid: string;
  nodes: FinalCutVersionedGraphNode[];
  edges: FinalCutVersionedGraphEdge[];
  primaryKeyUpdates: FinalCutVersionedGraphPrimaryKeyUpdate[];
  catalogEntity: number;
  metadataEntity: number;
}

export interface CompileFinalCutVersionedGraphRequest {
  timeline: TimelineIr;
  fingerprint: FinalCutSchemaFingerprint;
  existing: FinalCutGraphAllocationEvidence;
  projectUid: string;
  sequenceUid: string;
  archiveEncoder: (node: { logicalId: string; kind: FinalCutVersionedGraphNode["kind"]; name: string }) => Promise<Uint8Array>;
}

/**
 * Phase 6 compiler. IDs are allocated from observed maxima and identifiers are
 * deterministic, content-bound, and collision checked. Existing names are not
 * update targets; every node is an insert into a new versioned graph.
 */
export async function compileFinalCutVersionedGraphRecipe(
  request: CompileFinalCutVersionedGraphRequest,
): Promise<FinalCutVersionedGraphRecipe> {
  validateTimelineIr(request.timeline);
  requireText(request.projectUid, "projectUid");
  requireText(request.sequenceUid, "sequenceUid");
  validateAllocation(request.existing);

  const timelineDigest = timelineIrDigest(request.timeline);
  const digestPrefix = timelineDigest.slice(0, 16);
  const usedCollection = new Set(request.existing.existingCollectionPrimaryKeys);
  const usedMetadata = new Set(request.existing.existingMetadataPrimaryKeys);
  const usedCatalog = new Set(request.existing.existingCatalogPrimaryKeys);
  const usedIdentifiers = new Set(request.existing.existingIdentifiers);
  const collectionNext = nextPositive(usedCollection);
  const metadataNext = nextPositive(usedMetadata);
  const catalogNext = nextPositive(usedCatalog);
  let nextCollection = collectionNext;
  let nextMetadata = metadataNext;
  let nextCatalog = catalogNext;
  const entityByType = new Map<number, number>();
  for (const entry of Object.values(request.existing.primaryKeyMaxByEntity)) entityByType.set(entry.entity, entry.max);

  const descriptors: Array<{ logicalId: string; kind: FinalCutVersionedGraphNode["kind"]; name: string }> = [
    { logicalId: `project:${request.timeline.project.id}`, kind: "project", name: versionedName(request.timeline.project.name, digestPrefix) },
    { logicalId: `sequence:${request.timeline.sequence.id}`, kind: "sequence", name: versionedName(request.timeline.sequence.name, digestPrefix) },
    ...request.timeline.resources.map((resource) => ({ logicalId: `resource:${resource.id}`, kind: "resource" as const, name: resource.name })),
    ...request.timeline.sequence.occurrences.map((item) => ({ logicalId: `occurrence:${item.id}`, kind: "occurrence" as const, name: item.name })),
    ...request.timeline.sequence.storyElements.map((item) => ({ logicalId: `story-element:${item.id}`, kind: "story-element" as const, name: item.kind })),
    ...request.timeline.sequence.markers.map((item) => ({ logicalId: `marker:${item.id}`, kind: "marker" as const, name: item.name })),
    ...request.timeline.sequence.captions.map((item) => ({ logicalId: `caption:${item.id}`, kind: "caption" as const, name: item.text })),
  ];
  const nodes: FinalCutVersionedGraphNode[] = [];
  const nodeByLogicalId = new Map<string, FinalCutVersionedGraphNode>();
  for (const descriptor of descriptors) {
    const entityEntry = entityForKind(descriptor.kind, request.existing.primaryKeyMaxByEntity);
    if (!entityEntry) throw new Error(`FINAL_CUT_SHADOW_RECIPE_UNPROVEN: entity allocation is missing for ${descriptor.kind}`);
    const identifier = allocateIdentifier(`framekit-${descriptor.kind}`, descriptor.logicalId, digestPrefix, usedIdentifiers);
    const catalogIdentifier = allocateIdentifier("framekit-catalog", descriptor.logicalId, digestPrefix, usedIdentifiers);
    const node: FinalCutVersionedGraphNode = {
      logicalId: descriptor.logicalId,
      kind: descriptor.kind,
      entity: entityEntry.entity,
      primaryKey: allocateNumber(usedCollection, () => nextCollection++),
      optimisticVersion: 1,
      identifier,
      name: descriptor.name,
      catalogPrimaryKey: allocateNumber(usedCatalog, () => nextCatalog++),
      catalogIdentifier,
      metadataPrimaryKey: allocateNumber(usedMetadata, () => nextMetadata++),
      metadataIdentifier: `${identifier}-metadata`,
      archive: await request.archiveEncoder(descriptor),
    };
    if (!Buffer.from(node.archive).subarray(0, 8).equals(Buffer.from("bplist00", "ascii"))) {
      throw new Error(`FINAL_CUT_SHADOW_ARCHIVE_UNSUPPORTED: encoder returned a non-binary-plist archive for ${descriptor.logicalId}`);
    }
    nodes.push(node);
    nodeByLogicalId.set(descriptor.logicalId, node);
    entityByType.set(node.entity, (entityByType.get(node.entity) ?? entityEntry.max) + 1);
  }

  const edges: FinalCutVersionedGraphEdge[] = [];
  const project = nodeByLogicalId.get(`project:${request.timeline.project.id}`)!;
  const sequence = nodeByLogicalId.get(`sequence:${request.timeline.sequence.id}`)!;
  edges.push({ parentPrimaryKey: project.primaryKey, childPrimaryKey: sequence.primaryKey });
  for (const resource of request.timeline.resources) edges.push({ parentPrimaryKey: sequence.primaryKey, childPrimaryKey: nodeByLogicalId.get(`resource:${resource.id}`)!.primaryKey });
  for (const occurrence of request.timeline.sequence.occurrences) edges.push({ parentPrimaryKey: sequence.primaryKey, childPrimaryKey: nodeByLogicalId.get(`occurrence:${occurrence.id}`)!.primaryKey });
  for (const item of request.timeline.sequence.storyElements) edges.push({ parentPrimaryKey: sequence.primaryKey, childPrimaryKey: nodeByLogicalId.get(`story-element:${item.id}`)!.primaryKey });
  for (const marker of request.timeline.sequence.markers) edges.push({ parentPrimaryKey: sequence.primaryKey, childPrimaryKey: nodeByLogicalId.get(`marker:${marker.id}`)!.primaryKey });
  for (const caption of request.timeline.sequence.captions) edges.push({ parentPrimaryKey: sequence.primaryKey, childPrimaryKey: nodeByLogicalId.get(`caption:${caption.id}`)!.primaryKey });

  const primaryKeyUpdates = [...entityByType.entries()].map(([entity, nextMax]) => {
    const original = Object.values(request.existing.primaryKeyMaxByEntity).find((entry) => entry.entity === entity)!;
    return { entity, expectedMax: original.max, nextMax };
  }).filter((entry) => entry.nextMax > entry.expectedMax).sort((left, right) => left.entity - right.entity);
  return {
    kind: "versioned-project-materialization",
    fingerprint: request.fingerprint,
    timelineDigest,
    projectUid: request.projectUid,
    sequenceUid: request.sequenceUid,
    nodes,
    edges,
    primaryKeyUpdates,
    catalogEntity: request.existing.catalogEntity,
    metadataEntity: request.existing.metadataEntity,
  };
}

/** Build the only SQL accepted for a versioned graph recipe. */
export function buildFinalCutVersionedGraphSql(recipe: FinalCutVersionedGraphRecipe): { sql: string; expectedCasUpdates: number } {
  if (recipe.kind !== "versioned-project-materialization" || recipe.nodes.length === 0) {
    throw new Error("FINAL_CUT_SHADOW_RECIPE_INVALID: versioned graph is empty or unsupported");
  }
  const statements = ["BEGIN IMMEDIATE;"];
  for (const update of recipe.primaryKeyUpdates) {
    statements.push(`UPDATE Z_PRIMARYKEY SET Z_MAX = ${number(update.nextMax)} WHERE Z_ENT = ${number(update.entity)} AND Z_MAX = ${number(update.expectedMax)}; SELECT changes();`);
  }
  for (const node of recipe.nodes) {
    statements.push(`INSERT INTO ZCATALOGROOT (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZNAME) VALUES (${number(node.catalogPrimaryKey)}, ${number(recipe.catalogEntity)}, 1, '${sqlText(node.catalogIdentifier)}', '${sqlText(node.name)}');`);
  }
  for (const node of recipe.nodes) {
    statements.push(`INSERT INTO ZCOLLECTION (Z_PK, Z_ENT, Z_OPT, ZCATALOG, ZMETADATA, ZIDENTIFIER, ZNAME, ZTYPE) VALUES (${number(node.primaryKey)}, ${number(node.entity)}, 1, ${number(node.catalogPrimaryKey)}, ${number(node.metadataPrimaryKey)}, '${sqlText(node.identifier)}', '${sqlText(node.name)}', '${sqlText(node.kind)}');`);
  }
  for (const node of recipe.nodes) {
    statements.push(`INSERT INTO ZCOLLECTIONMD (Z_PK, Z_ENT, Z_OPT, ZCOLLECTION, ZIDENTIFIER, ZDICTIONARYDATA) VALUES (${number(node.metadataPrimaryKey)}, ${number(recipe.metadataEntity)}, 1, ${number(node.primaryKey)}, '${sqlText(node.metadataIdentifier)}', x'${hex(node.archive)}');`);
  }
  for (const edge of recipe.edges) {
    statements.push(`INSERT INTO Z_3CHILDCOLLECTIONS (Z_3PARENTCOLLECTIONS, Z_3CHILDCOLLECTIONS) VALUES (${number(edge.parentPrimaryKey)}, ${number(edge.childPrimaryKey)});`);
  }
  statements.push("COMMIT;");
  return { sql: statements.join(" "), expectedCasUpdates: recipe.primaryKeyUpdates.length };
}

export interface FinalCutNativeVerificationTarget {
  projectUid: string;
  sequenceUid: string;
}

export interface FinalCutNativeVerificationReadback {
  target: FinalCutNativeVerificationTarget;
  timeline: TimelineIr;
}

export type FinalCutNativeVerificationResult =
  | { status: "native_completed"; target: FinalCutNativeVerificationTarget; desiredDigest: string; readbackDigest: string }
  | { status: "not_completed"; reason: string };

/**
 * Phase 8 gate. Reopen and export are injected headed operations; a digest or
 * target mismatch can never be reported as native completion.
 */
export async function verifyFinalCutNativeReopen(
  target: FinalCutNativeVerificationTarget,
  desired: TimelineIr,
  reopen: () => Promise<void>,
  exportTarget: (target: FinalCutNativeVerificationTarget) => Promise<FinalCutNativeVerificationReadback>,
): Promise<FinalCutNativeVerificationResult> {
  try {
    validateTimelineIr(desired);
    requireText(target.projectUid, "target.projectUid");
    requireText(target.sequenceUid, "target.sequenceUid");
    await reopen();
    const readback = await exportTarget(target);
    if (readback.target.projectUid !== target.projectUid || readback.target.sequenceUid !== target.sequenceUid) {
      return { status: "not_completed", reason: "FINAL_CUT_NATIVE_TARGET_MISMATCH" };
    }
    validateTimelineIr(readback.timeline);
    const desiredDigest = timelineIrDigest(desired);
    const readbackDigest = timelineIrDigest(readback.timeline);
    if (desiredDigest !== readbackDigest) return { status: "not_completed", reason: "FINAL_CUT_NATIVE_TIMELINE_MISMATCH" };
    return { status: "native_completed", target: structuredClone(target), desiredDigest, readbackDigest };
  } catch (error) {
    return { status: "not_completed", reason: error instanceof Error ? error.message : String(error) };
  }
}

function validateAllocation(allocation: FinalCutGraphAllocationEvidence): void {
  for (const key of ["existingCollectionPrimaryKeys", "existingMetadataPrimaryKeys", "existingCatalogPrimaryKeys", "existingIdentifiers"] as const) {
    if (!Array.isArray(allocation[key])) throw new Error(`FINAL_CUT_SHADOW_RECIPE_INVALID: ${key} is required`);
  }
  if (!Number.isSafeInteger(allocation.catalogEntity) || !Number.isSafeInteger(allocation.metadataEntity)) {
    throw new Error("FINAL_CUT_SHADOW_RECIPE_INVALID: catalog and metadata entities are required");
  }
}

function entityForKind(kind: FinalCutVersionedGraphNode["kind"], values: Record<string, { entity: number; max: number }>): { entity: number; max: number } | undefined {
  const aliases: Record<FinalCutVersionedGraphNode["kind"], string[]> = {
    project: ["project", "FFMediaEventProject"],
    sequence: ["sequence", "FFAnchoredSequence"],
    resource: ["resource", "FFAsset", "FFMediaRep"],
    occurrence: ["occurrence", "FFAnchoredClip"],
    "story-element": ["story-element"],
    marker: ["marker"],
    caption: ["caption"],
  };
  for (const alias of aliases[kind]) if (values[alias]) return values[alias];
  return undefined;
}

function allocateIdentifier(prefix: string, logicalId: string, digestPrefix: string, used: Set<string>): string {
  const base = `${prefix}-${shortHash(`${logicalId}:${digestPrefix}`)}`;
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}-${suffix++}`;
  used.add(value);
  return value;
}

function allocateNumber(used: Set<number>, next: () => number): number {
  let value = next();
  while (used.has(value)) value = next();
  used.add(value);
  return value;
}

function nextPositive(values: Set<number>): number {
  return Math.max(0, ...values) + 1;
}

function versionedName(name: string, digestPrefix: string): string {
  return `${name} (Framekit ${digestPrefix})`;
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`FINAL_CUT_SHADOW_RECIPE_INVALID: ${label} must be non-empty text`);
}

function number(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("FINAL_CUT_SHADOW_RECIPE_INVALID: numeric field is unsafe");
  return String(value);
}

function sqlText(value: string): string {
  requireText(value, "SQL text");
  return value.replaceAll("'", "''");
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
