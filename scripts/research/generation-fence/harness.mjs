// Isolated synthetic experiment only: this is not a native receiver or a lock.
import { fork } from 'node:child_process';
import { once } from 'node:events';

export async function startReceiver(options) {
  const child = fork(new URL('./receiver.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  child.send(options);
  const [ready] = await once(child, 'message');
  if (ready !== 'ready') throw new Error('receiver did not initialize');
  return {
    async begin() {
      const response = once(child, 'message');
      child.send('execute');
      return (await response)[0];
    },
    async finish() {
      const response = once(child, 'message');
      const exited = once(child, 'exit');
      child.send('continue');
      const [value] = await response;
      const [code] = await exited;
      if (code !== 0) throw new Error(`receiver exited ${code}`);
      return value;
    },
    async execute() {
      const response = once(child, 'message');
      const exited = once(child, 'exit');
      child.send('execute');
      const [value] = await response;
      const [code] = await exited;
      if (code !== 0) throw new Error(`receiver exited ${code}`);
      return value;
    },
  };
}
