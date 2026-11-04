import type { NextConfig } from 'next';

const basePath = process.env.DOCS_BASE_PATH ?? '';
const config: NextConfig = {
  agentRules: false,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
};
export default config;
