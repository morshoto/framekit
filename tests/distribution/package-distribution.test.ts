import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// One actual prepack/build and immutable archive serve both metadata inspection
// and independent clean local/global installs. Consumers never reuse installed state.
let artifact: Promise<{ directory: string; archive: string; files: Array<{ path: string; mode: number }> }> | undefined;
function packageArtifact() {
  return artifact ??= (async () => {
    const directory = await mkdtemp(join(os.tmpdir(), 'framekit-package-artifact-'));
    try {
      const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: repository });
      const [packed] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string; mode: number }> }>;
      assert.ok(packed);
      const archive = join(directory, packed.filename);
      await chmod(archive, 0o444);
      return { directory, archive, files: packed.files };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  })();
}
after(async () => { const built = await artifact?.catch(() => undefined); if (built) await rm(built.directory, { recursive: true, force: true }); });

test("development checkout launcher prefers source over a stale dist package", async t => {
  const root = await mkdtemp(join(os.tmpdir(), 'framekit-launcher-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'apps/cli/src'), { recursive: true });
  await mkdir(join(root, 'dist-package/apps/cli/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
  const launcher = join(root, 'bin/framekit.mjs');
  await copyFile(join(repository, 'bin/framekit.mjs'), launcher);
  const source = join(root, 'apps/cli/src/main.ts');
  const packaged = join(root, 'dist-package/apps/cli/src/main.js');
  await writeFile(source, `console.log('SOURCE:' + JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.CLI_EXIT ?? 0);`);
  await writeFile(packaged, `console.log('PACKAGED:' + JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.CLI_EXIT ?? 0);`);
  const run = () => exec(process.execPath, [launcher, 'help', 'argument with spaces'], { cwd: root, env: { ...process.env, CLI_EXIT: '0' } });
  const assertSource = async () => assert.equal((await run()).stdout.trim(), 'SOURCE:["help","argument with spaces"]');
  await assertSource();
  await assert.rejects(exec(process.execPath, [launcher], { cwd: root, env: { ...process.env, CLI_EXIT: '23' } }), (error: any) => error.code === 23);
  // Kill a precedence mutant using the same observable assertion.
  const correct = await readFile(launcher, 'utf8');
  await writeFile(launcher, `import { spawn } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    // Intentional regression: always select stale packaged output.
    const stale = fileURLToPath(new URL('../dist-package/apps/cli/src/main.js', import.meta.url));
    const child = spawn(process.execPath, [stale, ...process.argv.slice(2)], { stdio: 'inherit' });
    child.once('exit', code => { process.exitCode = code ?? 1; });`);
  await assert.rejects(assertSource(), /PACKAGED/);
  await writeFile(launcher, correct);
  await rm(source);
  assert.equal((await run()).stdout.trim(), 'PACKAGED:["help","argument with spaces"]');
  await assert.rejects(exec(process.execPath, [launcher], { cwd: root, env: { ...process.env, CLI_EXIT: '24' } }), (error: any) => error.code === 24);
  await rm(packaged);
  await assert.rejects(run(), (error: any) => error.code !== 0 && /ERR_MODULE_NOT_FOUND/.test(error.stderr));
});

test("published package contains the runnable Framekit CLI and MCP sources", async () => {
  const manifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.name, "@morshoto/framekit");
  assert.equal(manifest.private, false);
  assert.equal(manifest.bin?.framekit, "./bin/framekit.mjs");
  assert.deepEqual(manifest.exports, {
    "./bin/framekit.mjs": "./bin/framekit.mjs",
    "./fcpxml": {
      types: "./dist-package/adapters/final-cut/typescript/src/documents.d.ts",
      import: "./dist-package/adapters/final-cut/typescript/src/documents.js",
    },
  });
  assert.equal(manifest.dependencies?.tsx, undefined, "published CLI must not depend on the development loader");
  assert.deepEqual(manifest.files, ["bin", "dist-package"]);
  assert.equal(manifest.scripts?.prepack, "pnpm run build:package");
  assert.match(manifest.scripts?.["build:package"] ?? "", /write-package-build-identity\.ts/);

  const packed = await packageArtifact();
  const paths = packed.files.map((file) => file.path);
  for (const requiredPath of [
    "bin/framekit.mjs",
    "dist-package/apps/cli/src/main.js",
    "dist-package/apps/mcp-server/src/main.js",
    "dist-package/apps/mcp-server/src/build-identity.json",
    "dist-package/apps/mcp-server/runtime/speech-analyzer-wrapper.mjs",
    "dist-package/apps/mcp-server/runtime/whisper-speech-backend.py",
    "dist-package/apps/mcp-server/runtime/ffmpeg-audio-backend.py",
    "dist-package/packages/runtime/src/index.js",
    "dist-package/adapters/final-cut/typescript/src/index.js",
    "dist-package/adapters/final-cut/typescript/src/documents.js",
    "dist-package/adapters/final-cut/typescript/src/documents.d.ts",
  ]) {
    assert.ok(paths.includes(requiredPath), `${requiredPath} must be included in the npm package`);
  }
  for (const executable of [
    "dist-package/apps/mcp-server/runtime/speech-analyzer-wrapper.mjs",
    "dist-package/apps/mcp-server/runtime/whisper-speech-backend.py",
    "dist-package/apps/mcp-server/runtime/ffmpeg-audio-backend.py",
  ]) {
    const packedFile = packed.files.find(({ path }) => path === executable);
    assert.ok(packedFile && (packedFile.mode & 0o111) !== 0, `${executable} must remain executable in the package`);
  }
  assert.equal(paths.some((path) => path.startsWith("tests/")), false);
  assert.equal(paths.some((path) => path.startsWith("adapters/final-cut/swift-bridge/")), false);

  const identity = JSON.parse(await readFile(
    resolve(repository, "dist-package/apps/mcp-server/src/build-identity.json"),
    "utf8",
  )) as { version?: string; commit?: string };
  assert.equal(identity.version, manifest.version);
  assert.match(identity.commit ?? "", /^[0-9a-f]{40}$/);
});

test("clean package analyzes registered headless media with configured providers", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-package-analysis-"));
  let client: Client | undefined; let transport: StdioClientTransport | undefined;
  try {
    const { archive } = await packageArtifact();
    await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory });
    const runtime = join(directory, "node_modules", "@morshoto", "framekit", "dist-package", "apps", "mcp-server", "runtime");
    const executable = join(directory, "node_modules", ".bin", "framekit");
    const source = join(directory, "tone.wav");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:a", "pcm_s16le", source]);
    const fakeSpeech = join(directory, "fake-speech.mjs");
    await writeFile(fakeSpeech, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({words:[{text:"fixture",start:0.5,end:1,confidence:0.9}],vadUnavailableReason:"FIXTURE_NO_VAD"}));\n');
    await chmod(fakeSpeech, 0o755);
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("FRAMEKIT_"))),
      FRAMEKIT_STATE_DIR: join(directory, "state"), FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0", FRAMEKIT_AUTO_CONNECT: "0",
      FRAMEKIT_SPEECH_ANALYZER: join(runtime, "speech-analyzer-wrapper.mjs"), FRAMEKIT_SPEECH_BACKEND: fakeSpeech,
      FRAMEKIT_SPEECH_ANALYZER_VERSION: "fixture@1", FRAMEKIT_AUDIO_ANALYZER: join(runtime, "ffmpeg-audio-backend.py"), FRAMEKIT_AUDIO_ANALYZER_VERSION: "ffmpeg-fixture@1" } as Record<string, string>;
    transport = new StdioClientTransport({ command: executable, args: ["mcp", "--editor", "final-cut-live", "--headless"], cwd: directory, env: environment, stderr: "pipe" });
    client = new Client({ name: "package-analysis-smoke", version: "1" }); await client.connect(transport);
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const timeline = { schemaVersion: 1, project: { id: "package-analysis", name: "Package analysis" },
      sequence: { id: "sequence", name: "Sequence", durationTime: { value: "0", timescale: "1" }, frameDuration: { value: "1", timescale: "30" }, occurrences: [], storyElements: [], markers: [], captions: [] },
      resources: [], revision: { id: "initial", sequence: 0, timestamp: "2026-01-01T00:00:00.000Z" } };
    const created = await invoke("headless.project.create", { timeline });
    const projectId = created.timeline.project.id;
    const registered = await invoke("headless.media.register", { projectId, sourcePath: source, expectedRevision: created.timeline.revision });
    const mediaId = registered.resource.id;
    const speech = await invoke("speech.analyze", { projectId, mediaId });
    assert.equal(speech.words[0].text, "fixture");
    assert.equal(speech.sourceIdentity.sourceDigest, registered.resource.sourceDigest);
    assert.equal(speech.provider.version, "fixture@1");
    assert.equal(speech.capability, "transcription-only");
    assert.equal(speech.vadUnavailableReason, "FIXTURE_NO_VAD");
    const audio = await invoke("audio.analyze", { projectId, mediaId });
    assert.equal(audio.sourceIdentity.sourceDigest, registered.resource.sourceDigest);
    assert.equal(audio.provider.version, "ffmpeg-fixture@1");
    assert.ok(audio.integratedLufs < -15 && audio.integratedLufs > -30);
    const combined = await invoke("media.understand", { projectId, mediaId });
    assert.equal(combined.speech.words[0].text, "fixture");
    assert.equal(combined.audio.signalScope, "source");
    const unregisteredTimeline = structuredClone(created.timeline);
    unregisteredTimeline.project.id = "unregistered-analysis";
    unregisteredTimeline.sequence.id = "unregistered-sequence";
    const unregistered = structuredClone(registered.resource); delete unregistered.sourceKind;
    unregisteredTimeline.resources = [unregistered];
    await invoke("headless.project.create", { timeline: unregisteredTimeline });
    for (const name of ["speech.analyze", "audio.analyze", "media.understand"]) {
      const result = await client.callTool({ name, arguments: { projectId: unregisteredTimeline.project.id, mediaId } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /MEDIA_NOT_REGISTERED/);
    }
    const original = await readFile(source);
    await writeFile(source, "changed");
    for (const name of ["speech.analyze", "audio.analyze", "media.understand"]) {
      const result = await client.callTool({ name, arguments: { projectId, mediaId } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /MEDIA_CHANGED/);
    }
    await writeFile(source, original);
    await rm(join(directory, "state", "semantic-media-index.json"), { force: true });
    await writeFile(fakeSpeech, '#!/usr/bin/env node\nlet input=""; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); await (await import("node:fs/promises")).appendFile(request.media.source,"changed"); process.stdout.write(JSON.stringify({words:[]}));\n');
    const changedDuringAnalysis = await client.callTool({ name: "media.understand", arguments: { projectId, mediaId } });
    assert.equal(changedDuringAnalysis.isError, true);
    assert.match(JSON.stringify(changedDuringAnalysis.content), /MEDIA_CHANGED|ANALYZER_SOURCE_CHANGED/);
    await assert.rejects(readFile(join(directory, "state", "semantic-media-index.json")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await writeFile(source, original);
    await client.close(); await transport.close();
    transport = new StdioClientTransport({ command: executable, args: ["mcp", "--editor", "final-cut-live", "--headless"], cwd: directory,
      env: { ...environment, FRAMEKIT_SPEECH_BACKEND: "" }, stderr: "pipe" });
    client = new Client({ name: "package-analysis-missing-setup", version: "1" }); await client.connect(transport);
    const unavailable = await client.callTool({ name: "speech.analyze", arguments: { projectId, mediaId } });
    assert.equal(unavailable.isError, true);
    const unavailableMessage = JSON.parse((unavailable.content as Array<{ text: string }>)[0]!.text).message;
    assert.match(unavailableMessage, /SPEECH_ANALYZER_SETUP_REQUIRED/);
    assert.doesNotMatch(unavailableMessage, /Traceback|\n\s+at /);
    await client.close(); await transport.close();
    const fakePython = join(directory, "fake-python"); await mkdir(fakePython);
    await writeFile(join(fakePython, "mlx_whisper.py"), "# Importable stub; no inference is invoked.\n");
    transport = new StdioClientTransport({ command: executable, args: ["mcp", "--editor", "final-cut-live", "--headless"], cwd: directory,
      env: { ...environment, FRAMEKIT_SPEECH_BACKEND: join(runtime, "whisper-speech-backend.py"), FRAMEKIT_WHISPER_BACKEND: "mlx-whisper",
        FRAMEKIT_WHISPER_MODEL: "", FRAMEKIT_SPEECH_REQUIRE_VAD: "0", FRAMEKIT_SILERO_VAD_MODEL: "", PYTHONPATH: fakePython }, stderr: "pipe" });
    client = new Client({ name: "package-analysis-missing-model", version: "1" }); await client.connect(transport);
    const noModel = await client.callTool({ name: "speech.analyze", arguments: { projectId, mediaId } });
    assert.equal(noModel.isError, true);
    const noModelMessage = JSON.parse((noModel.content as Array<{ text: string }>)[0]!.text).message;
    assert.match(noModelMessage, /WHISPER_SETUP_REQUIRED.*FRAMEKIT_WHISPER_MODEL/);
    assert.doesNotMatch(noModelMessage, /Traceback|\n\s+at /);
  } finally { await client?.close(); await transport?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("clean local and global installs expose the supported CLI and MCP entrypoints", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "framekit-package-smoke-"));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    const { archive } = await packageArtifact();
    await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory });
    const installedManifest = JSON.parse(
      await readFile(join(directory, "node_modules", "@morshoto", "framekit", "package.json"), "utf8"),
    ) as { version?: string };

    const executable = join(directory, "node_modules", ".bin", "framekit");
    const speechAnalyzer = join(
      directory,
      "node_modules",
      "@morshoto",
      "framekit",
      "dist-package",
      "apps",
      "mcp-server",
      "runtime",
      "speech-analyzer-wrapper.mjs",
    );
    const help = await exec(executable, ["help"], { cwd: directory });
    assert.match(help.stdout, /framekit mcp --editor final-cut-live \[--headless\]/);
    await assert.rejects(
      exec(speechAnalyzer, [], { cwd: directory, env: { ...process.env, FRAMEKIT_SPEECH_BACKEND: "" } }),
      (error: unknown) => error instanceof Error
        && (error as Error & { code?: number }).code === 78
        && /SPEECH_ANALYZER_SETUP_REQUIRED/.test((error as Error & { stderr?: string }).stderr ?? ""),
    );

    const globalPrefix = join(directory, "global");
    await exec("npm", ["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory });
    const globalExecutable = join(globalPrefix, "bin", process.platform === "win32" ? "framekit.cmd" : "framekit");
    const globalHelp = await exec(globalExecutable, ["help"], { cwd: directory });
    assert.match(globalHelp.stdout, /framekit mcp --editor final-cut-live \[--headless\]/);

    await exec(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('@morshoto/framekit/bin/framekit.mjs')",
    ], { cwd: directory });

    const documentRoundTrip = await exec(process.execPath, [
      "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { writeFile } from "node:fs/promises";
        import { FcpxmlDocumentAdapter, compileTimelineIrToFcpxml } from "@morshoto/framekit/fcpxml";
        const timeline = {
          schemaVersion: 1,
          project: { id: "document-project", name: "Document" },
          sequence: {
            id: "document-sequence", name: "Main",
            durationTime: { value: "25", timescale: "25" },
            frameDuration: { value: "1", timescale: "25" },
            occurrences: [{
              id: "clip", name: "Clip", mediaId: "source", role: "video", track: 0,
              startTime: { value: "0", timescale: "25" },
              durationTime: { value: "25", timescale: "25" },
              sourceStartTime: { value: "10", timescale: "25" },
            }],
            storyElements: [], markers: [], captions: [],
          },
          resources: [{ id: "source", name: "Source", mediaKind: "video", source: "/media/fixture.mov",
            metadata: { durationTime: { value: "100", timescale: "25" },
              streams: [{ kind: "video", width: 1280, height: 720, frameRate: { value: "25", timescale: "1" } }] } }],
          revision: { id: "revision", sequence: 1, timestamp: "2026-11-15T00:00:00.000Z" },
        };
        const result = compileTimelineIrToFcpxml(timeline, { target: {
          provider: "final-cut", libraryUid: "library", eventUid: "event",
          projectUid: "project", sequenceUid: "sequence",
        } });
        await writeFile("roundtrip.fcpxml", result.xml);
        const snapshot = await new FcpxmlDocumentAdapter("roundtrip.fcpxml").readProject();
        assert.deepEqual(snapshot.timeline.clips[0].durationTime, { value: "1", timescale: "1" });
        assert.deepEqual(snapshot.timeline.clips[0].sourceStartTime, { value: "2", timescale: "5" });
        assert.equal(result.provenance.revision.id, "revision");
        assert.equal(snapshot.timeline.clips.length, 1);
        console.log("document round trip passed");
      `,
    ], { cwd: directory, env: { ...process.env, FRAMEKIT_AUTO_CONNECT: "0", FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0" } });
    assert.match(documentRoundTrip.stdout, /document round trip passed/);

    const privateSubpath = await exec(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('@morshoto/framekit/dist-package/apps/cli/src/main.js')",
    ], { cwd: directory }).then(
      () => undefined,
      (error: unknown) => error as { stderr?: string; code?: number },
    );
    assert.ok(privateSubpath);
    assert.match(privateSubpath.stderr ?? "", /ERR_PACKAGE_PATH_NOT_EXPORTED/);

    transport = new StdioClientTransport({
      command: executable,
      args: ["mcp", "--editor", "final-cut-live", "--headless"],
      cwd: directory,
      env: { ...process.env, FRAMEKIT_STATE_DIR: join(directory, "framekit-state"), FRAMEKIT_FINAL_CUT_NATIVE_WRITES: "0" },
      stderr: "pipe",
    });
    client = new Client({ name: "framekit-package-smoke", version: "0.1.0" });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, installedManifest.version);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "connection.status"));
    assert.ok(tools.tools.some((tool) => tool.name === "editor.live.inspect"));
  } finally {
    await client?.close();
    await transport?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
