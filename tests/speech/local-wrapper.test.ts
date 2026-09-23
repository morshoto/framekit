import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

function run(command: string, input: unknown, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
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

test("local speech wrapper delegates one JSON request to a configured backend", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-local-speech-wrapper-"));
  const backend = join(directory, "whisper-vad-backend.mjs");
  await writeFile(backend, [
    "#!/usr/bin/env node",
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    "const request = JSON.parse(input);",
    'process.stdout.write(JSON.stringify({ words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }], vadSegments: [{ start: 0, end: 1, kind: "speech" }], sourceTimebase: { value: "1", timescale: "1000" }, receivedMediaId: request.media.mediaId }));',
  ].join("\n"));
  await chmod(backend, 0o755);

  const result = await run(join(process.cwd(), "scripts/speech-analyzer-wrapper.mjs"), {
    schemaVersion: 1,
    media: { mediaId: "media-1", source: "/media/interview.wav" },
  }, { ...process.env, FRAMEKIT_SPEECH_BACKEND: backend });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    words: [{ text: "hello", start: 0, end: 1, confidence: 0.98 }],
    vadSegments: [{ start: 0, end: 1, kind: "speech" }],
    sourceTimebase: { value: "1", timescale: "1000" },
    receivedMediaId: "media-1",
  });
});

test("local speech wrapper reports an actionable setup failure", async () => {
  const result = await run(join(process.cwd(), "scripts/speech-analyzer-wrapper.mjs"), {}, {
    ...process.env,
    FRAMEKIT_SPEECH_BACKEND: "",
  });

  assert.equal(result.code, 78);
  assert.match(result.stderr, /SPEECH_ANALYZER_SETUP_REQUIRED/);
});
