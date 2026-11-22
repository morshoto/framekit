export function withBasePath(path: string, basePath = process.env.NEXT_PUBLIC_DOCS_BASE_PATH || ''): string {
  if (!path.startsWith('/') || path.startsWith('//') || !basePath || path === basePath || path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path}`;
}
