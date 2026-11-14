// Node emits per-file summaries as well as the cumulative result. Emit one
// final JSON document, including after a watch session, so it stays parseable.
export default async function* summary(events) {
  let matchedTests = 0;
  let final;
  const slowest = [], skips = [], reproductions = [];
  for await (const { type, data } of events) {
    if (type === 'test:summary' && data.file !== undefined) matchedTests += data.counts.tests;
    if (type === 'test:summary' && data.file === undefined) final = data;
    if ((type === 'test:pass' || type === 'test:fail') && data.details?.type === 'test' && !/\.test\.(ts|mjs)$/.test(data.name)) {
      const record = { name: data.name, file: data.file, duration_ms: data.details.duration_ms ?? 0 };
      if (data.skip) skips.push({ ...record, reason: typeof data.skip === 'string' ? data.skip : 'unspecified' });
      else {
        slowest.push(record);
        slowest.sort((a, b) => b.duration_ms - a.duration_ms || a.name.localeCompare(b.name));
        slowest.length = Math.min(slowest.length, 10);
      }
    }
    if (type === 'test:diagnostic' && /^(?:Replay:|\{"seed":)/.test(data.message)) reproductions.push(data.message);
  }
  if (final) yield JSON.stringify({ ...final, matchedTests, slowest, skips, reproductions }, null, 2) + '\n';
}
