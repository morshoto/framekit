// Test-only child; it never dispatches to an editor and self-terminates.
import { claim } from './sqlite-journal.mjs';
process.once('message', async ({ path, request }) => {
  const result = await claim(path, request);
  process.send(result.status);
  setTimeout(() => process.exit(1), 5000);
});
