#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(repositoryRoot, "tests/fixtures/codex-video-speech/fixture-spec.json");
const outputArgument = process.argv[2];
if (!outputArgument || process.argv.length !== 3) {
  console.error("usage: node scripts/generate-codex-video-speech-fixtures.mjs <output-directory>");
  process.exitCode = 2;
} else {
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const outputDirectory = resolve(outputArgument);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "framekit-codex-speech-"));
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const say = process.env.SAY_BIN || "say";
  try {
    for (const clip of spec.clips) {
      const narrationPath = join(temporaryDirectory, `${clip.id}.aiff`);
      const outputPath = join(outputDirectory, clip.filename);
      await run(say, ["-v", spec.voice.name, "-r", String(spec.voice.rateWordsPerMinute), "-o", narrationPath, clip.speechText]);
      const audioDelayMs = Math.round(clip.speechStartSeconds * 1000);
      const videoFilter = `color=c=${clip.color}:s=${spec.video.width}x${spec.video.height}:r=${spec.video.frameRate}:d=${clip.durationSeconds}`;
      await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", videoFilter,
        "-i", narrationPath,
        "-filter_complex", `[1:a]adelay=${audioDelayMs}:all=1,apad,atrim=duration=${clip.durationSeconds},asetpts=PTS-STARTPTS[voice]`,
        "-map", "0:v:0", "-map", "[voice]",
        "-t", String(clip.durationSeconds),
        "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p",
        "-r", String(spec.video.frameRate),
        "-c:a", "aac", "-b:a", "128k", "-ar", String(spec.video.sampleRate), "-ac", "1",
        "-map_metadata", "-1", "-movflags", "+faststart", "-y", outputPath,
      ]);
    }

    const music = spec.music;
    const musicInputs = music.frequenciesHz.flatMap((frequency) => [
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${music.sampleRate}:duration=${music.durationSeconds}`,
    ]);
    const musicLabels = music.frequenciesHz.map((_, index) => `[${index}:a]`).join("");
    const musicPath = join(outputDirectory, music.filename);
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", ...musicInputs,
      "-filter_complex", `${musicLabels}amix=inputs=${music.frequenciesHz.length}:duration=longest:dropout_transition=0:normalize=0,aformat=sample_rates=${music.sampleRate}:channel_layouts=stereo[music]`,
      "-map", "[music]", "-t", String(music.durationSeconds),
      "-c:a", "pcm_s16le", "-ar", String(music.sampleRate), "-ac", String(music.channels),
      "-map_metadata", "-1", "-y", musicPath,
    ]);

    const files = [...spec.clips.map(({ filename }) => filename), music.filename];
    const generated = {
      ...spec,
      generatedAt: new Date().toISOString(),
      assets: await Promise.all(files.map(async (filename) => ({
        filename,
        sha256: createHash("sha256").update(await readFile(join(outputDirectory, filename))).digest("hex"),
      }))),
    };
    await writeFile(join(outputDirectory, "fixture-manifest.json"), `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ outputDirectory, assets: generated.assets }, null, 2)}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${signal || code}`));
    });
  });
}
