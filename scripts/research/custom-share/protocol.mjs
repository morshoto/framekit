// Sequential, in-memory Apple-documented event-shape model only.
// Strict ordering, field values and IDs here are mock choices, not native guarantees.
import { createReceiver } from './receiver.mjs';

export async function createProtocol(root) {
  const receiver = await createReceiver(root);
  const sessions = new Map();
  const steps = ['location', 'library', 'metadata', 'options', 'open'];
  const session = id => {
    const value = sessions.get(id);
    if (!value) throw new Error('unknown asset');
    return value;
  };
  return {
    async make(name, kinds) {
      const asset = await receiver.create(name, kinds);
      sessions.set(asset.id, { asset, next: 0, trace: ['make'] });
      return structuredClone(asset);
    },
    trace(id) { return [...session(id).trace]; },
    async event(id, event, payload) {
      const state = session(id);
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
      state.next++;
      state.trace.push(event);
      return result;
    },
  };
}
