// Research-only synthetic receiver: no Apple Events or Final Cut interaction.
// Single-process sequential use only; receipts do not authenticate sender or target.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function createReceiver(directory) {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const receiptPath = id => {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error('unknown asset');
    return join(root, `${id}.json`);
  };
  const get = async id => {
    try {
      const receipt = JSON.parse(await readFile(receiptPath(id), 'utf8'));
      if (!receipt || receipt.id !== id || receipt.directory !== join(root, id)
          || typeof receipt.name !== 'string' || !/^[\w -]+$/.test(receipt.name)
          || !['pending', 'observed', 'cancelled'].includes(receipt.state)
          || receipt.targetVerified !== false) throw new Error('invalid receipt');
      return receipt;
    }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('unknown asset');
      throw error;
    }
  };
  const save = async receipt => {
    const path = receiptPath(receipt.id);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(receipt), { flag: 'wx' });
    await rename(temp, path);
  };
  return {
    async create(name) {
      if (typeof name !== 'string' || !/^[\w -]+$/.test(name) || !name.trim()) throw new Error('invalid name');
      const id = randomUUID();
      const assetDirectory = join(root, id);
      await mkdir(assetDirectory);
      const receipt = { id, name, directory: assetDirectory, state: 'pending', targetVerified: false };
      await save(receipt);
      return receipt;
    },
    get,
    async cancel(id) {
      const receipt = await get(id);
      if (receipt.state !== 'pending') throw new Error('already settled');
      const cancelled = { ...receipt, state: 'cancelled' };
      await save(cancelled);
      return cancelled;
    },
    async complete(id, paths) {
      const receipt = await get(id);
      if (receipt.state === 'cancelled') throw new Error('cancelled locally');
      if (receipt.state !== 'pending') throw new Error('already completed');
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('empty output');
      const unique = new Set();
      const files = [];
      for (const path of paths) {
        const absolute = resolve(path);
        if (dirname(absolute) !== receipt.directory) throw new Error('outside asset directory');
        if (unique.has(absolute)) throw new Error('duplicate output');
        unique.add(absolute);
        const name = basename(absolute);
        if (!(name.startsWith(`${receipt.name}.`) || name.startsWith(`${receipt.name}-`))) throw new Error('wrong basename');
        const stats = await lstat(absolute);
        if (stats.isSymbolicLink()) throw new Error('symlink output');
        if (!stats.isFile()) throw new Error('not a file');
        const bytes = await readFile(absolute);
        files.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const completed = { ...receipt, state: 'observed', files };
      await save(completed);
      return completed;
    },
  };
}
