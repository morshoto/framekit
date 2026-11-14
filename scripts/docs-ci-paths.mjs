import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function affectsDocs(path) {
  return path.startsWith('apps/docs/') || path.startsWith('.github/workflows/') || path.startsWith('scripts/docs-ci-paths.') || ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc', 'tsconfig.json'].includes(path);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!base || !head) throw new Error('Missing base or head');
    const mergeBase = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
    const paths = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', mergeBase, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
    console.log(paths.some(affectsDocs) ? 'true' : 'false');
  } catch (error) {
    console.error('Docs change detection failed; running docs checks:', error.message);
    console.log('true');
  }
}
