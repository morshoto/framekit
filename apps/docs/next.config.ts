import type { NextConfig } from 'next';
import createMDX from '@next/mdx';

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
export default createMDX({ options: { remarkPlugins: ['remark-gfm'], rehypePlugins: ['rehype-slug'] } })(config);
