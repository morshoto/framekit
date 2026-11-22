import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
test('command harnesses load historical corpora independently of the caller directory', async () => {
  const modules = ['scripts/release/gate/native-editing.ts', 'scripts/release/gate/runner.ts',
    'scripts/release/acceptance/v0112-acceptance.ts', 'scripts/benchmarks/filler-removal/benchmark.ts'];
  const code = `const [manifest, gate, acceptance, benchmark] = await Promise.all(${JSON.stringify(modules.map(file => pathToFileURL(resolve(file)).href))}.map(file => import(file)));
    const report = await gate.runReleaseGate({ generatedAt: '2026-08-30T00:00:00.000Z' });
    console.log(JSON.stringify({ manifest: manifest.loadNativeEditingManifest().releaseVersion,
      gate: gate.loadReleaseGateCorpus().runtimeContract, acceptance: acceptance.loadV0112AcceptanceCorpus().releaseVersion,
      corpus: benchmark.loadFillerRemovalCorpus().corpusVersion, deterministic: report.deterministic.passed, headed: report.evidenceTiers['headed-native'].status }));`;
  const { stdout } = await exec(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', code], {
    cwd: tmpdir(), env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.json') },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.manifest, '0.1.6');
  assert.equal(result.gate, 'v0.1.6');
  assert.equal(result.acceptance, '0.1.12');
  assert.ok(result.corpus);
  assert.equal(result.deterministic, true);
  assert.equal(result.headed, 'unrun');
});
