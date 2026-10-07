#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "tests/fixtures/headless-render/manifest.json");
const outputArgument = process.argv[2];
if (!outputArgument || process.argv.length !== 3) {
  console.error("usage: node scripts/generate-headless-render-fixtures.mjs <output-directory>");
  process.exitCode = 2;
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const outputDirectory = resolve(outputArgument);
  await mkdir(outputDirectory, { recursive: true });
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  for (const source of manifest.sources) {
    const outputPath = join(outputDirectory, source.filename);
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", source.videoFilter ?? `color=c=${source.color}:s=${source.width}x${source.height}:r=${source.frameRate.value}/${source.frameRate.timescale}:d=${source.durationSeconds}`,
      "-f", "lavfi",
      "-i", `sine=frequency=${source.frequencyHz}:sample_rate=${source.sampleRate}:duration=${source.durationSeconds}`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-t", String(source.durationSeconds),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-threads", "1",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", String(source.sampleRate),
      "-ac", String(source.channels),
      "-map_metadata", "-1",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);
  }
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
