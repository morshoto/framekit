/** Read GitHub alert identities from the processed CodeQL analysis, failing closed on incomplete data. */
export function extractCodeQLAlertNumbers(sarif, resultsCount) {
  if (!Array.isArray(sarif?.runs) || !Number.isInteger(resultsCount) || resultsCount < 0) {
    throw new Error('CodeQL SARIF or analysis result count is unavailable');
  }
  const results = [];
  for (const run of sarif.runs) {
    if (run.tool?.driver?.name !== 'CodeQL' || (run.results !== undefined && !Array.isArray(run.results))) {
      throw new Error('SARIF is not a valid CodeQL analysis');
    }
    results.push(...(run.results ?? []));
  }
  if (results.length !== resultsCount) throw new Error('CodeQL SARIF result count does not match the analysis');
  const numbers = results.map((result) => result.properties?.['github/alertNumber']);
  if (numbers.some((number) => !Number.isInteger(number) || number < 1)) {
    throw new Error('CodeQL SARIF finding is missing a GitHub alert number');
  }
  return [...new Set(numbers)];
}

export function classifyCodeQLAlert(alert) {
  if (alert.state === 'dismissed') return 'dismissed';
  if (!['open', 'fixed'].includes(alert.state)) return 'unknown';
  const severity = alert.rule?.severity?.toLowerCase();
  const securitySeverity = alert.rule?.security_severity_level?.toLowerCase();
  if (!['error', 'warning', 'note'].includes(severity) ||
      (securitySeverity && !['low', 'medium', 'high', 'critical'].includes(securitySeverity))) {
    return 'unknown';
  }
  return severity === 'error' || ['high', 'critical'].includes(securitySeverity) ? 'blocking' : 'nonblocking';
}
