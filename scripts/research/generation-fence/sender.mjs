// Isolated simulated sender: only launches the sibling synthetic receiver.
import { fork } from 'node:child_process';
let options;
process.on('message', message => {
  if (!options) { options = message; process.send('ready'); return; }
  if (message !== 'dispatch') return;
  const receiver = fork(new URL('./delayed-receiver.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  receiver.once('message', () => process.send('dispatched'));
  receiver.send(options);
});
