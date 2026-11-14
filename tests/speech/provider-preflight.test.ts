import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AudioAnalyzer, SpeechAnalyzer } from "@framekit/runtime";
import { runAnalysisProviderPreflight } from "../../scripts/run-analysis-provider-preflight.js";

const spec = JSON.parse(await readFile(new URL("../fixtures/codex-video-speech/fixture-spec.json", import.meta.url), "utf8")) as {
  clips: Array<{ id: string; filename: string; expectedTokens: string[] }>;
};

async function fixtures(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "framekit-provider-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = [];
  for (const clip of spec.clips) {
    const data = Buffer.from("synthetic fixture " + clip.id);
    await writeFile(join(directory, clip.filename), data);
    assets.push({ filename: clip.filename, sha256: createHash("sha256").update(data).digest("hex") });
  }
  await writeFile(join(directory, "fixture-manifest.json"), JSON.stringify({ assets }));
  return directory;
}

function speech(vad = false): SpeechAnalyzer {
  return {
    descriptor: { id: "fixture.preflight", provider: "fixture", version: "1" },
    analyze: async ({ media }, range) => {
      const clip = spec.clips.find((value) => media.mediaId === "preflight-" + value.id)!;
      return {
        words: clip.expectedTokens.map((text, index) => ({ text, start: range!.start + index, end: range!.start + index + 0.5, confidence: 1 })),
        sourceTimebase: { value: "1", timescale: "1000" },
        ...(vad ? { vadSegments: [{ start: range!.start, end: range!.end, kind: "speech" as const }] } : {}),
      };
    },
  };
}

const audio: AudioAnalyzer = {
  descriptor: { id: "fixture.audio", provider: "fixture", version: "1" },
  analyze: async (_input, range) => ({ integratedLufs: -18, truePeakDb: -1, silenceMs: 0, signalScope: "source",
    sourceTimebase: { value: "1", timescale: "48000" }, signalFormat: { sampleRate: 48000, channels: 1 },
    measuredRange: range }),
};

test("provider preflight preserves transcription while required VAD and audio stay blocked", async (t) => {
  const report = await runAnalysisProviderPreflight({ fixtures: await fixtures(t), speechAnalyzer: speech() });
  assert.equal(report.status, "blocked");
  assert.equal(report.nativeAcceptance, "not-run");
  assert.equal(report.evidence, "headless-command-provider");
  assert.equal(report.sourceIntegrity, "unchanged");
  for (const asset of report.assets) {
    assert.equal(asset.speech.status, "available");
    assert.equal(asset.speech.expectedTokensMatched, true);
    assert.equal(asset.vad.status, "unavailable");
    assert.equal(asset.audio.status, "unavailable");
    assert.equal(asset.audio.integratedLufs, undefined);
  }
});

test("ready provider preflight does not claim native acceptance", async (t) => {
  const report = await runAnalysisProviderPreflight({ fixtures: await fixtures(t), speechAnalyzer: speech(true), audioAnalyzer: audio });
  assert.equal(report.status, "ready");
  assert.equal(report.nativeAcceptance, "not-run");
  for (const asset of report.assets) {
    assert.equal(asset.vad.status, "available");
    assert.equal(asset.audio.signalScope, "source");
    assert.deepEqual(asset.audio.sourceTimebase, { value: "1", timescale: "48000" });
    assert.deepEqual(asset.audio.signalFormat, { sampleRate: 48000, channels: 1 });
    assert.deepEqual(asset.audio.measuredRange, asset.requestedRange);
  }
});

test("provider preflight verifies fixture hashes before invoking analyzers", async (t) => {
  const directory = await fixtures(t);
  await writeFile(join(directory, spec.clips[0]!.filename), "replaced");
  let calls = 0;
  await assert.rejects(runAnalysisProviderPreflight({ fixtures: directory, speechAnalyzer: {
    ...speech(), analyze: async () => { calls++; throw new Error("must not run"); },
  } }), /PREFLIGHT_SOURCE_CHANGED/);
  assert.equal(calls, 0);
});

test("provider preflight requires version pins before invoking a provider", async (t) => {
  let calls = 0;
  const report = await runAnalysisProviderPreflight({ fixtures: await fixtures(t), speechAnalyzer: {
    descriptor: { id: "fixture.preflight", provider: "fixture" },
    analyze: async () => { calls++; throw new Error("must not run"); },
  } });
  assert.equal(calls, 0);
  assert.equal(report.status, "blocked");
  for (const asset of report.assets) assert.equal(asset.speech.reason, "provider-version-unpinned");
});

test("provider preflight reports an independent expected-token mismatch", async (t) => {
  const report = await runAnalysisProviderPreflight({ fixtures: await fixtures(t), speechAnalyzer: {
    ...speech(true), analyze: async (_input, range) => ({
      words: [{ text: "unrelated", start: range!.start, end: range!.start + 1, confidence: 1 }],
      sourceTimebase: { value: "1", timescale: "1000" },
      vadSegments: [{ start: range!.start, end: range!.end, kind: "speech" }],
    }),
  }, audioAnalyzer: audio });
  assert.equal(report.status, "blocked");
  for (const asset of report.assets) {
    assert.equal(asset.speech.status, "available");
    assert.equal(asset.speech.expectedTokensMatched, false);
  }
});
