import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { toString } from 'mdast-util-to-string';
import GithubSlugger from 'github-slugger';
import type { Heading } from '../navigation';
export function extractHeadings(markdown: string): Heading[] {
  const tree = unified().use(remarkParse).use(remarkMdx).parse(markdown);
  const slugger = new GithubSlugger();
  return tree.children.flatMap(node => node.type === 'heading' && node.depth >= 2 && node.depth <= 4 ? [{ id: slugger.slug(toString(node)), title: toString(node) }] : []);
}
