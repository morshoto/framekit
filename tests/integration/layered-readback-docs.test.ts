import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("layered Final Cut readback architecture defines trust and escalation", async () => {
  const document = await readFile(join(process.cwd(), "docs/architecture/layered-timeline-readback.md"), "utf8");

  assert.match(document, /Live observation/);
  assert.match(document, /experimental.*non-canonical/i);
  assert.match(document, /canonical resync/i);
  assert.match(document, /possibly_stale/);
  assert.match(document, /semantic media/);
  assert.match(document, /must fail closed/i);
});
