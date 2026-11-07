export function blocked(message) { throw new Error(`BLOCKED: ${message}`); }

// A workflow result alone does not prove which deployment is currently served.
export function validateDeployment({ runId, expected, run, deployment, status }) {
  if (!/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(expected || '')) blocked('set DOCS_DEPLOY_RUN_ID and a full DOCS_EXPECTED_SHA');
  if (run?.conclusion !== 'success' || run.headSha !== expected) blocked('workflow run did not succeed at the expected SHA');
  if (!deployment || deployment.sha !== expected) blocked('latest Pages deployment does not match the expected SHA');
  let log, runUrl, site;
  try { log = new URL(status?.log_url); runUrl = new URL(run.url); site = new URL(status?.environment_url); }
  catch { blocked('deployment status lacks a valid workflow or site URL'); }
  const runPath = runUrl.pathname.replace(/\/$/, '');
  if (status.state !== 'success' || runUrl.origin !== 'https://github.com' || !runPath.endsWith(`/runs/${runId}`) || log.origin !== runUrl.origin || !(log.pathname === runPath || log.pathname.startsWith(`${runPath}/`))) blocked('latest successful deployment cannot be tied to this exact workflow run');
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) blocked('deployment URL must be an HTTPS site URL');
  if (!site.pathname.endsWith('/')) site.pathname += '/';
  return site;
}
