// Synthetic SQLite claim journal only; it cannot fence an external receiver.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const id = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);
const valid = request => request && id(request.operation) && id(request.target)
  && typeof request.digest === 'string' && /^[a-f0-9]{64}$/.test(request.digest)
  && Number.isSafeInteger(request.generation) && request.generation > 0;

async function query(path, sql, readOnly = false) {
  const args = ['-batch', '-json', '-cmd', '.timeout 5000'];
  if (readOnly) args.push('-readonly');
  args.push(path, sql);
  const { stdout } = await exec('sqlite3', args, { maxBuffer: 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export async function initialize(path) {
  await query(path, `CREATE TABLE IF NOT EXISTS operations (
    operation TEXT PRIMARY KEY, target TEXT NOT NULL, digest TEXT NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state = 'possibly-dispatched')
  );`);
}

export async function inspect(path, operation) {
  if (!id(operation)) throw new Error('invalid operation');
  const rows = await query(path, `SELECT operation, target, digest, generation, state FROM operations WHERE operation = '${operation}';`, true);
  if (rows.length === 0) return undefined;
  if (rows.length !== 1 || !valid(rows[0]) || rows[0].state !== 'possibly-dispatched') throw new Error('invalid journal');
  return rows[0];
}

export async function claim(path, request) {
  if (!valid(request)) throw new Error('invalid request');
  const { operation, target, digest, generation } = request;
  const rows = await query(path, `INSERT INTO operations (operation,target,digest,generation,state)
    VALUES ('${operation}','${target}','${digest}',${generation},'possibly-dispatched')
    ON CONFLICT(operation) DO NOTHING RETURNING operation;`);
  if (rows.length === 1 && rows[0].operation === operation) return { status: 'claimed' };
  const existing = await inspect(path, operation);
  if (!existing) throw new Error('unknown journal state');
  return { status: existing.target === target && existing.digest === digest && existing.generation === generation ? 'existing' : 'conflict' };
}
