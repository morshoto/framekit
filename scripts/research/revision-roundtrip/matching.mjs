// Offline research only: equal source intervals are not proof of persistent native identity.
import { createHash } from 'node:crypto';

export function bindRevision(bytes, expectedDigest) {
  if (!Buffer.isBuffer(bytes)) throw new Error('invalid artifact');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new Error('stale revision');
  return { digest };
}

function rational(value, positive = false) {
  if (typeof value !== 'string' || !/^-?\d+\/[1-9]\d*$/.test(value)) throw new Error('invalid rational');
  let [numerator, denominator] = value.split('/').map(BigInt);
  if (numerator < 0n || (positive && numerator === 0n)) throw new Error('invalid range');
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return `${numerator / a}/${denominator / a}`;
}

function index(items) {
  if (!Array.isArray(items)) throw new Error('invalid collection');
  const ids = new Set();
  const keys = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
        || typeof item.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceDigest)) throw new Error('invalid occurrence');
    ids.add(item.id);
    const key = JSON.stringify([item.sourceDigest, rational(item.sourceStart), rational(item.duration, true)]);
    if (keys.has(key)) throw new Error('ambiguous source interval');
    keys.set(key, item.id);
  }
  return keys;
}

export function reconcileOccurrences(base, observed) {
  const before = index(base);
  const after = index(observed);
  const matches = [];
  for (const [key, baseId] of before) {
    const observedId = after.get(key);
    if (!observedId) throw new Error('missing source interval');
    matches.push({ baseId, observedId });
  }
  const inserted = [...after].filter(([key]) => !before.has(key)).map(([, id]) => id);
  return { matches, inserted };
}

// This only finds an unchanged unique interval, not durable native identity.
export function locateTarget(base, observed, targetId) {
  const before = index(base);
  const after = index(observed);
  const found = [...before].find(([, id]) => id === targetId);
  if (!found || !after.has(found[0])) throw new Error('missing target interval');
  return after.get(found[0]);
}
