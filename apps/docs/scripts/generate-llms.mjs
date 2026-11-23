import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const site = 'https://morshoto.github.io/framekit';

export async function generateLlms(documents, contentDir, outputDir) {
  const pages = documents.filter(doc => doc.locale === 'en' && doc.status === 'ready');
  const index = ['# Framekit', '', '> Framekit is a local-first video editing runtime and MCP server.', '', '## Documentation', ''];
  const full = ['# Framekit documentation', ''];
  for (const page of pages) {
    const url = `${site}/en/docs/${page.slug}/`;
    index.push(`- [${page.title}](${url}): ${page.description}`);
    const source = await readFile(join(contentDir, 'en', `${page.slug}.mdx`), 'utf8');
    full.push(`# ${page.title}`, '', `Source: ${url}`, '', source.trimEnd(), '');
  }
  await Promise.all([
    writeFile(join(outputDir, 'llms.txt'), `${index.join('\n')}\n`),
    writeFile(join(outputDir, 'llms-full.txt'), `${full.join('\n')}\n`),
  ]);
}
