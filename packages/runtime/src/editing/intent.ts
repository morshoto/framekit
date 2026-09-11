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
    }
  | {
      type: "media_import";
      path: string;
      targetProject: "active";
    }
  | {
      type: "media_select";
      mediaHandle: string;
    }
  | {
      type: "media_append_selected";
      targetProject: "active";
      placement: "append";
    }
  | {
      type: "media_append";
      mediaHandle: string;
      targetProject: "active";
      placement: "append";
    }
  | {
      type: "media_insert";
      mediaHandle: string;
      targetProject: "active";
      placement: "insert";
    }
  | {
      type: "media_import_then_append";
      path: string;
      targetProject: "active";
      placement: "append";
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
      status: "resolved";
      destructive: boolean;
      previewRequired: boolean;
      previewTool?: MediaPreviewTool;
      executeTool?: MediaExecuteTool;
      operation: MediaEditingIntentOperation;
      requiredCapabilities: string[];
      requiredParameters: MediaIntentParameter[];
      workflow: string[];
    }
  | {
      status: "capability_unavailable";
      destructive: boolean;
      previewRequired: false;
      question: string;
      options: MediaEditingIntentOperation["type"][];
      requiredCapabilities: string[];
      missingCapabilities: string[];
    }
  | {
      status: "clarification_required";
      destructive: boolean;
      previewRequired: false;
      question: string;
      options: EditingIntentOperation["type"][];
    };

type MediaEditingIntentOperation = Extract<
  EditingIntentOperation,
  { type: `media_${string}` }
>;

type MediaPreviewTool =
  | "editor.native.media.append.preview"
  | "editor.native.media.append.selected.preview"
  | "editor.native.media.insert.preview";

type MediaExecuteTool =
  | "editor.native.media.append.execute"
  | "editor.native.media.append.selected.execute"
  | "editor.native.media.insert.execute";

type MediaIntentParameter = "path" | "mediaHandle" | "project" | "placement";

export interface EditingIntentResolutionContext {
  /** When present, native media intent resolution fails closed for unavailable capabilities. */
  availableCapabilities: Readonly<Record<string, boolean>>;
}

const CLARIFICATION_OPTIONS: EditingIntentOperation["type"][] = [
  "trim_to_duration",
  "blade_at_playhead",
  "delete_range",
];

const ACTIVE_PROJECT = "active" as const;

/** Resolve only the explicit destructive language supported by Framekit. */
export function resolveEditingIntent(
  request: string,
  context?: EditingIntentResolutionContext,
): EditingIntentResolution {
  const collapsed = request.trim().replace(/\s+/g, " ");
  const normalized = collapsed.toLowerCase();

  const importAndAppendPath = parseMediaPath(collapsed, true);
  if (importAndAppendPath) {
    return mediaResolution({
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.media.append.preview",
      executeTool: "editor.native.media.append.execute",
      operation: {
        type: "media_import_then_append",
        path: importAndAppendPath,
        targetProject: ACTIVE_PROJECT,
        placement: "append",
      },
      requiredCapabilities: ["native.mediaImport", "native.mediaSelection", "native.mediaAppend"],
      requiredParameters: ["path", "project", "placement"],
      workflow: [
        "editor.native.media.import",
        "editor.native.media.select",
        "editor.native.media.append.preview",
        "editor.native.media.append.execute",
      ],
    }, context);
  }

  if (/^import\b/i.test(collapsed) && /\band\s+append\b/i.test(collapsed)) {
    return mediaClarification(
      "Which local media path should Framekit import before appending?",
      ["media_import_then_append", "media_import"],
    );
  }

  const importPath = parseMediaPath(collapsed, false);
  if (importPath) {
    return mediaResolution({
      destructive: false,
      previewRequired: false,
      operation: { type: "media_import", path: importPath, targetProject: ACTIVE_PROJECT },
      requiredCapabilities: ["native.mediaImport"],
      requiredParameters: ["path"],
      workflow: ["editor.native.media.import"],
    }, context);
  }

  if (/^import\b/i.test(collapsed)) {
    return mediaClarification(
      "Which local media path should Framekit import?",
      ["media_import"],
      false,
    );
  }

  const selectHandle = parseMediaHandle(collapsed, "select");
  if (selectHandle) {
    return mediaResolution({
      destructive: false,
      previewRequired: false,
      operation: { type: "media_select", mediaHandle: selectHandle },
      requiredCapabilities: ["native.mediaSelection"],
      requiredParameters: ["mediaHandle"],
      workflow: ["editor.native.media.select"],
    }, context);
  }

  if (/^select\b/i.test(collapsed)) {
    return mediaClarification(
      "Which Browser media handle should Framekit select?",
      ["media_select"],
      false,
    );
  }

  if (isAppendSelectedRequest(normalized)) {
    return mediaResolution({
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.media.append.selected.preview",
      executeTool: "editor.native.media.append.selected.execute",
      operation: {
        type: "media_append_selected",
        targetProject: ACTIVE_PROJECT,
        placement: "append",
      },
      requiredCapabilities: ["native.mediaAppendSelected"],
      requiredParameters: ["project", "placement"],
      workflow: [
        "editor.native.media.append.selected.preview",
        "editor.native.media.append.selected.execute",
      ],
    }, context);
  }

  const insertHandle = parseMediaHandle(collapsed, "insert");
  if (insertHandle) {
    return mediaResolution({
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.media.insert.preview",
      executeTool: "editor.native.media.insert.execute",
      operation: {
        type: "media_insert",
        mediaHandle: insertHandle,
        targetProject: ACTIVE_PROJECT,
        placement: "insert",
      },
      requiredCapabilities: ["native.mediaSelection", "native.mediaInsert"],
      requiredParameters: ["mediaHandle", "project", "placement"],
      workflow: [
        "editor.native.media.select",
        "editor.native.media.insert.preview",
        "editor.native.media.insert.execute",
      ],
    }, context);
  }

  const appendHandle = parseMediaHandle(collapsed, "append");
  if (appendHandle) {
    return mediaResolution({
      destructive: true,
      previewRequired: true,
      previewTool: "editor.native.media.append.preview",
      executeTool: "editor.native.media.append.execute",
      operation: {
        type: "media_append",
        mediaHandle: appendHandle,
        targetProject: ACTIVE_PROJECT,
        placement: "append",
      },
      requiredCapabilities: ["native.mediaSelection", "native.mediaAppend"],
      requiredParameters: ["mediaHandle", "project", "placement"],
      workflow: [
        "editor.native.media.select",
        "editor.native.media.append.preview",
        "editor.native.media.append.execute",
      ],
    }, context);
  }

  if (/^append\b/i.test(collapsed)) {
    return mediaClarification(
      "Should Framekit append the currently selected Browser media or use a media handle?",
      ["media_append_selected", "media_append"],
    );
  }

  if (/^insert\b/i.test(collapsed)) {
    return mediaClarification(
      "Which Browser media handle should Framekit insert at the playhead?",
      ["media_insert", "media_select"],
    );
  }

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

function mediaResolution(input: {
  destructive: boolean;
  previewRequired: boolean;
  previewTool?: MediaPreviewTool;
  executeTool?: MediaExecuteTool;
  operation: MediaEditingIntentOperation;
  requiredCapabilities: string[];
  requiredParameters: MediaIntentParameter[];
  workflow: string[];
}, context?: EditingIntentResolutionContext): EditingIntentResolution {
  const missingCapabilities = context
    ? input.requiredCapabilities.filter((capability) => context.availableCapabilities[capability] !== true)
    : [];
  if (missingCapabilities.length > 0) {
    return {
      status: "capability_unavailable",
      destructive: input.destructive,
      previewRequired: false,
      question: "The connected editor cannot perform this native media operation.",
      options: [input.operation.type],
      requiredCapabilities: [...input.requiredCapabilities],
      missingCapabilities,
    };
  }
  return {
    status: "resolved",
    ...input,
  };
}

function mediaClarification(
  question: string,
  options: Extract<EditingIntentOperation["type"], `media_${string}`>[],
  destructive = true,
): EditingIntentResolution {
  return {
    status: "clarification_required",
    destructive,
    previewRequired: false,
    question,
    options,
  };
}

function isAppendSelectedRequest(request: string): boolean {
  return /^append(?:\s+the)?\s+(?:currently\s+)?(?:selected\s+)?(?:browser\s+)?media(?:\s+to\s+(?:the\s+)?(?:active\s+)?timeline)?$/.test(request)
    && /\bselected\b/.test(request);
}

function parseMediaPath(request: string, withAppend: boolean): string | undefined {
  const suffix = withAppend
    ? "\\s+and\\s+append(?:\\s+it)?(?:\\s+to\\s+(?:the\\s+)?(?:active\\s+)?timeline)?"
    : "";
  const match = request.match(new RegExp(
    `^import(?:\\s+(?:this|the))?(?:\\s+(?:local\\s+)?(?:video|audio|media))?\\s+(?:from\\s+)?(?:\\\"([^\\\"]+)\\\"|'([^']+)'|(\\S+?))${suffix}$`,
    "i",
  ));
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  return path && !["video", "audio", "media"].includes(path.toLowerCase()) ? path : undefined;
}

function parseMediaHandle(request: string, operation: "select" | "append" | "insert"): string | undefined {
  const action = operation === "select" ? "select" : operation;
  const suffix = operation === "insert"
    ? "\\s+at\\s+(?:the\\s+)?playhead"
    : operation === "append"
      ? "(?:\\s+to\\s+(?:the\\s+)?(?:active\\s+)?timeline)?"
      : "";
  const match = request.match(new RegExp(
    `^${action}(?:\\s+(?:the\\s+)?)?(?:\\s+browser)?\\s+media(?:\\s+with)?(?:\\s+handle)?\\s+(?:\\\"([^\\\"]+)\\\"|'([^']+)'|(\\S+?))${suffix}$`,
    "i",
  ));
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
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
