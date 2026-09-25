import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  TimelineIr,
  TimelineIrOccurrence,
  TimelineIrStoryElement,
} from "@framekit/runtime";
import { timelineIrDigest, validateTimelineIr } from "@framekit/runtime";

export const FRAMEKIT_FCPXML_VERSION = "1.11" as const;

/** Stable Final Cut identities required for target-bound publication. */
export interface FinalCutTargetIdentity {
  libraryUid: string;
  eventUid: string;
  projectUid: string;
  sequenceUid: string;
}

/** The provider identity that owns the destination project and sequence. */
export interface TimelineIrToFcpxmlTarget extends FinalCutTargetIdentity {
  provider: "final-cut";
  eventName?: string;
  /** Reusing an existing project is opt-in; versioned is the safe default. */
  materialization?: "versioned" | "reuse-existing";
}

export interface TimelineIrToFcpxmlOptions {
  target: TimelineIrToFcpxmlTarget;
  version?: typeof FRAMEKIT_FCPXML_VERSION;
}

export interface TimelineIrMaterializationCoverage {
  exact: string[];
  degraded: string[];
  unsupported: string[];
}

export interface TimelineIrToFcpxmlResult {
  format: "fcpxml";
  version: typeof FRAMEKIT_FCPXML_VERSION;
  xml: string;
  digest: string;
  target: TimelineIrToFcpxmlTarget;
  destination: {
    mode: "versioned" | "reuse-existing";
    projectUid: string;
    sequenceUid: string;
    projectName: string;
    sequenceName: string;
  };
  resourceIds: Record<string, string>;
  coverage: TimelineIrMaterializationCoverage;
}

interface RenderableElement {
  id: string;
  kind: "asset-clip" | "gap";
  startTime: { value: string; timescale: string };
  durationTime: { value: string; timescale: string };
  lane?: number;
  parentId?: string;
  name?: string;
  resourceId?: string;
  sourceStartTime?: { value: string; timescale: string };
  role?: "audio" | "music";
  gainDb?: number;
  enabled?: boolean;
}

/**
 * Compiles a complete provider-neutral Timeline IR into a new FCPXML
 * document. The target binding is mandatory because names are not stable
 * enough to identify a Final Cut destination.
 */
export function compileTimelineIrToFcpxml(
  timeline: TimelineIr,
  options: TimelineIrToFcpxmlOptions,
): TimelineIrToFcpxmlResult {
  validateTimelineIr(timeline);
  const version = options.version ?? FRAMEKIT_FCPXML_VERSION;
  if (version !== FRAMEKIT_FCPXML_VERSION) {
    throw new Error(`FCPXML_VERSION_UNSUPPORTED: ${String(version)}`);
  }
  validateTarget(options.target);
  const destination = resolveDestination(timeline, options.target);

  const resourceIds = createResourceIds(timeline);
  const resourceNames = uniqueResourceNames(timeline);
  const resources = [...timeline.resources].sort((left, right) => left.id.localeCompare(right.id));
  const elements = renderableElements(timeline, resourceIds);
  const elementIds = new Set<string>();
  for (const element of elements) {
    if (elementIds.has(element.id)) throw new Error(`FCPXML_DUPLICATE_ELEMENT_ID: ${element.id}`);
    elementIds.add(element.id);
  }
  for (const item of [...timeline.sequence.markers, ...timeline.sequence.captions]) {
    if (elementIds.has(item.id)) throw new Error(`FCPXML_DUPLICATE_ELEMENT_ID: ${item.id}`);
    elementIds.add(item.id);
  }

  const formatId = "format-framekit";
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<fcpxml version="${FRAMEKIT_FCPXML_VERSION}">`,
    "  <resources>",
    `    <format id="${formatId}" frameDuration="${formatRational(timeline.sequence.frameDuration, "sequence.frameDuration")}" />`,
    ...resources.map((resource) => renderResource(resource, resourceIds.get(resource.id)!, resourceNames.get(resource.id)!)),
    "  </resources>",
    "  <library>",
    `    <event uid="${xmlEscape(options.target.eventUid)}" name="${xmlEscape(options.target.eventName ?? "Framekit Event")}">`,
    `      <project uid="${xmlEscape(destination.projectUid)}" name="${xmlEscape(destination.projectName)}">`,
    `        <sequence uid="${xmlEscape(destination.sequenceUid)}" name="${xmlEscape(destination.sequenceName)}" format="${formatId}" duration="${formatRational(timeline.sequence.durationTime, "sequence.durationTime")}">`,
    "          <spine>",
    ...renderElements(elements),
    ...timeline.sequence.markers
      .slice()
      .sort(compareTimedItems)
      .map((marker) => `            <marker id="${xmlEscape(marker.id)}" start="${formatRational(marker.startTime, `marker ${marker.id}.startTime`)}" duration="${formatRational(marker.durationTime, `marker ${marker.id}.durationTime`)}" value="${xmlEscape(marker.name)}" />`),
    ...timeline.sequence.captions
      .slice()
      .sort(compareTimedItems)
      .map((caption) => `            <caption id="${xmlEscape(caption.id)}" start="${formatRational(caption.startTime, `caption ${caption.id}.startTime`)}" duration="${formatRational(caption.durationTime, `caption ${caption.id}.durationTime`)}" text="${xmlEscape(caption.text)}" />`),
    "          </spine>",
    "        </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  ];
  const xml = lines.join("\n");
  return {
    format: "fcpxml",
    version: FRAMEKIT_FCPXML_VERSION,
    xml,
    digest: createHash("sha256").update(xml).digest("hex"),
    target: structuredClone(options.target),
    destination,
    resourceIds: Object.fromEntries([...resourceIds.entries()].sort(([left], [right]) => left.localeCompare(right))),
    coverage: {
      exact: [
        "project",
        "sequence",
        "resources",
        "source-ranges",
        "primary-storyline-order",
        "connected-elements",
        "markers",
        "captions",
      ],
      degraded: [],
      unsupported: [],
    },
  };
}

function validateTarget(target: TimelineIrToFcpxmlTarget): void {
  if (!target || target.provider !== "final-cut") throw new Error("FCPXML_TARGET_BINDING_INVALID: provider must be final-cut");
  requireText(target.libraryUid, "libraryUid");
  requireText(target.eventUid, "eventUid");
  requireText(target.projectUid, "projectUid");
  requireText(target.sequenceUid, "sequenceUid");
  if (target.eventName !== undefined) requireText(target.eventName, "eventName");
  if (target.materialization !== undefined && !["versioned", "reuse-existing"].includes(target.materialization)) {
    throw new Error(`FCPXML_TARGET_BINDING_INVALID: unsupported materialization ${target.materialization}`);
  }
}

function resolveDestination(
  timeline: TimelineIr,
  target: TimelineIrToFcpxmlTarget,
): TimelineIrToFcpxmlResult["destination"] {
  if (target.materialization === "reuse-existing") {
    return {
      mode: "reuse-existing",
      projectUid: target.projectUid,
      sequenceUid: target.sequenceUid,
      projectName: timeline.project.name,
      sequenceName: timeline.sequence.name,
    };
  }

  const revisionKey = shortHash(`${timeline.project.id}:${timeline.sequence.id}:${timelineIrDigest(timeline)}`);
  return {
    mode: "versioned",
    projectUid: `${safeId(target.projectUid)}-framekit-${revisionKey}`,
    sequenceUid: `${safeId(target.sequenceUid)}-framekit-${revisionKey}`,
    projectName: `${timeline.project.name} (Framekit ${revisionKey})`,
    sequenceName: `${timeline.sequence.name} (Framekit ${revisionKey})`,
  };
}

function createResourceIds(timeline: TimelineIr): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const resource of [...timeline.resources].sort((left, right) => left.id.localeCompare(right.id))) {
    if (resource.mediaKind !== "video" && resource.mediaKind !== "audio") {
      throw new Error(`FCPXML_UNSUPPORTED_RESOURCE_KIND: ${resource.mediaKind}`);
    }
    requireText(resource.source, `resource ${resource.id}.source`);
    const source = resource.source!;
    if (!source.startsWith("file://") && !isAbsolute(source)) {
      throw new Error(`FCPXML_RESOURCE_SOURCE_UNSUPPORTED: resource ${resource.id} requires an absolute path or file URL`);
    }
    const base = `resource-${safeId(resource.id)}`;
    let candidate = base;
    if (used.has(candidate)) candidate = `${base}-${shortHash(resource.id)}`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${shortHash(resource.id)}-${suffix++}`;
    ids.set(resource.id, candidate);
    used.add(candidate);
  }
  return ids;
}

function uniqueResourceNames(timeline: TimelineIr): Map<string, string> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const resource of [...timeline.resources].sort((left, right) => left.id.localeCompare(right.id))) {
    const count = (counts.get(resource.name) ?? 0) + 1;
    counts.set(resource.name, count);
    names.set(resource.id, count === 1 ? resource.name : `${resource.name} (${count})`);
  }
  return names;
}

function renderResource(
  resource: TimelineIr["resources"][number],
  id: string,
  name: string,
): string {
  const source = resource.source!;
  let src: string;
  try {
    src = source.startsWith("file://") ? new URL(source).toString() : pathToFileURL(source).toString();
  } catch (error) {
    throw new Error(`FCPXML_RESOURCE_SOURCE_UNSUPPORTED: resource ${resource.id} has an invalid file URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mediaAttributes = resource.mediaKind === "video"
    ? ' hasVideo="1" hasAudio="0"'
    : ' hasVideo="0" hasAudio="1"';
  return `    <asset id="${xmlEscape(id)}" name="${xmlEscape(name)}" src="${xmlEscape(src)}"${mediaAttributes} />`;
}

function renderableElements(timeline: TimelineIr, resourceIds: Map<string, string>): RenderableElement[] {
  const occurrenceIds = new Set(timeline.sequence.occurrences.map(({ id }) => id));
  const elements: RenderableElement[] = timeline.sequence.occurrences.map((occurrence) => renderOccurrence(occurrence, timeline, resourceIds, occurrenceIds));
  for (const element of timeline.sequence.storyElements) {
    if (occurrenceIds.has(element.id) || element.occurrenceId !== undefined && occurrenceIds.has(element.occurrenceId)) continue;
    if (element.kind !== "gap") throw new Error(`FCPXML_UNSUPPORTED_STORY_ELEMENT: ${element.kind}`);
    if (element.attachedTo !== undefined && !occurrenceIds.has(element.attachedTo)) {
      throw new Error(`FCPXML_ATTACHMENT_TARGET_NOT_FOUND: ${element.id} -> ${element.attachedTo}`);
    }
    elements.push({
      id: element.id,
      kind: "gap",
      startTime: element.startTime,
      durationTime: element.durationTime,
      ...(element.lane !== undefined ? { lane: element.lane } : {}),
      ...(element.attachedTo !== undefined ? { parentId: element.attachedTo } : {}),
    });
  }
  return elements;
}

function renderOccurrence(
  occurrence: TimelineIrOccurrence,
  timeline: TimelineIr,
  resourceIds: Map<string, string>,
  occurrenceIds: Set<string>,
): RenderableElement {
  if (occurrence.role === "title") throw new Error("FCPXML_UNSUPPORTED_OCCURRENCE_ROLE: title");
  if (occurrence.fadeIn !== undefined || occurrence.fadeOut !== undefined) {
    throw new Error(`FCPXML_UNSUPPORTED_OCCURRENCE_FIELD: ${occurrence.id} fades require an FCPXML audio-fade contract`);
  }
  const resource = occurrence.mediaId === undefined ? undefined : resourceIds.get(occurrence.mediaId);
  if (!resource) throw new Error(`FCPXML_MEDIA_BINDING_NOT_FOUND: occurrence ${occurrence.id} has no compiled resource`);
  const resourceDefinition = occurrence.mediaId === undefined
    ? undefined
    : timeline.resources.find(({ id }) => id === occurrence.mediaId);
  if (resourceDefinition && (occurrence.role === "video" && resourceDefinition.mediaKind !== "video"
    || (occurrence.role === "audio" || occurrence.role === "music") && resourceDefinition.mediaKind !== "audio")) {
    throw new Error(`FCPXML_MEDIA_ROLE_MISMATCH: occurrence ${occurrence.id} cannot use ${resourceDefinition.mediaKind} resource as ${occurrence.role}`);
  }
  if (occurrence.attachedTo !== undefined && !occurrenceIds.has(occurrence.attachedTo)) {
    throw new Error(`FCPXML_ATTACHMENT_TARGET_NOT_FOUND: ${occurrence.id} -> ${occurrence.attachedTo}`);
  }
  return {
    id: occurrence.id,
    kind: "asset-clip",
    startTime: occurrence.startTime,
    durationTime: occurrence.durationTime,
    ...(occurrence.track > 0 ? { lane: occurrence.track } : {}),
    ...(occurrence.attachedTo !== undefined ? { parentId: occurrence.attachedTo } : {}),
    name: occurrence.name,
    resourceId: resource,
    ...(occurrence.sourceStartTime ? { sourceStartTime: occurrence.sourceStartTime } : {}),
    ...(occurrence.role === "audio" || occurrence.role === "music" ? { role: occurrence.role } : {}),
    ...(occurrence.gainDb !== undefined ? { gainDb: occurrence.gainDb } : {}),
    ...(occurrence.enabled !== undefined ? { enabled: occurrence.enabled } : {}),
  };
}

function renderElements(elements: RenderableElement[]): string[] {
  const byParent = new Map<string | undefined, RenderableElement[]>();
  const byId = new Map<string, RenderableElement>();
  for (const element of elements) {
    byId.set(element.id, element);
    const siblings = byParent.get(element.parentId) ?? [];
    siblings.push(element);
    byParent.set(element.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort(compareTimedItems);
  const rendered = new Set<string>();
  const lines: string[] = [];
  const render = (parentId: string | undefined, indent: string): void => {
    for (const element of byParent.get(parentId) ?? []) {
      if (rendered.has(element.id)) throw new Error(`FCPXML_CYCLIC_ATTACHMENT: ${element.id}`);
      rendered.add(element.id);
      const children = byParent.get(element.id) ?? [];
      const parentStartTime = element.parentId === undefined
        ? { value: "0", timescale: "1" }
        : byId.get(element.parentId)?.startTime;
      if (!parentStartTime) throw new Error(`FCPXML_ATTACHMENT_TARGET_NOT_FOUND: ${element.id} -> ${element.parentId}`);
      const localStartTime = subtractRational(element.startTime, parentStartTime, `${element.id}.startTime`);
      const attributes = element.kind === "asset-clip"
        ? [
            `id="${xmlEscape(element.id)}"`,
            `ref="${xmlEscape(element.resourceId!)}"`,
            `name="${xmlEscape(element.name!)}"`,
            `offset="${formatRational(localStartTime, `${element.id}.startTime`)}"`,
            ...(element.sourceStartTime ? [`start="${formatRational(element.sourceStartTime, `${element.id}.sourceStartTime`)}"`] : []),
            `duration="${formatRational(element.durationTime, `${element.id}.durationTime`)}"`,
            ...(element.lane !== undefined ? [`lane="${String(element.lane)}"`] : []),
            ...(element.role ? [`role="${element.role}"`] : []),
            ...(element.enabled !== undefined ? [`enabled="${element.enabled ? "1" : "0"}"`] : []),
          ]
        : [
            `id="${xmlEscape(element.id)}"`,
            `offset="${formatRational(localStartTime, `${element.id}.startTime`)}"`,
            `duration="${formatRational(element.durationTime, `${element.id}.durationTime`)}"`,
            ...(element.lane !== undefined ? [`lane="${String(element.lane)}"`] : []),
          ];
      const opening = `<${element.kind} ${attributes.join(" ")}>`;
      const childLines = element.gainDb !== undefined
        ? [`${indent}  <adjust-volume amount="${formatDb(element.gainDb, element.id)}" />`]
        : [];
      const childStart = childLines.length > 0 ? childLines : [];
      if (children.length === 0 && childStart.length === 0) {
        lines.push(`${indent}<${element.kind} ${attributes.join(" ")} />`);
        continue;
      }
      lines.push(`${indent}${opening}`);
      lines.push(...childStart);
      render(element.id, `${indent}  `);
      lines.push(`${indent}</${element.kind}>`);
    }
  };
  render(undefined, "            ");
  if (rendered.size !== elements.length) {
    const missing = elements.find(({ id }) => !rendered.has(id));
    throw new Error(`FCPXML_CYCLIC_ATTACHMENT: ${missing?.id ?? "unknown"}`);
  }
  return lines;
}

function compareTimedItems(left: { id: string; startTime: { value: string; timescale: string }; lane?: number }, right: { id: string; startTime: { value: string; timescale: string }; lane?: number }): number {
  const leftTime = parseExactRational(left.startTime);
  const rightTime = parseExactRational(right.startTime);
  const difference = leftTime.value * rightTime.timescale - rightTime.value * leftTime.timescale;
  if (difference !== 0n) return difference < 0n ? -1 : 1;
  if ((left.lane ?? 0) !== (right.lane ?? 0)) return (left.lane ?? 0) - (right.lane ?? 0);
  return left.id.localeCompare(right.id);
}

function formatRational(value: { value: string; timescale: string }, field: string): string {
  const parsed = parseExactRational(value);
  if (parsed.value < 0n) throw new Error(`FCPXML_INVALID_TIME: ${field} cannot be negative`);
  const divisor = greatestCommonDivisor(parsed.value, parsed.timescale);
  const numerator = parsed.value / divisor;
  const denominator = parsed.timescale / divisor;
  return denominator === 1n ? `${numerator}s` : `${numerator}/${denominator}s`;
}

function subtractRational(
  left: { value: string; timescale: string },
  right: { value: string; timescale: string },
  field: string,
): { value: string; timescale: string } {
  const leftParts = parseExactRational(left);
  const rightParts = parseExactRational(right);
  const numerator = leftParts.value * rightParts.timescale - rightParts.value * leftParts.timescale;
  if (numerator < 0n) throw new Error(`FCPXML_INVALID_TIME: ${field} precedes its attachment target`);
  const denominator = leftParts.timescale * rightParts.timescale;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { value: String(numerator / divisor), timescale: String(denominator / divisor) };
}

function formatDb(value: number, id: string): string {
  if (!Number.isFinite(value)) throw new Error(`FCPXML_INVALID_GAIN: ${id}`);
  return `${Object.is(value, -0) ? 0 : value}dB`;
}

function safeId(value: string): string {
  let result = "";
  let pendingSeparator = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isAllowed = code >= 0x30 && code <= 0x39
      || code >= 0x41 && code <= 0x5a
      || code >= 0x61 && code <= 0x7a
      || character === "_"
      || character === "-";
    if (!isAllowed) {
      if (result.length > 0) pendingSeparator = true;
      continue;
    }
    if (pendingSeparator) result += "-";
    result += character;
    pendingSeparator = false;
  }
  let start = 0;
  let end = result.length;
  while (start < end && result[start] === "-") start += 1;
  while (end > start && result[end - 1] === "-") end -= 1;
  const trimmed = result.slice(start, end);
  return trimmed.length > 0 ? trimmed : `id-${shortHash(value)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
}

function parseExactRational(value: { value: string; timescale: string }): { value: bigint; timescale: bigint } {
  if (!/^-?\d+$/.test(value.value) || !/^\d+$/.test(value.timescale)) {
    throw new Error("FCPXML_INVALID_TIME: rational time requires integer value and timescale");
  }
  const timescale = BigInt(value.timescale);
  if (timescale <= 0n) throw new Error("FCPXML_INVALID_TIME: rational timescale must be positive");
  return { value: BigInt(value.value), timescale };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`FCPXML_TARGET_BINDING_INVALID: ${field} must be non-empty`);
}
