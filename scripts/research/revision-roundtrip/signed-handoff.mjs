// Synthetic key experiment only: a valid signature is not native or user approval.
import { sign, verify } from 'node:crypto';
import { createAnchoredRevisionB } from './xml-handoff.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);
const time = value => typeof value === 'string' && /^\d+(?:\/[1-9]\d*)?s$/.test(value);
function canonical(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || Object.keys(claim).sort().join(',') !== 'baselineDigest,duration,externalDigest,name,projectUid,sourceDigests,sourceStart,targetId,version'
      || claim.version !== 1 || !identifier(claim.projectUid) || !identifier(claim.targetId)
      || !digest(claim.baselineDigest) || !digest(claim.externalDigest)
      || !claim.sourceDigests || typeof claim.sourceDigests !== 'object' || Array.isArray(claim.sourceDigests)
      || Object.keys(claim.sourceDigests).sort().join(',') !== 'a,m'
      || !digest(claim.sourceDigests.a) || !digest(claim.sourceDigests.m)
      || !time(claim.sourceStart) || !time(claim.duration)
      || typeof claim.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(claim.name)) throw new Error('invalid signed claim');
  return JSON.stringify({ version: 1, projectUid: claim.projectUid, targetId: claim.targetId,
    baselineDigest: claim.baselineDigest, externalDigest: claim.externalDigest,
    sourceDigests: { a: claim.sourceDigests.a, m: claim.sourceDigests.m },
    sourceStart: claim.sourceStart, duration: claim.duration, name: claim.name });
}

export function signFixtureClaim(claim, privateKey) {
  if (privateKey?.asymmetricKeyType !== 'ed25519') throw new Error('invalid signing key');
  const payload = canonical(claim);
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}

export function createSignedRevisionB({ baseline, external, envelope, trustedKey, expectedProject, expectedTarget }) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 4096
      || typeof envelope.signature !== 'string' || trustedKey?.asymmetricKeyType !== 'ed25519') throw new Error('invalid signature');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature
      || !verify(null, Buffer.from(envelope.payload), trustedKey, signature)) throw new Error('invalid signature');
  let claim;
  try { claim = JSON.parse(envelope.payload); } catch { throw new Error('invalid signed claim'); }
  if (canonical(claim) !== envelope.payload) throw new Error('invalid canonical claim');
  if (claim.projectUid !== expectedProject || claim.targetId !== expectedTarget) throw new Error('target mismatch');
  return createAnchoredRevisionB({ baseline, external, baselineDigest: claim.baselineDigest, externalDigest: claim.externalDigest,
    projectUid: claim.projectUid, targetId: claim.targetId, sourceDigests: claim.sourceDigests,
    manifest: { sourceStart: claim.sourceStart, duration: claim.duration }, name: claim.name });
}
