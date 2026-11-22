import { writeVitestSummary } from './test-reports.mjs';
console.log(await writeVitestSummary(process.argv[2], process.env.GITHUB_STEP_SUMMARY));
