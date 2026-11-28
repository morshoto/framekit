// Reproduce the synthetic fixture only. The output must be a new path.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRevisionB } from './xml-handoff.mjs';
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('supply a new output path');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = await readFile(new URL('./independent-edited.fcpxml', import.meta.url));
const external = await readFile(new URL('./external-cut.fcpxml', import.meta.url));
const result = createRevisionB({ baseline, external, baselineDigest: hash(baseline), externalDigest: hash(external),
  projectUid: 'project-framekit-8b68711b3f', sourceDigests: { a: 'a'.repeat(64), m: 'b'.repeat(64) },
  targetIndex: 0, name: 'Approved name' });
await writeFile(output, result.xml, { flag: 'wx' });
console.log(JSON.stringify({ baseline: hash(baseline), external: hash(external), revisionB: result.digest }));
