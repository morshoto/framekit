import type { NextConfig } from 'next';
import createMDX from '@next/mdx';
import { resolve } from 'node:path';

const basePath = process.env.DOCS_BASE_PATH ?? '';
const config: NextConfig = {
  agentRules: false,
  experimental: { globalNotFound: true },
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  env: { NEXT_PUBLIC_DOCS_BASE_PATH: basePath },
};
export default createMDX({ options: { remarkPlugins: ['remark-gfm', resolve(process.cwd(), 'remark-code-metadata.mjs')], rehypePlugins: ['rehype-slug'] } })(config);
