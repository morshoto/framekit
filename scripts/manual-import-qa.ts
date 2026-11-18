import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FcpxmlDocumentAdapter } from "@framekit/final-cut";

const run = promisify(execFile);
/** Artifact measurements cannot establish how a movie was produced or imported. */
export interface ExportMeasurements {
  durationSeconds: number;
  samples: Array<{ timeSeconds: number; rgb: [number, number, number] }>;
  toneAmplitudes: number[];
}

export function evaluateExportMeasurements(observed: ExportMeasurements) {
  const samples = [0.5, 1.5, 2.5];
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 3) <= 0.05;
  const video = observed.samples.length === 3 && observed.samples.every((sample, index) => {
    const [r, g, b] = sample.rgb;
    const components = [r, g, b];
    const dominant = components[index]!;
    return Math.abs(sample.timeSeconds - samples[index]!) < 0.001
      && components.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
      && dominant > 140 && components.every((value, channel) => channel === index || dominant - value > 100);
  });
  const audio = observed.toneAmplitudes.length === 3 && observed.toneAmplitudes.every((value) => Number.isFinite(value) && value >= 0.002 && value <= 0.2);
  return {
    status: duration && video && audio ? "PASS" as const : "FAIL" as const,
    checks: { duration, video, audio },
    nativeImport: "UNVERIFIED" as const,
    titleEditability: "UNVERIFIED" as const,
    finalCutProvenance: "UNVERIFIED" as const,
  };
}


/** Decode independent output measurements; this never establishes native provenance. */
export async function measureExport(path: string): Promise<ExportMeasurements> {
  const ffprobe = process.env.FFPROBE_BIN || "ffprobe";
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const probe = JSON.parse((await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path])).stdout) as {
    format?: { duration?: string }; streams?: Array<{ codec_type?: string }>;
  };
  if (!probe.streams?.some((stream) => stream.codec_type === "video")) throw new Error("EXPORT_INVALID: video stream missing");
  const hasAudio = probe.streams.some((stream) => stream.codec_type === "audio");
  const samples: ExportMeasurements["samples"] = [];
  const toneAmplitudes: number[] = [];
  for (const timeSeconds of [0.5, 1.5, 2.5]) {
    const pixels = await runBytes(ffmpeg, ["-v", "error", "-ss", String(timeSeconds), "-i", path,
      "-vf", "crop=2:2:2:2,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
    if (pixels.length !== 12) throw new Error(`EXPORT_INVALID: missing frame at ${timeSeconds}s`);
    samples.push({ timeSeconds, rgb: [pixels[0]!, pixels[1]!, pixels[2]!] });
    if (!hasAudio) { toneAmplitudes.push(0); continue; }
    const audio = await runBytes(ffmpeg, ["-v", "error", "-ss", String(timeSeconds - 0.125), "-i", path,
      "-t", "0.25", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
    const count = Math.floor(audio.length / 2);
    if (count < 1900) { toneAmplitudes.push(0); continue; }
    let sine = 0;
    let cosine = 0;
    for (let i = 0; i < count; i++) {
      const value = audio.readInt16LE(i * 2) / 32768;
      const phase = 2 * Math.PI * 880 * i / 8000;
      sine += value * Math.sin(phase);
      cosine += value * Math.cos(phase);
    }
    toneAmplitudes.push(2 * Math.hypot(sine, cosine) / count);
  }
  return { durationSeconds: Number(probe.format?.duration), samples, toneAmplitudes };
}

function runBytes(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}


/** Generate non-private inputs and the exact production-MCP FCPXML handoff. */
export async function prepareManualImportFixture(outputDirectory: string) {
  const destination = resolve(outputDirectory);
  await mkdir(destination); // Exclusive: never overwrite a pre-existing directory.
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const sources = [
    { filename: "red.mp4", color: "red" },
    { filename: "green.mp4", color: "lime" },
    { filename: "blue.mp4", color: "blue" },
  ];
  for (const source of sources) {
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n",
      "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", `color=${source.color}:s=320x180:r=30:d=2`,
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", join(destination, source.filename)]);
  }
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i",
    "sine=frequency=880:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", join(destination, "music.wav")]);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { FRAMEKIT_EDITOR: "final-cut-live", FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_HEADLESS: "1",
    FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_FINAL_CUT_SOCKET: join(destination, "absent.sock"),
    FRAMEKIT_FCPXML_PATH: join(destination, "absent.fcpxml"), FRAMEKIT_STATE_DIR: join(destination, "state") });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", join(repository, "apps/mcp-server/src/main.ts")], env, stderr: "pipe" });
  const client = new Client({ name: "framekit-manual-import-qa", version: "1.0.0" });
  const seconds = (value: number) => ({ value: String(value), timescale: "1" });
  const projectId = `qa-${randomUUID()}`;
  const sequenceId = `sequence-${randomUUID()}`;
  const artifactPath = join(destination, "edit.fcpxml");
  let result: any;
  let media: Array<{ filename: string; id: string }> = [];
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as Array<{ type: string; text?: string }>;
      if (response.isError || content[0]?.type !== "text") throw new Error(`${name}: ${content[0]?.text ?? "invalid response"}`);
      return JSON.parse(content[0].text ?? "null");
    };
    const created = await call("headless.project.create", { timeline: {
      schemaVersion: 1, project: { id: projectId, name: "Disposable Framekit QA" },
      sequence: { id: sequenceId, name: "Manual import QA", durationTime: seconds(0), frameDuration: { value: "1", timescale: "30" },
        occurrences: [], storyElements: [], markers: [], captions: [], titles: [], transitions: [] },
      resources: [], revision: { id: "initial", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" },
    } });
    let revision = created.timeline.revision;
    for (const filename of [...sources.map((source) => source.filename), "music.wav"]) {
      const registered = await call("headless.media.register", { projectId, sourcePath: join(destination, filename), expectedRevision: revision });
      media.push({ filename, id: registered.resource.id });
      revision = registered.project.timeline.revision;
    }
    const edit = { schemaVersion: 1, clips: media.slice(0, 3).map((source, index) => ({
      id: `clip-${index + 1}`, mediaId: source.id, sourceStartTime: seconds(1), durationTime: seconds(1),
    })), title: { id: "title", text: "FRAMEKIT QA", startTime: seconds(0), durationTime: seconds(1) },
    music: { id: "music", mediaId: media[3]!.id, sourceStartTime: seconds(0), startTime: seconds(0), durationTime: seconds(3), gainDb: -12 } };
    const request = { projectId, sequenceId, expectedRevision: revision, edit };
    const preview = await call("headless.edit-json.preview", request);
    const executed = await call("headless.edit-json.execute", { ...request, approved: true, planDigest: preview.planDigest });
    result = await call("headless.fcpxml.export", { projectId, sequenceId, expectedRevision: executed.after.timeline.revision,
      outputPath: artifactPath, target: { provider: "final-cut", libraryUid: "disposable-library", eventUid: "disposable-event",
        projectUid: `qa-${randomUUID()}`, sequenceUid: `qa-${randomUUID()}`, materialization: "versioned" } });
    if (!result.artifact?.verified) throw new Error("ARTIFACT_INVALID: production export was not verified");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  await verifyPreparedArtifact(artifactPath, destination);
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const sourceRecords = await Promise.all(media.map(async ({ filename }) => ({ filename, sha256: await sha(join(destination, filename)) })));
  const git = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const dirty = Boolean((await run("git", ["status", "--porcelain"], { cwd: repository })).stdout.trim());
  const packageVersion = (JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as { version: string }).version;
  const manifestPath = join(destination, "reference.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, candidate: { commit: git, dirty, framekitVersion: packageVersion },
    sources: sourceRecords, artifact: { filename: "edit.fcpxml", sha256: await sha(artifactPath), revision: result.provenance.revision },
    expected: { sourceOrder: ["red.mp4", "green.mp4", "blue.mp4"], sourceStartSeconds: 1, clipDurationSeconds: 1,
      durationSeconds: 3, samples: [{ timeSeconds: 0.5, color: "red" }, { timeSeconds: 1.5, color: "green" }, { timeSeconds: 2.5, color: "blue" }],
      title: { text: "FRAMEKIT QA", startSeconds: 0, durationSeconds: 1 }, music: { frequencyHz: 880, gainDb: -12 } },
    evidence: { artifact: "PASS", nativeImport: "UNVERIFIED", finalCutExport: "UNVERIFIED", titleEditability: "UNVERIFIED" },
  }, null, 2)}\n`, { flag: "wx" });
  return { artifactPath, manifestPath, nativeImport: "UNVERIFIED" as const, finalCutExport: "UNVERIFIED" as const };
}

/** Compare the generated FCPXML with fixed source, timing, title and music expectations. */
export async function verifyPreparedArtifact(artifactPath: string, fixtureDirectory: string): Promise<void> {
  const snapshot = await new FcpxmlDocumentAdapter(artifactPath).readProject();
  const sourceFor = (id: string | undefined) => snapshot.media.find((item) => item.mediaId === id)?.source;
  const expected = ["red.mp4", "green.mp4", "blue.mp4"].map((name) => join(resolve(fixtureDirectory), name));
  const clips = snapshot.timeline.clips.filter((clip) => clip.track === 0);
  if (clips.length !== 3 || clips.some((clip, index) => sourceFor(clip.mediaId) !== expected[index]
    || clip.start !== index || clip.sourceStart !== 1 || clip.duration !== 1)) {
    throw new Error("ARTIFACT_INVALID: source order or trimmed ranges differ from the independent reference");
  }
  const title = snapshot.timeline.storyElements.find((element) => element.kind === "title");
  if (!title || title.text !== "FRAMEKIT QA" || title.start !== 0 || title.duration !== 1) {
    throw new Error("ARTIFACT_INVALID: title text or timing differs from the independent reference");
  }
  const music = snapshot.timeline.clips.filter((clip) => sourceFor(clip.mediaId) === join(resolve(fixtureDirectory), "music.wav"));
  if (music.length !== 1 || music[0]!.start !== 0 || music[0]!.sourceStart !== 0 || music[0]!.duration !== 3) {
    throw new Error("ARTIFACT_INVALID: music source or range differs from the independent reference");
  }
  const xml = await readFile(artifactPath, "utf8");
  if (!xml.includes('audioRole="music"') || !xml.includes('<adjust-volume amount="-12dB" />')) {
    throw new Error("ARTIFACT_INVALID: music or static gain missing");
  }
}

/** Inspect a supplied movie and leave native provenance and human observations unresolved. */
export async function verifyManualExport(fixtureDirectory: string, exportPath: string, outputDirectory: string) {
  const fixture = resolve(fixtureDirectory);
  const destination = resolve(outputDirectory);
  const manifest = JSON.parse(await readFile(join(fixture, "reference.json"), "utf8")) as {
    schemaVersion: number;
    sources: Array<{ filename: string; sha256: string }>;
    artifact: { filename: string; sha256: string };
    expected: { sourceOrder: string[]; sourceStartSeconds: number; clipDurationSeconds: number; durationSeconds: number;
      title: { text: string; startSeconds: number; durationSeconds: number }; music: { frequencyHz: number; gainDb: number } };
  };
  const names = ["red.mp4", "green.mp4", "blue.mp4", "music.wav"];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)
    || JSON.stringify(manifest.sources.map((source) => source.filename)) !== JSON.stringify(names)
    || manifest.artifact?.filename !== "edit.fcpxml"
    || JSON.stringify(manifest.expected?.sourceOrder) !== JSON.stringify(names.slice(0, 3))
    || manifest.expected.sourceStartSeconds !== 1 || manifest.expected.clipDurationSeconds !== 1 || manifest.expected.durationSeconds !== 3
    || manifest.expected.title?.text !== "FRAMEKIT QA" || manifest.expected.title.startSeconds !== 0 || manifest.expected.title.durationSeconds !== 1
    || manifest.expected.music?.frequencyHz !== 880 || manifest.expected.music.gainDb !== -12) {
    throw new Error("REFERENCE_INVALID: unsupported or changed independent reference");
  }
  const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const checkSources = async () => {
    for (const source of manifest.sources) {
      if (!/^[a-f0-9]{64}$/.test(source.sha256) || await sha(join(fixture, source.filename)) !== source.sha256) {
        throw new Error(`SOURCE_CHANGED: ${source.filename}`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.artifact.sha256) || await sha(join(fixture, manifest.artifact.filename)) !== manifest.artifact.sha256) {
      throw new Error("ARTIFACT_CHANGED: edit.fcpxml");
    }
  };
  await checkSources();
  const movieDigest = await sha(exportPath);
  await mkdir(destination); // Existing reports are never replaced.
  const observed = await measureExport(exportPath);
  const titleFramePath = join(destination, "title-frame.png");
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-n", "-ss", "0.5", "-i", exportPath, "-frames:v", "1", titleFramePath]);
  await checkSources();
  if (await sha(exportPath) !== movieDigest) throw new Error("EXPORT_CHANGED: video changed during inspection");
  const report = { schemaVersion: 1, exportSha256: movieDigest, artifactSha256: manifest.artifact.sha256,
    observed, measurements: evaluateExportMeasurements(observed), titleVisibility: "UNVERIFIED" as const,
    titleFramePath, limitation: "Media measurements alone do not prove a Final Cut import, export, or title editability." };
  await writeFile(join(destination, "observation.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

async function main(args: string[]): Promise<void> {
  const usage = [
    "Usage: node --import tsx scripts/manual-import-qa.ts prepare NEW_DIRECTORY",
    "       node --import tsx scripts/manual-import-qa.ts inspect FIXTURE_DIRECTORY VIDEO NEW_REPORT_DIRECTORY",
    "These commands never operate Final Cut; native import, title editability and export provenance remain UNVERIFIED.",
  ].join("\n");
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${usage}\n`); return; }
  if (args[0] === "prepare" && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await prepareManualImportFixture(args[1]!), null, 2)}\n`);
    return;
  }
  if (args[0] === "inspect" && args.length === 4) {
    const report = await verifyManualExport(args[1]!, args[2]!, args[3]!);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.measurements.status !== "PASS") process.exitCode = 1;
    return;
  }
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
