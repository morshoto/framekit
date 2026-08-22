import assert from "node:assert/strict";
import test from "node:test";
import { resolveEditingIntent } from "@framekit/runtime";

test("editing intent maps cut-and-remove-the-rest to trim_to_duration", () => {
  assert.deepEqual(resolveEditingIntent("Cut at 30 seconds and remove the rest"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    operation: {
      type: "trim_to_duration",
      duration: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "tail",
      start: { value: "30", timescale: "1" },
      end: "sequence-end",
    },
  });
});

test("editing intent maps a blade request to blade_at_playhead", () => {
  assert.deepEqual(resolveEditingIntent("Blade at 30 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    operation: {
      type: "blade_at_playhead",
      playheadTime: { value: "30", timescale: "1" },
    },
    affectedRange: {
      kind: "playhead",
      at: { value: "30", timescale: "1" },
    },
  });
});

test("editing intent maps a range removal to delete_range", () => {
  assert.deepEqual(resolveEditingIntent("Remove 10–15 seconds"), {
    status: "resolved",
    destructive: true,
    previewRequired: true,
    operation: {
      type: "delete_range",
      range: {
        start: { value: "10", timescale: "1" },
        end: { value: "15", timescale: "1" },
      },
    },
    affectedRange: {
      kind: "range",
      start: { value: "10", timescale: "1" },
      end: { value: "15", timescale: "1" },
    },
  });
});

test("editing intent asks for clarification without selecting an operation", () => {
  assert.deepEqual(resolveEditingIntent("Cut this part out"), {
    status: "clarification_required",
    destructive: true,
    previewRequired: false,
    question: "Which editing operation should Framekit perform?",
    options: ["trim_to_duration", "blade_at_playhead", "delete_range"],
  });
});
