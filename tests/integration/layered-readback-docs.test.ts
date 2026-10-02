import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("layered Final Cut readback architecture defines trust and escalation", async () => {
  const document = await readFile(join(process.cwd(), "docs/architecture/layered-timeline-readback.md"), "utf8");
  const index = await readFile(join(process.cwd(), "docs/architecture/README.md"), "utf8");

  assert.match(index, /layered-timeline-readback\.md/);
  assert.match(document, /Live observation/);
  assert.match(document, /Preferred background snapshot \(#454\)/);
  assert.match(document, /Pasteboard fallback \(#416\)/);
  assert.match(document, /#417/);
  assert.match(document, /#418/);
  assert.match(document, /#455/);
  assert.match(document, /experimental.*non-canonical/i);
  assert.match(document, /canonical resync/i);
  assert.match(document, /possibly_stale/);
  assert.match(document, /semantic media/i);
  assert.match(document, /must fail closed/i);
});
