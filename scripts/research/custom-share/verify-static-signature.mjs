// Read-only static code validation. It neither launches an app nor observes an event.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function verifyStaticSignature(path) {
  if (typeof path !== 'string' || !path) throw new Error('invalid app path');
  const requirement = (await readFile(new URL('./finalcut-10.7.1-requirement.txt', import.meta.url), 'utf8')).trim();
  if (!requirement) throw new Error('missing requirement');
  await run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, resolve(path)]);
  return { matchesPinnedRequirement: true };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('usage: node verify-static-signature.mjs <app-path>');
  console.log(JSON.stringify(await verifyStaticSignature(process.argv[2])));
}
