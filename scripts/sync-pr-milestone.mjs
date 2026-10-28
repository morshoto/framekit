import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function extractIssueReferences(body) {
	const references = new Set();
	for (const match of body.matchAll(/(?:^|[^\p{L}\p{N}_])#([1-9]\d*)\b/gu)) {
		references.add(Number(match[1]));
	}
	return [...references];
}

export function resolvePullRequestMilestone(linkedIssues, currentMilestone) {
	if (linkedIssues.length === 0) return { action: 'skip', reason: 'no-linked-issues' };

	let milestone;
	for (const issue of linkedIssues) {
		if (issue.milestone?.number !== undefined
			&& (!milestone || issue.milestone.number < milestone.number)) {
			milestone = issue.milestone;
		}
	}
	if (!milestone) return { action: 'skip', reason: 'no-linked-milestone' };

	if (currentMilestone?.number === milestone.number) return { action: 'unchanged', milestone };
	return { action: 'update', milestone };
}

const DEFAULT_TIMELINE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];

export async function syncPullRequestMilestone({
	repository,
	pullRequestNumber,
	body,
	token,
	apiUrl = 'https://api.github.com',
	fetchImpl = fetch,
	timelineRetryDelaysMs = DEFAULT_TIMELINE_RETRY_DELAYS_MS,
	sleepImpl = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
	if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY_INVALID');
	if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) throw new Error('PULL_REQUEST_NUMBER_INVALID');
	if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

	const apiRoot = apiUrl.replace(/\/$/, '');
	const headers = {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
		'X-GitHub-Api-Version': '2022-11-28',
		'Content-Type': 'application/json',
	};
	const request = async (path, { method = 'GET', body: requestBody, allowNotFound = false } = {}) => {
		const url = path.startsWith('http') ? path : `${apiRoot}/repos/${repository}${path}`;
		const response = await fetchImpl(url, {
			method,
			headers,
			...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
		});
		if (allowNotFound && response.status === 404) return null;
		if (!response.ok) {
			throw new Error(`GITHUB_API_REQUEST_FAILED: ${method} ${new URL(url).pathname} returned ${response.status}`);
		}
		if (response.status === 204) return null;
		return response.json();
	};
	const readTimeline = async (issueNumber) => {
		const events = [];
		let url = `${apiRoot}/repos/${repository}/issues/${issueNumber}/timeline?per_page=100`;
		while (url) {
			const response = await fetchImpl(url, { headers });
			if (!response.ok) {
				throw new Error(`GITHUB_API_REQUEST_FAILED: GET ${new URL(url).pathname} returned ${response.status}`);
			}
			events.push(...await response.json());
			url = nextPageUrl(response.headers.get('link'));
		}
		return events;
	};
	const hasPullRequestCrossReference = async (issueNumber) => {
		for (let attempt = 0; attempt <= timelineRetryDelaysMs.length; attempt += 1) {
			if (attempt > 0) await sleepImpl(timelineRetryDelaysMs[attempt - 1]);
			const events = await readTimeline(issueNumber);
			if (events.some((event) => event.event === 'cross-referenced'
				&& event.source?.issue?.number === pullRequestNumber
				&& event.source.issue.pull_request)) return true;
		}
		return false;
	};

	const pullRequest = await request(`/issues/${pullRequestNumber}`);
	if (!pullRequest?.pull_request) throw new Error('PULL_REQUEST_NOT_FOUND');
	const linkedIssues = [];
	for (const issueNumber of extractIssueReferences(body).filter((number) => number !== pullRequestNumber)) {
		const issue = await request(`/issues/${issueNumber}`, { allowNotFound: true });
		if (!issue || issue.pull_request) continue;
		const isGitHubLinked = await hasPullRequestCrossReference(issueNumber);
		if (isGitHubLinked) linkedIssues.push({ number: issueNumber, milestone: issue.milestone ?? null });
	}

	const decision = resolvePullRequestMilestone(linkedIssues, pullRequest.milestone ?? null);
	if (decision.action !== 'update') return decision;
	await request(`/issues/${pullRequestNumber}`, {
		method: 'PATCH',
		body: { milestone: decision.milestone.number },
	});
	return { action: 'updated', milestoneNumber: decision.milestone.number };
}

function nextPageUrl(linkHeader) {
	if (!linkHeader) return null;
	for (const match of linkHeader.matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g)) return match[1];
	return null;
}

async function main() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	const token = process.env.GITHUB_TOKEN;
	if (!eventPath) throw new Error('GITHUB_EVENT_PATH_REQUIRED');
	if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');
	const event = JSON.parse(await readFile(eventPath, 'utf8'));
	const pullRequest = event.pull_request;
	if (!pullRequest) throw new Error('PULL_REQUEST_EVENT_REQUIRED');
	const result = await syncPullRequestMilestone({
		repository: process.env.GITHUB_REPOSITORY,
		pullRequestNumber: pullRequest.number,
		body: pullRequest.body ?? '',
		token,
		apiUrl: process.env.GITHUB_API_URL,
	});
	console.log(`Pull request #${pullRequest.number} milestone sync: ${JSON.stringify(result)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
