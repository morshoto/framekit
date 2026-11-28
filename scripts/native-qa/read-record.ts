import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const maxRecordBytes = 64 * 1024;

/** Read one bounded regular-file observation; this is not filesystem fencing. */
export async function readQaRecord(path: string): Promise<string> {
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("QA_RUN_UNSAFE_PATH");
  if (initial.size > BigInt(maxRecordBytes)) throw new Error("QA_RECORD_INVALID");
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("QA_RUN_UNSAFE_PATH");
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    const same = (stat: typeof before) => stat.isFile() && !stat.isSymbolicLink()
      && stat.dev === initial.dev && stat.ino === initial.ino && stat.size === initial.size && stat.mtimeNs === initial.mtimeNs;
    if (!same(before)) throw new Error("QA_RECORD_INVALID");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (BigInt(offset) !== before.size || !same(after) || !same(named)) throw new Error("QA_RECORD_INVALID");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}
