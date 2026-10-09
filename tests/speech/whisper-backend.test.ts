import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

function runBackend(input: unknown, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [join(process.cwd(), "scripts/whisper-speech-backend.py")], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function createFakeMlxBackend(directory: string): Promise<string> {
  const packageDirectory = join(directory, "fake-packages");
  const moduleDirectory = join(packageDirectory, "mlx_whisper");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "__init__.py"), [
    "def transcribe(source, path_or_hf_repo, word_timestamps, language=None):",
    "    assert source.endswith('interview.wav')",
    "    assert path_or_hf_repo == 'fake/model'",
    "    assert word_timestamps is True",
    "    assert language == 'en'",
    "    return {'segments': [",
    "        {'start': 0, 'end': 1, 'text': 'outside', 'words': [{'word': 'outside', 'start': 0, 'end': 1, 'probability': 0.9}]},",
    "        {'start': 1.25, 'end': 1.75, 'words': [{'word': 'inside', 'start': 1.25, 'end': 1.75, 'probability': 0.8}]},",
    "        {'start': 2, 'end': 2.5, 'text': 'timestamp fallback'},",
    "        {'start': 3, 'end': 3.5, 'words': [{'word': 'last', 'start': 3, 'end': 3.5, 'probability': 0.7}]},",
    "    ]}",
  ].join("\n"));
  return packageDirectory;
}

test("local Whisper backend normalizes word timestamps and source ranges", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-whisper-backend-"));
  const mediaPath = join(directory, "interview.wav");
  await writeFile(mediaPath, "fixture media");
  const pythonPath = await createFakeMlxBackend(directory);

  const result = await runBackend({
    schemaVersion: 1,
    media: { mediaId: "media-1", source: mediaPath, duration: 4 },
    range: { start: 1, end: 4 },
  }, {
    ...process.env,
    PYTHONPATH: pythonPath,
    FRAMEKIT_WHISPER_BACKEND: "mlx-whisper",
    FRAMEKIT_WHISPER_MODEL: "fake/model",
    FRAMEKIT_WHISPER_LANGUAGE: "en",
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    words: [
      { text: "inside", start: 1.25, end: 1.75, confidence: 0.8 },
      { text: "timestamp fallback", start: 2, end: 2.5, confidence: 0 },
      { text: "last", start: 3, end: 3.5, confidence: 0.7 },
    ],
    sourceTimebase: { value: "1", timescale: "1000" },
  });
});

test("local Whisper backend reports missing model configuration", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-whisper-setup-"));
  const mediaPath = join(directory, "interview.wav");
  await writeFile(mediaPath, "fixture media");
  const pythonPath = await createFakeMlxBackend(directory);

  const result = await runBackend({
    schemaVersion: 1,
    media: { mediaId: "media-1", source: mediaPath },
  }, {
    ...process.env,
    PYTHONPATH: pythonPath,
    FRAMEKIT_WHISPER_BACKEND: "mlx-whisper",
    FRAMEKIT_WHISPER_MODEL: "",
  });

  assert.equal(result.code, 78);
  assert.match(result.stderr, /WHISPER_SETUP_REQUIRED: set FRAMEKIT_WHISPER_MODEL/);
});
