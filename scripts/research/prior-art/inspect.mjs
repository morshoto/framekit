// Static source anchor inspection only; no app or external code is executed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const splice = '3bb929a4681c0225db19a51b2fb9931fea2c2522';
const commandPost = '54750e571a427340775028a75e10d17ae0c58f34';
export function inspectSources(sources) {
  for (const key of ['patch', 'server', 'contents', 'version']) {
    if (typeof sources?.[key] !== 'string') throw new Error('invalid source');
  }
  const hashes = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]));
  return {
    hashes,
    anchors: {
      injection: sources.patch.includes('LC_LOAD_DYLIB'),
      signing: sources.patch.includes('codesign --force'),
      undoManager: sources.server.includes('@selector(undoManager)'),
      selectedFirst: sources.server.includes('selectedClip = items[0]'),
      originalMediaUrl: sources.server.includes('NSSelectorFromString(@"originalMediaURL")'),
      currentRepresentation: sources.server.includes('NSSelectorFromString(@"currentRep")'),
      accessibility: sources.contents.includes('hs.axuielement') && sources.contents.includes('AXUIElementDestroyed'),
      versionFloor: sources.version.includes('fcp.EARLIEST_SUPPORTED_VERSION = semver("10.4.4")'),
    },
    runtimeVerified: false,
    recoveryVerified: false,
  };
}

function source(repo, commit, path) {
  return execFileSync('git', ['-C', repo, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) throw new Error('usage: node inspect.mjs <splicekit-repo> <commandpost-repo>');
  const [a, b] = process.argv.slice(2);
  const report = inspectSources({
    patch: source(a, splice, 'patcher/patch_fcp.sh'),
    server: source(a, splice, 'Sources/SpliceKitServer.m'),
    contents: source(b, commandPost, 'src/extensions/cp/apple/finalcutpro/timeline/Contents.lua'),
    version: source(b, commandPost, 'src/extensions/cp/apple/finalcutpro/init.lua'),
  });
  console.log(JSON.stringify({ commits: { splice, commandPost }, ...report }, null, 2));
}
