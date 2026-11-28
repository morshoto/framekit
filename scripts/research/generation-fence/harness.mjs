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

export async function startSender(options) {
  const child = fork(new URL('./sender.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  child.send(options);
  const [ready] = await once(child, 'message');
  if (ready !== 'ready') throw new Error('sender did not initialize');
  return {
    async dispatch() {
      const response = once(child, 'message');
      child.send('dispatch');
      const [value] = await response;
      if (value !== 'dispatched') throw new Error('dispatch failed');
    },
    async kill() {
      const exited = once(child, 'exit');
      if (!child.kill('SIGKILL')) throw new Error('cannot stop owned sender');
      const [code, signal] = await exited;
      if (code !== null || signal !== 'SIGKILL') throw new Error('unexpected sender exit');
    },
  };
}
