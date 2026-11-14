import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function generate(directory: string): Promise<void> {
  await exec(process.execPath, [fileURLToPath(new URL('../../../scripts/generate-headless-render-fixtures.mjs', import.meta.url)), directory], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: process.env,
  });
}

// Each worker owns one immutable source pool. Consumers receive ordinary copies
// so source-mutation/race tests keep independent inputs, paths and output state.
export function createMediaFixturePool(build: (directory: string) => Promise<void> = generate) {
  let source: Promise<{ directory: string; files: string[] }> | undefined;
  let closed = false;
  let disposal: Promise<void> | undefined;
  const copies = new Set<Promise<void>>();
  async function acquire() {
    return source ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'framekit-immutable-media-'));
      try {
        await build(directory);
        const entries = await readdir(directory, { withFileTypes: true });
        if (!entries.length || entries.some(entry => !entry.isFile())) throw Error('MEDIA_FIXTURE_INVALID: expected regular fixture files');
        const files = entries.map(entry => entry.name).sort();
        await Promise.all(files.map(file => chmod(join(directory, file), 0o444)));
        return { directory, files };
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    })();
  }
  return {
    copyTo(destination: string): Promise<void> {
      if (closed) return Promise.reject(Error('MEDIA_FIXTURE_POOL_CLOSED'));
      const operation = (async () => {
        const pool = await acquire();
        await mkdir(destination, { recursive: true });
        await Promise.all(pool.files.map(async file => {
          const target = join(destination, file);
          await copyFile(join(pool.directory, file), target);
          await chmod(target, 0o644);
        }));
      })();
      copies.add(operation);
      void operation.then(() => copies.delete(operation), () => copies.delete(operation));
      return operation;
    },
    dispose(): Promise<void> {
      return disposal ??= (async () => {
        closed = true;
        await Promise.allSettled([...copies]);
        const pool = await source?.catch(() => undefined);
        if (pool) await rm(pool.directory, { recursive: true, force: true });
      })();
    },
  };
}
