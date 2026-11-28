// Research-only synthetic receiver: no Apple Events or Final Cut interaction.
// Single-process sequential use only; receipts do not authenticate sender or target.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const validKinds = kinds => Array.isArray(kinds) && kinds.length > 0
  && new Set(kinds).size === kinds.length && kinds.every(kind => kind === 'xml' || kind === 'media');

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
          || receipt.targetVerified !== false || !validKinds(receipt.requestedKinds)) throw new Error('invalid receipt');
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
    async create(name, requestedKinds = ['xml']) {
      if (!validKinds(requestedKinds)) throw new Error('invalid requested kinds');
      if (typeof name !== 'string' || !/^[\w -]+$/.test(name) || !name.trim()) throw new Error('invalid name');
      const id = randomUUID();
      const assetDirectory = join(root, id);
      await mkdir(assetDirectory);
      const receipt = { id, name, directory: assetDirectory, state: 'pending', targetVerified: false, requestedKinds: [...requestedKinds] };
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
      const directoryInfo = await lstat(receipt.directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
          || await realpath(receipt.directory) !== receipt.directory) throw new Error('invalid asset directory');
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
      // Extension checks are a mock-specific filter, not verification of media or XML bytes.
      const extensions = new Set(files.map(file => extname(file.name).toLowerCase()));
      if (receipt.requestedKinds.includes('xml') && !extensions.has('.fcpxml')) throw new Error('missing requested xml');
      if (receipt.requestedKinds.includes('media') && !['.mov', '.mp4', '.m4v'].some(ext => extensions.has(ext))) throw new Error('missing requested media');
      const completed = { ...receipt, state: 'observed', files };
      await save(completed);
      return completed;
    },
  };
}
