import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CommandAudioAnalyzer } from "@framekit/final-cut";

function textFrom(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { text?: unknown } | undefined;
  assert.ok(first);
  assert.equal(typeof first?.text, "string");
  return first.text as string;
}

test("Final Cut MCP composes FCPXML reads, local analysis, assets, edits, and undo", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-finalcut-mcp-"));
  const xmlPath = join(directory, "project.fcpxml");
  const mediaPath = join(directory, "interview.wav");
  const assetRoot = join(directory, "Motion Templates.localized", "Transitions.localized", "Cross Dissolve.motr", "Contents");
  await mkdir(assetRoot, { recursive: true });
  await writeFile(mediaPath, "fixture media");
  await writeFile(join(assetRoot, "Info.plist"), `<?xml version="1.0"?><plist><dict><key>CFBundleDisplayName</key><string>Cross Dissolve</string><key>CFBundleIdentifier</key><string>Framekit Fixture</string></dict></plist>`);
  await writeFile(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources><asset id="r1" name="Interview.wav" src="interview.wav" /></resources>
  <library><event name="Event"><project name="MCP Final Cut"><sequence duration="10s"><spine>
    <asset-clip ref="r1" name="Interview" offset="0s" start="0s" duration="10s" lane="1" />
  </spine></sequence></project></event></library>
</fcpxml>`);

  const speech = await makeAnalyzer(directory, JSON.stringify({ words: [{ text: "um", start: 0, end: 0.3, confidence: 0.98, filler: true }] }));
  const audio = await makeAnalyzer(directory, JSON.stringify({ integratedLufs: -18, truePeakDb: -3, silenceMs: 120 }));
  const visual = await makeAnalyzer(directory, JSON.stringify({
    scenes: [{ id: "scene-1", start: 0, end: 10, label: "interview", confidence: 0.97 }],
    subjects: [{ id: "subject-1", label: "person", confidence: 0.99, start: 0, end: 10 }],
    motion: { score: 0.12, label: "low" },
    keyframes: [{ time: 1, source: mediaPath, labels: ["person"] }],
  }));

  const here = dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(here, "../../apps/mcp-server/src/main.ts")],
    env: {
      ...process.env,
      FRAMEKIT_EDITOR: "final-cut-live",
      FRAMEKIT_AUTO_CONNECT: "0",
      FRAMEKIT_FINAL_CUT_SOCKET: join(directory, "missing.sock"),
      FRAMEKIT_FCPXML_PATH: xmlPath,
      FRAMEKIT_FINAL_CUT_ASSET_ROOTS: join(directory, "Motion Templates.localized"),
      FRAMEKIT_SPEECH_ANALYZER: speech,
      FRAMEKIT_AUDIO_ANALYZER: audio,
      FRAMEKIT_VISUAL_ANALYZER: visual,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "finalcut-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const editor = JSON.parse(textFrom(await client.callTool({ name: "editor.inspect", arguments: {} })));
    assert.equal(editor.identity.backend, "final-cut-session");
    assert.equal(editor.capabilities.editor.timelineSnapshotRead, true);
    assert.equal(editor.capabilities.editor.timelineArtifactWrite, true);
    assert.equal(editor.capabilities.editor.rollback, true);
    assert.equal(editor.capabilities.editor.assetDiscovery, true);
    assert.equal(editor.capabilities.analyzers.speechTranscribe, true);
    assert.equal(editor.capabilities.analyzers.audioLoudness, true);
    assert.equal(editor.capabilities.analyzers.visualTrack, true);

    const projectResult = await client.callTool({ name: "project.inspect", arguments: {} });
    const project = JSON.parse(textFrom(projectResult));
    assert.equal(project.projectName, "MCP Final Cut");
    assert.equal(project.media[0].source, mediaPath);

    const context = JSON.parse(textFrom(await client.callTool({ name: "context.inspect", arguments: {} })));
    assert.equal(context.project.projectName, "MCP Final Cut");
    if (context.editorState) assert.equal(context.editorState.project?.name, "Playhead Phase 1 E2E");

    const speechResult = JSON.parse(textFrom(await client.callTool({ name: "speech.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(speechResult.words[0].filler, true);
    const audioResult = JSON.parse(textFrom(await client.callTool({ name: "audio.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(audioResult.integratedLufs, -18);
    const visualResult = JSON.parse(textFrom(await client.callTool({ name: "visual.analyze", arguments: { mediaId: "r1" } })));
    assert.equal(visualResult.subjects[0].label, "person");
    const understanding = JSON.parse(textFrom(await client.callTool({ name: "media.understand", arguments: { mediaId: "r1" } })));
    assert.equal(understanding.visual.scenes[0].label, "interview");

    const assets = JSON.parse(textFrom(await client.callTool({ name: "editor.assets", arguments: { query: "dissolve" } })));
    assert.equal(assets[0].name, "Cross Dissolve");

    const edited = JSON.parse(textFrom(await client.callTool({
      name: "timeline.edit",
      arguments: { type: "rename-clip", clipId: "timeline:MCP Final Cut:spine:0:asset-clip", name: "Interview Clean", baseRevision: project.revision },
    })));
    assert.equal(edited.status, "VERIFIED");
    assert.equal(edited.after.timeline.clips[0].name, "Interview Clean");

    const diff = JSON.parse(textFrom(await client.callTool({ name: "edit.diff", arguments: { transactionId: edited.id } })));
    assert.equal(diff.modified[0].after.name, "Interview Clean");
    const verification = JSON.parse(textFrom(await client.callTool({ name: "edit.verify", arguments: { transactionId: edited.id } })));
    assert.equal(verification.passed, true);
    const undone = JSON.parse(textFrom(await client.callTool({ name: "edit.undo", arguments: { transactionId: edited.id } })));
    assert.equal(undone.timeline.clips[0].name, "Interview");
  } finally {
    await client.close();
    await transport.close();
  }
});

test("local analyzer commands fail closed for unavailable media and invalid output", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-analyzer-errors-"));
  const mediaPath = join(directory, "media.wav");
  await writeFile(mediaPath, "fixture media");
  const invalid = await makeAnalyzer(directory, JSON.stringify({ integratedLufs: -18 }));
  const analyzer = new CommandAudioAnalyzer({ command: invalid });
  const input = {
    project: {
      projectId: "project-1",
      projectName: "Analyzer Test",
      timeline: { id: "timeline-1", name: "Timeline", duration: 1, clips: [], storyElements: [], markers: [], captions: [] },
      media: [{ mediaId: "media-1", source: mediaPath }],
      revision: { id: "rev-0", sequence: 0, timestamp: new Date(0).toISOString() },
    },
    media: { mediaId: "media-1", source: mediaPath },
  };
  await assert.rejects(analyzer.analyze(input), /ANALYZER_INVALID_OUTPUT/);
  await assert.rejects(analyzer.analyze({ ...input, media: { mediaId: "media-1", source: join(directory, "missing.wav") } }), /ANALYZER_MEDIA_UNAVAILABLE/);
});

async function makeAnalyzer(directory: string, output: string): Promise<string> {
  const path = join(directory, `analyzer-${Math.random().toString(16).slice(2)}.sh`);
  await writeFile(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${output.replaceAll("'", "'\\''")}'\n`);
  await chmod(path, 0o755);
  return path;
}
