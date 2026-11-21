import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Literal message prefixes are discoverable without evaluating application code.
// Dynamic codes and codes passed through other APIs still need manual review.
export function extractDefinedCodes(source) {
  return new Set([...source.matchAll(/\b(?:new\s+Error|\w*[Ee]rror)\s*\(\s*["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?::|["'`])/g)].map(match => match[1]));
}
export function extractIndexedCodes(page) {
  return new Set([...page.matchAll(/^## ([a-z0-9-]+)\s*\n\s*`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/gm)].filter(match => match[1] === match[2].toLowerCase().replaceAll('_', '-')).map(match => match[2]));
}
export function findMissingCodes(sources, page) {
  const indexed = extractIndexedCodes(page);
  return [...new Set(sources.flatMap(source => [...extractDefinedCodes(source)]))].filter(code => !indexed.has(code)).sort();
}
async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []))).flat();
}
async function main() {
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const roots = ['packages', 'apps/mcp-server/src', 'adapters/final-cut/typescript/src'];
  const files = (await Promise.all(roots.map(dir => sourceFiles(join(root, dir))))).flat().filter(file => !file.includes('/node_modules/') && !file.includes('/dist/'));
  const sources = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const page = await readFile(join(root, 'apps/docs/content/docs/en/error-reference.mdx'), 'utf8');
  const missing = findMissingCodes(sources, page);
  console.log(`Literal error codes without an index entry (${missing.length}):\n${missing.join('\n')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
