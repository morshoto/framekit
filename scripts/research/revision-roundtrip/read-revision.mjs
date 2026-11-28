// Test-owned child process only; no editor or external state is accessed.
import { readFile } from 'node:fs/promises';
import { readRevision } from './revision-store.mjs';
const [record, artifact, target] = process.argv.slice(2);
console.log(JSON.stringify(await readRevision(record, await readFile(artifact), target)));
