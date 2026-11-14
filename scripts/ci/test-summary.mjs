// Node emits per-file summaries as well as the cumulative result.
export default async function* summary(events) {
  for await (const event of events) {
    if (event.type === 'test:summary' && event.data.file === undefined) {
      yield JSON.stringify(event.data, null, 2) + '\n';
    }
  }
}
