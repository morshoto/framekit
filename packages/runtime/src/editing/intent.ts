import type { RationalTime } from "../domain/primitives.js";

export type EditingIntentOperation =
  | {
      type: "trim_to_duration";
      duration: RationalTime;
    }
  | {
      type: "blade_at_playhead";
      playheadTime: RationalTime;
    }
  | {
      type: "delete_range";
      range: {
        start: RationalTime;
        end: RationalTime;
      };
    };

export type EditingIntentAffectedRange =
  | {
      kind: "tail";
      start: RationalTime;
      end: "sequence-end";
    }
  | {
      kind: "playhead";
      at: RationalTime;
    }
  | {
      kind: "range";
      start: RationalTime;
      end: RationalTime;
    };

export type EditingIntentResolution =
  | {
      status: "resolved";
      destructive: true;
      previewRequired: true;
      previewTool:
        | "editor.native.trim-to-duration.preview"
        | "editor.native.blade.preview"
        | "editor.native.delete-range.preview";
      operation: EditingIntentOperation;
      affectedRange: EditingIntentAffectedRange;
    }
  | {
      status: "clarification_required";
      destructive: true;
      previewRequired: false;
      question: string;
      options: EditingIntentOperation["type"][];
    };

const CLARIFICATION_OPTIONS: EditingIntentOperation["type"][] = [
  "trim_to_duration",
  "blade_at_playhead",
  "delete_range",
];

/** Resolve only the explicit destructive language supported by Framekit. */
export function resolveEditingIntent(request: string): EditingIntentResolution {
  const normalized = request.trim().replace(/\s+/g, " ").toLowerCase();

  const trimMatch = normalized.match(/^cut at (\d+(?:\.\d+)?) seconds? and remove the rest$/);
  if (trimMatch) {
    const duration = secondsToRational(trimMatch[1]!);
    return {
      status: "resolved",
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.trim-to-duration.preview",
      operation: { type: "trim_to_duration", duration },
      affectedRange: { kind: "tail", start: duration, end: "sequence-end" },
    };
  }

  const bladeMatch = normalized.match(/^blade at (\d+(?:\.\d+)?) seconds?$/);
  if (bladeMatch) {
    const playheadTime = secondsToRational(bladeMatch[1]!);
    return {
      status: "resolved",
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.blade.preview",
      operation: { type: "blade_at_playhead", playheadTime },
      affectedRange: { kind: "playhead", at: playheadTime },
    };
  }

  const deleteMatch = normalized.match(/^remove (\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?) seconds?$/);
  if (deleteMatch) {
    const start = secondsToRational(deleteMatch[1]!);
    const end = secondsToRational(deleteMatch[2]!);
    if (compareDecimalSeconds(deleteMatch[2]!, deleteMatch[1]!) > 0) {
      return {
        status: "resolved",
        destructive: true,
        previewRequired: true,
        previewTool: "editor.native.delete-range.preview",
        operation: { type: "delete_range", range: { start, end } },
        affectedRange: { kind: "range", start, end },
      };
    }
  }

  return {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Which editing operation should Framekit perform?",
    options: [...CLARIFICATION_OPTIONS],
  };
}

function secondsToRational(seconds: string): RationalTime {
  if (!seconds.includes(".")) return { value: seconds, timescale: "1" };
  const [whole, fraction = ""] = seconds.split(".");
  const value = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return {
    value,
    timescale: `1${"0".repeat(fraction.length)}`,
  };
}

function compareDecimalSeconds(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = normalizeDecimalSeconds(left);
  const [rightWhole, rightFraction = ""] = normalizeDecimalSeconds(right);
  if (leftWhole.length !== rightWhole.length) return leftWhole.length > rightWhole.length ? 1 : -1;
  if (leftWhole !== rightWhole) return leftWhole > rightWhole ? 1 : -1;

  const precision = Math.max(leftFraction.length, rightFraction.length);
  const paddedLeft = leftFraction.padEnd(precision, "0");
  const paddedRight = rightFraction.padEnd(precision, "0");
  if (paddedLeft === paddedRight) return 0;
  return paddedLeft > paddedRight ? 1 : -1;
}

function normalizeDecimalSeconds(seconds: string): [string, string] {
  const [whole, fraction = ""] = seconds.split(".");
  return [whole.replace(/^0+(?=\d)/, ""), fraction];
}
