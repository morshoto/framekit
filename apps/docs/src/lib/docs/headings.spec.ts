import { expect, it } from 'vitest';
import { extractHeadings } from './headings';
it('derives stable heading ids, including duplicates, from Markdown', () => {
  expect(extractHeadings('## Hello world\n\n### Hello *world*\n\n```md\n## Hidden\n```')).toEqual([{ id: 'hello-world', title: 'Hello world' }, { id: 'hello-world-1', title: 'Hello world' }]);
});
