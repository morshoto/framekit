import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Publish a fully written, synced record exactly once; never replace an existing record. */
export async function publishQaRecord(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let owned = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(contents); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (owned) await unlink(temporary);
  }
}
