import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, type MediaContext } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type EvaluationCategory = "project" | "media" | "editing" | "workflow-assets" | "publishing" | "failure-path";
type EvaluationSupport = "supported" | "unavailable";

interface EvaluationExpectation {
  toolAvailable?: boolean;
  isError?: boolean;
  errorIncludes?: string;
  json?: {
    path: string;
    equals?: JsonValue;
    includes?: string;
  };
}

interface EvaluationStep {
  tool: string;
  arguments?: JsonObject;
  expect: EvaluationExpectation;
  capture?: {
    name: string;
    path: string;
  };
}

interface EvaluationScenario {
  id: string;
  category: EvaluationCategory;
  support: EvaluationSupport;
  intent: string;
  expectedTool: string;
  steps: EvaluationStep[];
}

const editorTimelineTarget = {
  projectId: "project-evaluation",
  sequenceId: "timeline-evaluation",
  baseRevision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
};

export interface EvaluationScenarioResult {
  id: string;
  category: EvaluationCategory;
  support: EvaluationSupport;
  intent: string;
  passed: boolean;
  message?: string;
}

export interface EvaluationCategoryMetrics {
  total: number;
  passed: number;
  failed: number;
  supported: number;
  unavailable: number;
  correctnessRate: number;
  coverageRate: number;
}

export interface EvaluationReport {
  version: 1;
  correctness: {
    total: number;
    passed: number;
    failed: number;
    rate: number;
  };
  capability: {
    total: number;
    supported: number;
    unavailable: number;
    coverageRate: number;
  };
  byCategory: Record<EvaluationCategory, EvaluationCategoryMetrics>;
  scenarioConsistency: {
    total: number;
    consistent: number;
    inconsistent: number;
    rate: number;
  };
  scenarios: EvaluationScenarioResult[];
}

const scenarios: EvaluationScenario[] = [
  {
    id: "active-project-selection",
    category: "project",
    support: "supported",
    intent: "Select and inspect the active project",
    expectedTool: "project.inspect",
    steps: [{
      tool: "project.inspect",
      expect: { json: { path: "projectName", equals: "MCP Evaluation Fixture" } },
    }],
  },
  {
    id: "target-interview-media",
    category: "media",
    support: "supported",
    intent: "Find the interview source to target for editing",
    expectedTool: "media.search",
    steps: [{
      tool: "media.search",
      arguments: { query: "interview" },
      expect: { json: { path: "0.mediaId", equals: "media-interview" } },
    }],
  },
  {
    id: "target-music-media",
    category: "media",
    support: "supported",
    intent: "Find the music bed for the edit",
    expectedTool: "media.search",
    steps: [{
      tool: "media.search",
      arguments: { query: "music" },
      expect: { json: { path: "0.source", equals: "music-bed.wav" } },
    }],
  },
  {
    id: "media-import-capability",
    category: "media",
    support: "unavailable",
    intent: "Import a new source media item into the project",
    expectedTool: "media.import",
    steps: [{ tool: "media.import", expect: { toolAvailable: false } }],
  },
  {
    id: "rename-clip-and-verify",
    category: "editing",
    support: "supported",
    intent: "Rename the interview clip and verify the change",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "rename-clip", clipId: "clip-interview", name: "Interview - Clean" },
      expect: { json: { path: "status", equals: "VERIFIED" } },
    }],
  },
  {
    id: "trim-clip-and-verify",
    category: "editing",
    support: "supported",
    intent: "Trim the b-roll clip to the requested duration",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "trim-clip", clipId: "clip-broll", duration: 3 },
      expect: { json: { path: "after.timeline.clips.1.duration", equals: 3 } },
    }],
  },
  {
    id: "set-music-gain",
    category: "editing",
    support: "supported",
    intent: "Lower the music bed gain under dialogue",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "set-gain", clipId: "clip-music", gainDb: -12 },
      expect: { json: { path: "after.timeline.clips.2.gainDb", equals: -12 } },
    }],
  },
  {
    id: "ripple-delete-range",
    category: "editing",
    support: "supported",
    intent: "Remove an unwanted range and ripple the remaining edit",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "ripple-delete", timelineId: "timeline-evaluation", range: { start: 1, end: 2 } },
      expect: { json: { path: "diff.durationDelta", equals: -1 } },
    }],
  },
  {
    id: "add-review-marker",
    category: "editing",
    support: "supported",
    intent: "Add a review marker at a known timeline position",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: {
        ...editorTimelineTarget,
        type: "add-marker",
        timelineId: "timeline-evaluation",
        marker: { id: "marker-review", start: 2, duration: 0, name: "Review" },
      },
      expect: { json: { path: "diff.markerChanges.0.type", equals: "MARKER_ADDED" } },
    }],
  },
  {
    id: "transition-discovery",
    category: "workflow-assets",
    support: "supported",
    intent: "Find a compatible transition for the edit",
    expectedTool: "editor.assets",
    steps: [{
      tool: "editor.assets",
      arguments: { kind: "transition", query: "cross" },
      expect: { json: { path: "0.name", equals: "Cross Dissolve" } },
    }],
  },
  {
    id: "title-discovery",
    category: "workflow-assets",
    support: "supported",
    intent: "Find a title template for the interview",
    expectedTool: "editor.assets",
    steps: [{
      tool: "editor.assets",
      arguments: { kind: "title", query: "lower" },
      expect: { json: { path: "0.name", equals: "Lower Third" } },
    }],
  },
  {
    id: "music-edit-capability",
    category: "workflow-assets",
    support: "supported",
    intent: "Preview a music bed with placement and mix settings",
    expectedTool: "music.add",
    steps: [{
      tool: "music.add",
      arguments: {
        baseRevision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
        occurrenceId: "clip-music-preview",
        mediaId: "media-music",
        placement: "insert",
        start: 0,
        duration: 4,
        targetLane: -1,
        gainDb: -12,
        fadeIn: 0.25,
        fadeOut: 0.5,
      },
      expect: { json: { path: "previewToken", includes: "preview-" } },
    }],
  },
  {
    id: "title-edit-capability",
    category: "workflow-assets",
    support: "unavailable",
    intent: "Apply a title template to the timeline",
    expectedTool: "title.apply",
    steps: [{ tool: "title.apply", expect: { toolAvailable: false } }],
  },
  {
    id: "transition-edit-capability",
    category: "workflow-assets",
    support: "unavailable",
    intent: "Apply a transition between timeline clips",
    expectedTool: "transition.apply",
    steps: [{ tool: "transition.apply", expect: { toolAvailable: false } }],
  },
  {
    id: "export-capability",
    category: "publishing",
    support: "unavailable",
    intent: "Export the verified edit as a new project",
    expectedTool: "artifact.publish",
    steps: [{
      tool: "artifact.publish",
      arguments: { artifactPath: "/not-managed.fcpxml", transactionId: "txn-not-created", confirm: true },
      expect: { isError: true, errorIncludes: "CAPABILITY_UNAVAILABLE" },
    }],
  },
  {
    id: "invalid-edit-fails-closed",
    category: "failure-path",
    support: "supported",
    intent: "Reject an edit that targets an unknown clip",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "rename-clip", clipId: "clip-missing", name: "Should Fail" },
      expect: { isError: true, errorIncludes: "CLIP_NOT_FOUND" },
    }],
  },
  {
    id: "invalid-range-fails-closed",
    category: "failure-path",
    support: "supported",
    intent: "Reject a ripple delete with an invalid range",
    expectedTool: "editor.timeline.edit",
    steps: [{
      tool: "editor.timeline.edit",
      arguments: { ...editorTimelineTarget, type: "ripple-delete", timelineId: "timeline-evaluation", range: { start: 4, end: 4 } },
      expect: { isError: true },
    }],
  },
  {
    id: "undo-verified",
    category: "failure-path",
    support: "supported",
    intent: "Undo a verified rename and confirm the original state",
    expectedTool: "edit.undo",
    steps: [
      {
        tool: "editor.timeline.edit",
        arguments: { ...editorTimelineTarget, type: "rename-clip", clipId: "clip-interview", name: "Temporary Name" },
        expect: { json: { path: "status", equals: "VERIFIED" } },
        capture: { name: "transactionId", path: "id" },
      },
      {
        tool: "edit.undo",
        arguments: { transactionId: "$transactionId" },
        expect: { json: { path: "timeline.clips.0.name", equals: "Interview" } },
      },
    ],
  },
];

export async function runMcpEvaluation(): Promise<EvaluationReport> {
  const results = await Promise.all(scenarios.map((scenario) => runScenario(scenario)));
  const byCategory = {} as Record<EvaluationCategory, EvaluationCategoryMetrics>;
  for (const scenario of scenarios) {
    const category = scenario.category;
    const current = byCategory[category] ?? {
      total: 0,
      passed: 0,
      failed: 0,
      supported: 0,
      unavailable: 0,
      correctnessRate: 0,
      coverageRate: 0,
    };
    const result = results.find((candidate) => candidate.id === scenario.id);
    current.total += 1;
    if (result?.passed) current.passed += 1;
    current.failed = current.total - current.passed;
    if (scenario.support === "supported") current.supported += 1;
    else current.unavailable += 1;
    current.correctnessRate = current.total === 0 ? 1 : current.passed / current.total;
    current.coverageRate = current.total === 0 ? 1 : current.supported / current.total;
    byCategory[category] = current;
  }

  const passed = results.filter((result) => result.passed).length;
  const supported = scenarios.filter((scenario) => scenario.support === "supported").length;
  const consistent = scenarios.filter((scenario) => scenario.expectedTool === scenario.steps.at(-1)?.tool).length;
  return {
    version: 1,
    correctness: {
      total: results.length,
      passed,
      failed: results.length - passed,
      rate: results.length === 0 ? 1 : passed / results.length,
    },
    capability: {
      total: scenarios.length,
      supported,
      unavailable: scenarios.length - supported,
      coverageRate: scenarios.length === 0 ? 1 : supported / scenarios.length,
    },
    byCategory,
    scenarioConsistency: {
      total: scenarios.length,
      consistent,
      inconsistent: scenarios.length - consistent,
      rate: scenarios.length === 0 ? 1 : consistent / scenarios.length,
    },
    scenarios: results,
  };
}

export function renderEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `MCP evaluation v${report.version}`,
    `scenarios=${report.correctness.total} passed=${report.correctness.passed} failed=${report.correctness.failed} correctness_rate=${formatPercent(report.correctness.rate)}`,
    `capability total=${report.capability.total} supported=${report.capability.supported} unavailable=${report.capability.unavailable} capability_coverage=${formatPercent(report.capability.coverageRate)}`,
    `scenario_consistency total=${report.scenarioConsistency.total} consistent=${report.scenarioConsistency.consistent} inconsistent=${report.scenarioConsistency.inconsistent} scenario_consistency_rate=${formatPercent(report.scenarioConsistency.rate)}`,
  ];
  for (const [category, metrics] of Object.entries(report.byCategory)) {
    lines.push(`category=${category} total=${metrics.total} passed=${metrics.passed} failed=${metrics.failed} supported=${metrics.supported} unavailable=${metrics.unavailable} correctness_rate=${formatPercent(metrics.correctnessRate)} capability_coverage=${formatPercent(metrics.coverageRate)}`);
  }
  for (const scenario of report.scenarios.filter((candidate) => !candidate.passed)) {
    lines.push(`failure=${scenario.id} message=${scenario.message ?? "unknown"}`);
  }
  return lines.join("\n");
}

async function runScenario(scenario: EvaluationScenario): Promise<EvaluationScenarioResult> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "framekit-evaluation", version: "1.0.0" });
  const server = createMcpServer(new AgentVideoRuntime(createEvaluationEditor()));
  const captures: Record<string, JsonValue> = {};

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const step of scenario.steps) {
      const available = tools.tools.some((tool) => tool.name === step.tool);
      if (step.expect.toolAvailable !== undefined) {
        assert.equal(available, step.expect.toolAvailable, `${step.tool} availability mismatch`);
        continue;
      }
      assert.equal(available, true, `scenario requested unregistered tool ${step.tool}`);
      const result = await client.callTool({
        name: step.tool,
        arguments: resolvePlaceholders(step.arguments ?? {}, captures) as Record<string, unknown>,
      });
      const isError = result.isError === true;
      assert.equal(isError, step.expect.isError ?? false, `${step.tool} error status mismatch`);
      const responseText = extractResponseText(result);
      if (step.expect.errorIncludes) assert.match(responseText, new RegExp(escapeRegExp(step.expect.errorIncludes)));
      let payload: JsonValue | undefined;
      if (step.expect.json) {
        assert.equal(isError, false, `${step.tool} did not return JSON success data`);
        payload = JSON.parse(responseText) as JsonValue;
        const actual = readPath(payload, step.expect.json.path);
        if (step.expect.json.equals !== undefined) assert.deepEqual(actual, step.expect.json.equals);
        if (step.expect.json.includes !== undefined) assert.match(String(actual), new RegExp(escapeRegExp(step.expect.json.includes)));
      }
      if (step.capture) {
        if (payload === undefined) throw new Error(`capture ${step.capture.name} requires a JSON response`);
        const captureValue = readPath(payload, step.capture.path);
        assert.notEqual(captureValue, undefined, `capture path ${step.capture.path} was not present`);
        captures[step.capture.name] = captureValue!;
      }
    }
    return { id: scenario.id, category: scenario.category, support: scenario.support, intent: scenario.intent, passed: true };
  } catch (error) {
    return {
      id: scenario.id,
      category: scenario.category,
      support: scenario.support,
      intent: scenario.intent,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function createEvaluationEditor(): InMemoryEditorAdapter {
  const media: MediaContext[] = [
    { mediaId: "media-interview", source: "interview.mov" },
    { mediaId: "media-broll", source: "b-roll.mov" },
    { mediaId: "media-music", source: "music-bed.wav" },
  ];
  return new InMemoryEditorAdapter({
    projectId: "project-evaluation",
    projectName: "MCP Evaluation Fixture",
    timelineId: "timeline-evaluation",
    timelineName: "Main Edit",
    clips: [
      { id: "clip-interview", mediaId: "media-interview", name: "Interview", start: 0, duration: 8, track: 1 },
      { id: "clip-broll", mediaId: "media-broll", name: "B-roll", start: 8, duration: 4, track: 1 },
      { id: "clip-music", mediaId: "media-music", name: "Music Bed", start: 0, duration: 12, track: 2, gainDb: -6 },
    ],
    media,
    assets: [
      {
        id: "asset-cross-dissolve",
        kind: "transition",
        name: "Cross Dissolve",
        vendor: "Fixture Effects",
        metadata: { durationFrames: 12 },
        compatibility: { timelineKinds: ["asset-clip"] },
      },
      {
        id: "asset-lower-third",
        kind: "title",
        name: "Lower Third",
        vendor: "Fixture Titles",
        metadata: { supportsRoles: ["dialogue"] },
      },
    ],
  });
}

function extractResponseText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content.find((item): item is { type?: string; text?: string } =>
    item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text");
  return first?.text ?? "";
}

function resolvePlaceholders(value: JsonValue, captures: Record<string, JsonValue>): JsonValue;
function resolvePlaceholders(value: JsonObject, captures: Record<string, JsonValue>): JsonObject;
function resolvePlaceholders(value: JsonValue, captures: Record<string, JsonValue>): JsonValue {
  if (typeof value === "string" && value.startsWith("$")) return captures[value.slice(1)] ?? value;
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(item, captures));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, captures)]));
  }
  return value;
}

function readPath(value: JsonValue, path: string): JsonValue | undefined {
  return path.split(".").reduce<JsonValue | undefined>((current, segment) => {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) return current[Number(segment)];
    return current[segment];
  }, value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
