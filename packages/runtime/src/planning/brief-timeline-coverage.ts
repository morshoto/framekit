import type { RationalTime } from "../domain/primitives.js";
import { validateTimelineIr, type TimelineIr } from "../timeline/editing-session.js";
import { addRationalTimes, parseRational, subtractRationalTimes, type RationalParts } from "../timeline/rational-time.js";
import { assertBriefBinding, type AcceptedCreativeBrief, type CreativeBrief } from "./creative-brief.js";

export interface BriefTimelineCoverageCheck {
  requirement: string;
  sourceId: string;
  start: number;
  end: number;
  status: "present" | "missing" | "unavailable";
}

/** Only describes source-coordinate placement in a supplied timeline, not the rendered result. */
export interface BriefTimelineCoverage {
  checks: BriefTimelineCoverageCheck[];
  notice: string;
}

function decimal(value: number): RationalParts {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error("invalid source time");
  const digits = (match[1] ?? "") + (match[2] ?? "");
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  return exponent >= 0 ? { value: BigInt(digits) * 10n ** BigInt(exponent), timescale: 1n }
    : { value: BigInt(digits), timescale: 10n ** BigInt(-exponent) };
}
function compare(a: RationalParts, b: RationalParts): number {
  const diff = a.value * b.timescale - b.value * a.timescale;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
function parts(value: RationalTime): RationalParts { return parseRational(value, "BRIEF_COVERAGE_UNAVAILABLE"); }

/** Caller must independently verify source bytes and bind this snapshot to the target revision. */
export function inspectBriefTimelineCoverage(brief: CreativeBrief, accepted: AcceptedCreativeBrief, timeline: TimelineIr): BriefTimelineCoverage {
  assertBriefBinding(accepted, brief);
  let valid = true;
  try { validateTimelineIr(timeline); } catch { valid = false; }
  const checks = brief.sourceCoverage.map((coverage): BriefTimelineCoverageCheck => {
    const check = { requirement: coverage.requirement, sourceId: coverage.sourceId, start: coverage.start, end: coverage.end };
    if (!valid) return { ...check, status: "unavailable" };
    const resources = timeline.resources.filter((resource) => resource.id === coverage.sourceId);
    const resource = resources[0];
    if (resources.length !== 1 || resource?.sourceKind !== "local-file" || !resource.source || !coverage.sourceDigest
      || !resource.sourceDigest || resource.sourceDigest.replace(/^sha256:/, "") !== coverage.sourceDigest.replace(/^sha256:/, "")) {
      return { ...check, status: "unavailable" };
    }
    try {
      const occurrences = timeline.sequence.occurrences.filter((item) => item.mediaId === coverage.sourceId && item.enabled !== false);
      let uncertain = false;
      const ranges = occurrences.flatMap((item) => {
        if (compare(parts(item.startTime), parts(timeline.sequence.durationTime)) >= 0) return [];
        if (!item.sourceStartTime) { uncertain = true; return []; }
        const start = parts(item.sourceStartTime);
        const available = subtractRationalTimes(timeline.sequence.durationTime, item.startTime);
        const visibleDuration = compare(parts(item.durationTime), parts(available)) <= 0 ? item.durationTime : available;
        const end = parts(addRationalTimes(item.sourceStartTime, visibleDuration));
        return [{ start, end }];
      }).sort((a, b) => compare(a.start, b.start));
      let cursor = decimal(coverage.start);
      const end = decimal(coverage.end);
      for (const range of ranges) {
        if (compare(range.end, cursor) <= 0) continue;
        if (compare(range.start, cursor) > 0) break;
        cursor = range.end;
        if (compare(cursor, end) >= 0) return { ...check, status: "present" };
      }
      return { ...check, status: uncertain ? "unavailable" : "missing" };
    } catch { return { ...check, status: "unavailable" }; }
  });
  return { checks, notice: "Timeline placement only; this does not verify rendered output, content meaning, visibility, audibility, or native editing." };
}
