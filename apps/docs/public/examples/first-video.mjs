import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sampleDigest = 'e96efec0c3bf57836b54cbead8d195564ee4e1303a320b343b4fda6642ce5904';

export function exampleEnvironment(base, stateDir) {
  const environment = { ...base, FRAMEKIT_STATE_DIR: stateDir, FRAMEKIT_EDITOR: 'final-cut-live', FRAMEKIT_FINAL_CUT_HEADLESS: '1', FRAMEKIT_FINAL_CUT_NATIVE_WRITES: '0', FRAMEKIT_AUTO_CONNECT: '0' };
  delete environment.FRAMEKIT_FCPXML_PATH;
  delete environment.FRAMEKIT_FINAL_CUT_SOCKET;
  return environment;
}

export async function requireServer(serverPath) {
  try { await access(serverPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Framekit server not found; install @morshoto/framekit@0.2.6 in this directory.');
    throw error;
  }
}

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find(item => item.type === 'text')?.text;
  if (response.isError || typeof text !== 'string') throw new Error(`${name}: ${text ?? 'no result'}`);
  return JSON.parse(text);
}

export async function runFirstVideo({ client, sourcePath, outputPath, confirm, checkpoint = async () => {} }) {
  const projectId = `first-video-${randomUUID()}`;
  const sequenceId = 'first-video-sequence';
  const timeline = {
    schemaVersion: 1,
    project: { id: projectId, name: 'First Video' },
    sequence: { id: sequenceId, name: 'First Video', durationTime: { value: '0', timescale: '1' }, frameDuration: { value: '1', timescale: '12' }, occurrences: [], storyElements: [], markers: [], captions: [], titles: [], transitions: [] },
    resources: [],
    revision: { id: 'initial', sequence: 0, timestamp: new Date().toISOString() },
  };
  const created = await call(client, 'headless.project.create', { timeline });
  const media = await call(client, 'headless.media.register', { projectId, sourcePath, expectedRevision: created.timeline.revision });
  const args = {
    projectId, sequenceId, expectedRevision: media.project.timeline.revision,
    operations: [{ type: 'insert-occurrence', placement: 'append', occurrence: { id: 'sample-shot', name: 'CC0 sample', startTime: { value: '0', timescale: '1' }, sourceStartTime: { value: '0', timescale: '1' }, durationTime: { value: '2', timescale: '1' }, track: 0, role: 'video', mediaId: media.resource.id } }],
  };
  const preview = await call(client, 'headless.edit.preview', args);
  await checkpoint({ status: 'previewed', projectId, outputPath, before: created.timeline.sequence, preview });
  if (!await confirm(preview)) return { status: 'declined', projectId, before: created.timeline.sequence, preview };
  const executed = await call(client, 'headless.edit.execute', args);
  await checkpoint({ status: 'edited', projectId, outputPath, before: created.timeline.sequence, preview, after: executed.after.timeline.sequence, revision: executed.after.timeline.revision });
  const render = await call(client, 'headless.render', { projectId, sequenceId, expectedRevision: executed.after.timeline.revision, parameters: { outputPath, format: 'mp4', width: 400, height: 290, frameRate: { value: '12', timescale: '1' } } });
  if (render.status !== 'passed' || render.outcome?.verification?.status !== 'passed') throw new Error('Render or verification did not pass; inspect the saved project and output before retrying.');
  return { status: 'passed', projectId, outputPath, before: created.timeline.sequence, preview, after: executed.after.timeline.sequence, revision: executed.after.timeline.revision, render };
}

async function writeCheckpoint(outputDir, evidence) {
  const temporary = join(outputDir, `evidence-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(evidence, null, 2));
    await rename(temporary, join(outputDir, 'evidence.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node first-video.mjs sample.webm');
  const sourcePath = resolve(process.argv[2]);
  const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  if (digest !== sampleDigest) throw new Error('Sample SHA-256 mismatch; stop and check the download.');
  const server = resolve('node_modules/@morshoto/framekit/dist-package/apps/mcp-server/src/main.js');
  await requireServer(server);
  const outputDir = await mkdtemp(join(process.cwd(), 'framekit-first-video-'));
  const stateDir = join(outputDir, 'state');
  await mkdir(stateDir);
  const outputPath = join(outputDir, 'first-video.mp4');
  console.log(`Example files: ${outputDir}`);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: exampleEnvironment(process.env, stateDir), stderr: 'pipe' });
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  const client = new Client({ name: 'framekit-first-video', version: '1.0.0' });
  try {
    await client.connect(transport);
    const evidence = await runFirstVideo({ client, sourcePath, outputPath, checkpoint: async value => {
      if (value.status === 'edited') console.log('Committed project and revision:', value.projectId, JSON.stringify(value.revision));
      await writeCheckpoint(outputDir, value);
    }, confirm: async preview => {
      console.log('Proposed timeline:', JSON.stringify(preview.after.timeline.sequence, null, 2));
      console.log(`Output: ${outputPath}`);
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await input.question('Execute this preview and render? Type yes to continue: ')).trim() === 'yes'; }
      finally { input.close(); }
    }});
    await writeCheckpoint(outputDir, evidence);
    console.log(`Result: ${evidence.status}; files: ${outputDir}`);
  } finally {
    await client.close();
    await transport.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
