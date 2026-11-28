// Sequential synthetic event model; journal is not authenticated or concurrency-safe.
// Strict ordering, field values and IDs are mock choices, not native guarantees.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReceiver } from './receiver.mjs';

export async function createProtocol(root) {
  const receiver = await createReceiver(root);
  const directory = await realpath(root);
  const sessions = new Map();
  const steps = ['location', 'library', 'metadata', 'options', 'open'];
  const journalPath = id => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error('unknown asset');
    return join(directory, `protocol-${id}.json`);
  };
  const save = async (id, next) => {
    const path = journalPath(id);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ id, next, trace: ['make', ...steps.slice(0, next)] }), { flag: 'wx' });
    await rename(temp, path);
  };
  const load = async id => {
    if (sessions.has(id)) return sessions.get(id);
    const path = journalPath(id);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error('invalid size');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (!record || record.id !== id || !Number.isInteger(record.next) || record.next < 0 || record.next > steps.length
          || JSON.stringify(record.trace) !== JSON.stringify(['make', ...steps.slice(0, record.next)])) throw new Error('invalid state');
      const asset = await receiver.get(id);
      if ((record.next === steps.length && asset.state !== 'observed') || (record.next < steps.length && asset.state !== 'pending')) throw new Error('receipt mismatch');
      const value = { asset, next: record.next, trace: record.trace };
      sessions.set(id, value);
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('unknown asset');
      throw new Error('invalid journal', { cause: error });
    } finally { await handle?.close(); }
  };
  return {
    async make(name, kinds) {
      const asset = await receiver.create(name, kinds);
      await save(asset.id, 0);
      sessions.set(asset.id, { asset, next: 0, trace: ['make'] });
      return structuredClone(asset);
    },
    trace(id) {
      const value = sessions.get(id);
      if (!value) throw new Error('unknown asset');
      return [...value.trace];
    },
    async inspect(id) { return [...(await load(id)).trace]; },
    async event(id, event, payload) {
      const state = await load(id);
      if (steps[state.next] !== event) throw new Error('unexpected event order');
      let result;
      switch (event) {
        case 'location':
          result = { folder: state.asset.directory, baseName: state.asset.name,
            hasDescription: state.asset.requestedKinds.includes('xml'), hasMedia: state.asset.requestedKinds.includes('media') };
          break;
        case 'library': result = { hasArchive: false, hasLibraryDescription: false }; break;
        case 'metadata': result = { shareId: state.asset.id }; break;
        case 'options': result = { descriptionVersion: '1.11' }; break;
        case 'open': result = await receiver.complete(id, payload); break;
        default: throw new Error('unexpected event');
      }
      await save(id, state.next + 1);
      state.next++;
      state.trace.push(event);
      return result;
    },
  };
}
