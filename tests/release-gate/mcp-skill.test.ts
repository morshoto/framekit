import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentVideoRuntime, type AudioAnalyzer, type SpeechAnalyzer } from "@framekit/runtime";
import { InMemoryEditorAdapter } from "@framekit/testkit";
import { createMcpServer } from "../../apps/mcp-server/src/server.js";

function textFrom(value: unknown): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  assert.equal(content?.[0]?.type, "text");
  return content?.[0]?.text ?? "";
}

test("generic Skill tools execute filler removal and dialogue normalization", async () => {
  const adapter = new InMemoryEditorAdapter({
    projectId: "skill-project",
    projectName: "Skill Fixture",
    timelineId: "skill-timeline",
    timelineName: "Main Edit",
    clips: [
      { id: "dialogue-clip", mediaId: "dialogue-media", name: "Dialogue", start: 0, duration: 10, track: 1 },
      { id: "filler-clip", mediaId: "filler-media", name: "Filler", start: 10, duration: 4, track: 1 },
    ],
    media: [
      {
        mediaId: "dialogue-media",
        source: "fixtures/dialogue.wav",
        mediaKind: "video",
        duration: 10,
        speech: { words: [{ text: "hello", start: 0, end: 2, confidence: 0.99 }] },
      },
      {
        mediaId: "filler-media",
        source: "fixtures/filler.wav",
        mediaKind: "video",
        duration: 4,
        speech: {
          words: [
            { text: "so", start: 0, end: 0.3, confidence: 0.99 },
            { text: "um", start: 1, end: 1.3, confidence: 0.98, filler: true },
            { text: "yes", start: 1.4, end: 2, confidence: 0.99 },
          ],
        },
      },
    ],
  });
  let fillerAnalysisCalls = 0;
  const speechAnalyzer: SpeechAnalyzer = {
    analyze: async ({ media, project }) => {
      fillerAnalysisCalls += 1;
      const fillerClip = project.timeline.clips.find((clip) => clip.id === "filler-clip");
      if (media.mediaId === "filler-media" && fillerAnalysisCalls > 1 && (fillerClip?.duration ?? 4) < 4) {
        return { words: [
          { text: "so", start: 0, end: 0.3, confidence: 0.99 },
          { text: "yes", start: 0.4, end: 1, confidence: 0.99 },
        ] };
      }
      return structuredClone(media.speech!);
    },
  };
  const audioAnalyzer: AudioAnalyzer = {
    analyze: async ({ project }) => {
      const gain = project.timeline.clips.find((clip) => clip.id === "dialogue-clip")?.gainDb ?? 0;
      return {
        integratedLufs: -20 + gain,
        truePeakDb: -6 + gain,
        silenceMs: 100,
        analyzedDurationSeconds: 10,
        dialoguePresent: true,
      };
    },
  };
  const runtime = new AgentVideoRuntime(adapter, { speechAnalyzer, audioAnalyzer });
  const server = createMcpServer(runtime);
  const client = new Client({ name: "generic-skill-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))) as {
      revision: { id: string; sequence: number; timestamp: string };
    };
    const dialoguePreview = await client.callTool({
      name: "skill.preview",
      arguments: {
        skill: "dialogue-normalization",
        arguments: {
          mediaId: "dialogue-media",
          occurrenceId: "dialogue-clip",
          baseRevision: before.revision,
          targetLufs: -16,
          toleranceDb: 0.5,
          maxTruePeakDb: -1,
          minGainDb: -6,
          maxGainDb: 6,
          minDialogueDurationSeconds: 1,
        },
      },
    });
    const dialoguePlan = JSON.parse(textFrom(dialoguePreview)) as { previewToken: string; plan: { decision: string } };
    assert.equal(dialoguePlan.plan.decision, "APPLY");
    const dialogueResult = await client.callTool({
      name: "skill.execute",
      arguments: { skill: "dialogue-normalization", previewToken: dialoguePlan.previewToken },
    });
    assert.equal(JSON.parse(textFrom(dialogueResult)).status, "VERIFIED");

    const afterDialogue = JSON.parse(textFrom(await client.callTool({ name: "project.inspect", arguments: {} }))) as {
      revision: { id: string; sequence: number; timestamp: string };
    };
    const fillerPreview = await client.callTool({
      name: "skill.preview",
      arguments: {
        skill: "filler-removal",
        arguments: {
          range: { start: 10, end: 14 },
          baseRevision: afterDialogue.revision,
        },
      },
    });
    const fillerPlan = JSON.parse(textFrom(fillerPreview)) as { previewToken: string; candidates: unknown[] };
    assert.equal(fillerPlan.candidates.length, 1);
    const fillerResult = await client.callTool({
      name: "skill.execute",
      arguments: { skill: "filler-removal", previewToken: fillerPlan.previewToken },
    });
    assert.equal(JSON.parse(textFrom(fillerResult)).status, "VERIFIED");
  } finally {
    await client.close();
    await server.close();
  }
});
