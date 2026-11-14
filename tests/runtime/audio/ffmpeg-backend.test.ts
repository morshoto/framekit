import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function backend(t: test.TestContext, options: {
  mode?: string; range?: { start: number; end: number }; occurrenceId?: string;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "framekit-ffmpeg-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "fixture.wav");
  await writeFile(source, "unchanged source bytes");
  const calls = join(directory, "calls.jsonl");
  const probe = join(directory, "ffprobe");
  const meter = join(directory, "ffmpeg");
  await writeFile(probe, ["#!/usr/bin/env node",
    'require("node:fs").appendFileSync(process.env.TEST_CALLS, "probe\\n");',
    'const audio = {codec_type:"audio", sample_rate:"48000", channels:1, channel_layout:"mono", start_time: process.env.TEST_MODE === "offset" ? "1" : "0"};',
    'process.stdout.write(JSON.stringify({streams: process.env.TEST_MODE === "multiple" ? [audio,audio] : [audio],format:{duration:"5"}}));',
  ].join("\n"));
  await writeFile(meter, ["#!/usr/bin/env node",
    'const fs=require("node:fs"); const args=process.argv.slice(2);',
    'fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args)+"\\n");',
    'if(args.includes("-y")){const trim=args.join(" ").match(/start_sample=(\\d+):end_sample=(\\d+)/); if(!trim)process.exit(1); const n=Number(trim[2])-Number(trim[1])-(process.env.TEST_MODE==="truncated"?1:0); fs.writeFileSync(args.at(-1),Buffer.alloc(n*4));}',
    'else {const mode=process.env.TEST_MODE; process.stderr.write("silence_duration: 0.125\\nSummary:\\n  Integrated loudness:\\n    I: "+(mode==="malformed"?"nan":"-20.0")+" LUFS\\n  True peak:\\n    Peak: "+(mode==="silence"?"-inf":"-3.0")+" dBFS\\n");}',
  ].join("\n"));
  await Promise.all([chmod(probe, 0o755), chmod(meter, 0o755)]);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("python3", ["apps/mcp-server/runtime/ffmpeg-audio-backend.py"], {
      env: { ...process.env, PATH: directory + ":" + process.env.PATH, TEST_CALLS: calls, TEST_MODE: options.mode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ media: { mediaId: "source", source, duration: 5 },
      range: options.range ?? { start: 1, end: 3 }, ...(options.occurrenceId ? { occurrenceId: options.occurrenceId } : {}) }));
  });
  assert.equal(await readFile(source, "utf8"), "unchanged source bytes");
  const invoked = await readFile(calls, "utf8").catch(() => "");
  return { ...result, invoked };
}

test("FFmpeg source backend preserves measured clock format and range without editing media", async (t) => {
  const result = await backend(t);
  assert.equal(result.code, 0, result.stderr);
  const audio = JSON.parse(result.stdout);
  assert.equal(audio.signalScope, "source");
  assert.equal(audio.integratedLufs, -20);
  assert.equal(audio.truePeakDb, -3);
  assert.equal(audio.silenceMs, 125);
  assert.deepEqual(audio.sourceTimebase, { value: "1", timescale: "48000" });
  assert.deepEqual(audio.signalFormat, { sampleRate: 48000, channels: 1, channelLayout: "mono" });
  assert.deepEqual(audio.requestedRange, { start: 1, end: 3 });
  assert.deepEqual(audio.measuredRange, { start: 1, end: 3,
    startTime: { value: "48000", timescale: "48000" }, durationTime: { value: "96000", timescale: "48000" } });
  assert.equal(audio.analyzedDurationSeconds, 2);
  assert.equal(audio.audibleSamples, undefined, "decoded samples must not be labelled audible samples");
});

test("FFmpeg source backend quantizes requested bounds inward to actual sample coordinates", async (t) => {
  const result = await backend(t, { range: { start: 0.00001, end: 2.00002 } });
  assert.equal(result.code, 0, result.stderr);
  const audio = JSON.parse(result.stdout);
  assert.equal(audio.measuredRange.start, 1 / 48000);
  assert.equal(audio.measuredRange.end, 2);
  assert.equal(audio.analyzedDurationSeconds, 95999 / 48000);
});

test("FFmpeg source backend rejects occurrence requests before invoking media tools", async (t) => {
  const result = await backend(t, { occurrenceId: "clip-1" });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /AUDIO_SCOPE_UNAVAILABLE/);
  assert.equal(result.invoked, "");
});

test("FFmpeg source backend rejects invalid requests before invoking media tools", async (t) => {
  const result = await backend(t, { range: { start: 3, end: 2 } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /AUDIO_REQUEST_INVALID/);
  assert.equal(result.invoked, "");
});

for (const mode of ["multiple", "offset", "truncated", "malformed", "silence"]) {
  test(`FFmpeg source backend rejects ${mode} evidence without fabricated metrics`, async (t) => {
    const result = await backend(t, { mode });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /AUDIO_(SOURCE|MEASUREMENT)_UNAVAILABLE/);
  });
}
