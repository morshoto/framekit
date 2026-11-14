import { expect, it } from 'vitest';
import { remarkCodeMetadata } from '../../../remark-code-metadata.mjs';

it('preserves a filename from fenced code metadata', () => {
  const code = { type: 'code', lang: 'json', meta: 'title="config.json"', value: '{}' };
  remarkCodeMetadata()({ type: 'root', children: [code] });
  expect(code).toMatchObject({ data: { hProperties: { title: 'config.json' } } });
});

it('leaves code without a filename unchanged', () => {
  const code = { type: 'code', lang: 'json', meta: null, value: '{}' };
  remarkCodeMetadata()({ type: 'root', children: [code] });
  expect(code).not.toHaveProperty('data');
});
