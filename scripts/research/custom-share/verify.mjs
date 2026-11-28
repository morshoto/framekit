// Synthetic research inspection only: digest and XML syntax are not target authentication.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export async function inspectXml(path, expectedDigest) {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('invalid expected digest');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('symlink output');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error('invalid output');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('output changed');
    const xml = bytes.toString('utf8');
    const valid = XMLValidator.validate(xml) === true;
    const parsed = valid ? new XMLParser({ ignoreDeclaration: true }).parse(xml) : {};
    const keys = Object.keys(parsed);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      sha256,
      digestMatches: sha256 === expectedDigest,
      wellFormedFcpxml: valid && keys.length === 1 && keys[0] === 'fcpxml',
      targetVerified: false,
    };
  } finally { await handle.close(); }
}
