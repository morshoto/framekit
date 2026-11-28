// Advisory static report comparison. It never establishes native capability.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function validate(report) {
  if (!report || report.probeVersion !== 1 || !report.finalCut || !report.supportedSurfaces
      || !report.supportedSurfaces.appleEvents || !report.supportedSurfaces.workflowExtension
      || !report.classification || typeof report.classification.classification !== 'string'
      || !(report.finalCut.version === null || typeof report.finalCut.version === 'string')
      || !['accessGroups', 'commands', 'classes'].every(key => Array.isArray(report.supportedSurfaces.appleEvents[key]))) {
    throw new Error('invalid report');
  }
}

export function compareReports(baseline, current) {
  validate(baseline);
  validate(current);
  const describe = report => ({ ...report.finalCut, classification: report.classification.classification });
  return {
    baseline: describe(baseline),
    current: describe(current),
    // Array ordering and checked-in extension source also affect this indicator.
    surfaceChanged: JSON.stringify(baseline.supportedSurfaces) !== JSON.stringify(current.supportedSurfaces),
    canonicalCapabilityPromoted: false,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) throw new Error('usage: node compare.mjs baseline.json current.json');
  const baseline = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const current = JSON.parse(await readFile(process.argv[3], 'utf8'));
  console.log(JSON.stringify(compareReports(baseline, current), null, 2));
}
