// Deliberately models three trust boundaries, not Final Cut behavior.
import { appendFile, readFile } from 'node:fs/promises';
let options;
let accepted = false;
process.on('message', async message => {
  if (!options) {
    options = message;
    if (options.mode === 'check-before-queue') accepted = (await readFile(options.generation, 'utf8')) === options.generationId;
    process.send('ready');
    return;
  }
  if (message !== 'execute' && message !== 'continue') return;
  if (options.mode === 'check-then-pause' && message === 'execute') {
    accepted = (await readFile(options.generation, 'utf8')) === options.generationId;
    process.send('checked');
    return;
  }
  if (options.mode === 'target-check' && (typeof options.target !== 'string' || !options.target
      || options.target !== options.allowedTarget)) {
    process.send('rejected-target', () => process.disconnect());
    return;
  }
  let permitted = options.mode === 'legacy' || accepted;
  if (options.mode === 'receiver-check' || options.mode === 'target-check') {
    try { permitted = (await readFile(options.generation, 'utf8')) === options.generationId; }
    catch { permitted = false; }
  }
  if (permitted) await appendFile(options.output, `${options.mode}\n`);
  process.send(permitted ? 'executed' : 'rejected-stale', () => process.disconnect());
});
