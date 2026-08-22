import type { RationalTime } from "../domain/types.js";

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
    if (Number(deleteMatch[2]) > Number(deleteMatch[1])) {
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
  const decimals = seconds.length - seconds.indexOf(".") - 1;
  const timescale = 10 ** decimals;
  return {
    value: String(Math.round(Number(seconds) * timescale)),
    timescale: String(timescale),
  };
}
