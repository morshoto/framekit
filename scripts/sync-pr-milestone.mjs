export function extractIssueReferences(_body) {
	return [];
}

export function resolvePullRequestMilestone(_linkedIssues, _currentMilestone) {
	return { action: 'skip', reason: 'not-implemented' };
}

export async function syncPullRequestMilestone(_options) {
	return { action: 'skip', reason: 'not-implemented' };
}
