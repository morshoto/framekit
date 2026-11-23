import React from 'react';
import { ImageResponse } from 'next/og';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { documents } from '../src/lib/docs/source';

async function main() {
const require = createRequire(import.meta.url);
const fontDir = dirname(require.resolve('@fontsource/noto-sans-jp/files/noto-sans-jp-latin-700-normal.woff'));
const fontFiles = (await readdir(fontDir)).filter(name => name.endsWith('-700-normal.woff'));
const fonts = await Promise.all(fontFiles.map(async (name, index) => ({ name: `Noto${index}`, data: await readFile(`${fontDir}/${name}`), weight: 700 as const, style: 'normal' as const })));
const fontFamily = fonts.map(font => font.name).join(', ');
const cards = [
  ...documents.map(doc => ({ title: doc.title, path: `out/social/${doc.locale}/docs/${doc.slug}.png` })),
  { title: 'Documentation', path: 'out/social/en/overview.png' },
  { title: 'ドキュメント', path: 'out/social/ja/overview.png' },
];
for (const card of cards) {
  const image = new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#f7f3e8', color: '#192d2d', padding: '72px 80px', fontFamily }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, color: '#12675f', fontSize: 30 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 62, height: 62, borderRadius: 15, background: '#12675f', color: '#f7f3e8', fontSize: 42 }}>F</div>FRAMEKIT DOCS</div>
      <div style={{ display: 'flex', fontSize: 64, lineHeight: 1.25, fontWeight: 700 }}>{card.title}</div>
      <div style={{ display: 'flex', fontSize: 26, color: '#12675f' }}>FRAMEKIT / DOCUMENTATION</div>
    </div>,
    { width: 1200, height: 630, fonts },
  );
  await mkdir(dirname(card.path), { recursive: true });
  await writeFile(card.path, Buffer.from(await image.arrayBuffer()));
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
