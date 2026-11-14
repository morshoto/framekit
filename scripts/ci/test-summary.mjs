// Node emits per-file summaries as well as the cumulative result.
export default async function* summary(events) {
  let matchedTests = 0;
  for await (const event of events) {
    if (event.type === 'test:summary' && event.data.file !== undefined) matchedTests += event.data.counts.tests;
    if (event.type === 'test:summary' && event.data.file === undefined) {
      yield JSON.stringify({ ...event.data, matchedTests }, null, 2) + '\n';
    }
  }
}
