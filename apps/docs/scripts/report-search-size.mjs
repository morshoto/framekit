import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
async function size(dir) { let bytes = 0; for (const item of await readdir(dir, { withFileTypes: true })) { const path = join(dir, item.name); bytes += item.isDirectory() ? await size(path) : (await stat(path)).size; } return bytes; }
const bytes = await size('out/pagefind');
if (!bytes) throw new Error('Pagefind produced an empty index');
console.log(`Pagefind index size: ${bytes} bytes`);
