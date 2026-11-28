// Simulates an independent downstream queue; self-terminates if no trigger appears.
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
process.once('message', options => {
  let running = false;
  const timer = setInterval(async () => {
    if (running || !existsSync(options.trigger)) return;
    running = true;
    clearInterval(timer);
    clearTimeout(deadline);
    await appendFile(options.output, 'delayed receiver executed\n');
    if (process.connected) process.disconnect();
  }, 10);
  const deadline = setTimeout(() => { clearInterval(timer); if (process.connected) process.disconnect(); }, 3000);
  process.send('ready');
});
