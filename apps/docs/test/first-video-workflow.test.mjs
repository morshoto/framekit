import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleEnvironment, runFirstVideo } from '../public/examples/first-video.mjs';

const initial = { id: 'initial', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
const registered = { id: 'registered', sequence: 1, timestamp: '2026-01-01T00:00:01.000Z' };
const edited = { id: 'edited', sequence: 2, timestamp: '2026-01-01T00:00:02.000Z' };
function fakeClient() {
  const calls = [];
  return {
    calls,
    async callTool(request) {
      calls.push(structuredClone(request));
      const payload = {
        'headless.project.create': { timeline: { revision: initial, sequence: { occurrences: [] } } },
        'headless.media.register': { resource: { id: 'media-1' }, project: { timeline: { revision: registered } } },
        'headless.edit.preview': { after: { timeline: { sequence: { occurrences: [{ id: 'sample-shot' }] } } } },
        'headless.edit.execute': { after: { timeline: { revision: edited, sequence: { occurrences: [{ id: 'sample-shot' }] } } } },
        'headless.render': { status: 'passed', outcome: { verification: { status: 'passed' } } },
      }[request.name];
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  };
}

test('declining after preview prevents the edit and render', async () => {
  const client = fakeClient();
  const result = await runFirstVideo({ client, sourcePath: '/source.webm', outputPath: '/output.mp4', confirm: async () => false });
  assert.equal(result.status, 'declined');
  assert.deepEqual(client.calls.map(x => x.name), ['headless.project.create', 'headless.media.register', 'headless.edit.preview']);
});

test('approval executes exactly the previewed operation and renders its returned revision', async () => {
  const client = fakeClient();
  const result = await runFirstVideo({ client, sourcePath: '/source.webm', outputPath: '/output.mp4', confirm: async preview => {
    assert.equal(preview.after.timeline.sequence.occurrences[0].id, 'sample-shot');
    assert.equal(client.calls.some(x => x.name === 'headless.edit.execute'), false);
    return true;
  }});
  assert.equal(result.status, 'passed');
  const preview = client.calls.find(x => x.name === 'headless.edit.preview');
  const execute = client.calls.find(x => x.name === 'headless.edit.execute');
  assert.deepEqual(execute.arguments, preview.arguments);
  assert.deepEqual(client.calls.find(x => x.name === 'headless.render').arguments.expectedRevision, edited);
});

test('does not report success when independent render verification fails', async () => {
  const client = fakeClient();
  const originalCall = client.callTool;
  client.callTool = async request => request.name === 'headless.render'
    ? { content: [{ type: 'text', text: JSON.stringify({ status: 'failed', outcome: { verification: { status: 'failed' } } }) }] }
    : originalCall.call(client, request);
  await assert.rejects(runFirstVideo({ client, sourcePath: '/source.webm', outputPath: '/output.mp4', confirm: async () => true }), /verification did not pass/i);
});

test('rejects a changed sample before creating a project directory', async () => {
  const { mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'framekit-first-video-test-'));
  try {
    await writeFile(join(dir, 'sample.webm'), 'not the sample');
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../public/examples/first-video.mjs', import.meta.url)), 'sample.webm'], { cwd: dir }), /Sample SHA-256 mismatch/);
    assert.deepEqual(await readdir(dir), ['sample.webm']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('isolates the headless example from inherited Final Cut settings', () => {
  const original = { FRAMEKIT_FCPXML_PATH: '/existing.fcpxml', FRAMEKIT_FINAL_CUT_SOCKET: '/existing.sock', FRAMEKIT_AUTO_CONNECT: '1', PATH: '/bin' };
  const environment = exampleEnvironment(original, '/new-state');
  assert.equal(environment.FRAMEKIT_STATE_DIR, '/new-state');
  assert.equal(environment.FRAMEKIT_AUTO_CONNECT, '0');
  assert.equal(environment.FRAMEKIT_EDITOR, 'final-cut-live');
  assert.equal(environment.FRAMEKIT_FINAL_CUT_HEADLESS, '1');
  assert.equal(environment.FRAMEKIT_FINAL_CUT_NATIVE_WRITES, '0');
  assert.equal(environment.FRAMEKIT_FCPXML_PATH, undefined);
  assert.equal(environment.FRAMEKIT_FINAL_CUT_SOCKET, undefined);
  assert.equal(original.FRAMEKIT_AUTO_CONNECT, '1');
});
