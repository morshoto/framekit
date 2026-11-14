import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStatusClient } from './sync-project-status.mjs';

const FAILED_CHECKS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

export function choosePullRequestStatus({ mergeable, mergeStateStatus, hasReviewComments, checks }) {
	if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY' || mergeStateStatus === 'BEHIND'
		|| checks.some((check) => check.required && (
			(check.status === 'COMPLETED' && FAILED_CHECKS.has(check.conclusion))
			|| check.state === 'FAILURE' || check.state === 'ERROR'
		))) return 'Pending';
	return hasReviewComments ? 'In review' : 'In progress';
}

export function extractLinkedIssueNumbers(body, repository) {
	const numbers = new Set();
	const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const references = new RegExp(`(?:^|[\\s([,:;])#([1-9]\\d*)\\b|(?:^|[\\s([,:;])${escaped}#([1-9]\\d*)\\b|https://github\\.com/${escaped}/issues/([1-9]\\d*)\\b`, 'g');
	for (const match of body.matchAll(references)) {
		const number = Number(match[1] ?? match[2] ?? match[3]);
		if (Number.isSafeInteger(number)) numbers.add(number);
	}
	return [...numbers];
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const CONTEXTS = `contexts(first:100, after:$after) {
	nodes {
		__typename
		... on CheckRun { name databaseId status conclusion required:isRequired(pullRequestNumber:$number) }
		... on StatusContext { name:context createdAt state required:isRequired(pullRequestNumber:$number) }
	}
	${PAGE_INFO}
}`;
const ROLLUP = `statusCheckRollup { id ${CONTEXTS} }`;
const PULL_REQUEST_QUERY = `query($owner:String!, $name:String!, $number:Int!, $after:String) {
	repository(owner:$owner, name:$name) {
		pullRequest(number:$number) {
			number body state mergeable mergeStateStatus
			reviews(first:1, states:[COMMENTED, CHANGES_REQUESTED, APPROVED]) { totalCount }
			reviewThreads(first:1) { totalCount }
			closingIssuesReferences(first:100) { nodes { number repository { nameWithOwner } } ${PAGE_INFO} }
			commits(last:1) { nodes { commit { ${ROLLUP} } } }
			potentialMergeCommit { ${ROLLUP} }
		}
	}
}`;

// A rerun may coexist with an older failed run in the rollup. Keep its latest
// required context; optional contexts with the same name cannot replace it.
function latestRequiredContexts(contexts) {
	const latest = new Map();
	for (const context of contexts.filter((entry) => entry.required)) {
		const key = `${context.__typename}:${context.name}`;
		const previous = latest.get(key);
		if (!previous || (context.databaseId ?? context.createdAt) > (previous.databaseId ?? previous.createdAt)) {
			latest.set(key, context);
		}
	}
	return latest;
}

export function createPullRequestStatusSource({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
	if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY_INVALID');
	if (!token) throw new Error('FRAMEKIT_PROJECT_TOKEN_REQUIRED');
	const [owner, name] = repository.split('/');
	const graphql = async (query, variables) => {
		const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/graphql`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		});
		if (!response.ok) throw new Error(`GITHUB_GRAPHQL_REQUEST_FAILED: returned ${response.status}`);
		const result = await response.json();
		if (result.errors?.length) throw new Error(`GITHUB_GRAPHQL_REQUEST_FAILED: ${result.errors.map((error) => error.message).join('; ')}`);
		return result.data;
	};
	const readContexts = async (rollup, number) => {
		if (!rollup) return [];
		const contexts = [...rollup.contexts.nodes];
		let page = rollup.contexts.pageInfo;
		while (page.hasNextPage) {
			const data = await graphql(`query($id:ID!, $number:Int!, $after:String) {
				node(id:$id) { ... on StatusCheckRollup { ${CONTEXTS} } }
			}`, { id: rollup.id, number, after: page.endCursor });
			contexts.push(...data.node.contexts.nodes);
			page = data.node.contexts.pageInfo;
		}
		return contexts;
	};
	const readPullRequest = async (number) => {
		const data = await graphql(PULL_REQUEST_QUERY, { owner, name, number, after: null });
		const pr = data.repository.pullRequest;
		// A queued event may run after the PR was closed or merged.
		if (!pr || pr.state !== 'OPEN') return null;
		const linked = [...pr.closingIssuesReferences.nodes];
		let page = pr.closingIssuesReferences.pageInfo;
		while (page.hasNextPage) {
			const next = await graphql(`query($owner:String!, $name:String!, $number:Int!, $after:String) {
				repository(owner:$owner,name:$name) { pullRequest(number:$number) {
					closingIssuesReferences(first:100,after:$after) { nodes { number repository { nameWithOwner } } ${PAGE_INFO} }
				} }
			}`, { owner, name, number, after: page.endCursor });
			const connection = next.repository.pullRequest.closingIssuesReferences;
			linked.push(...connection.nodes);
			page = connection.pageInfo;
		}
		const issueNumbers = new Set(extractLinkedIssueNumbers(pr.body ?? '', repository));
		for (const issue of linked) {
			if (issue.repository.nameWithOwner === repository) issueNumbers.add(issue.number);
		}
		const head = await readContexts(pr.commits.nodes[0]?.commit.statusCheckRollup, number);
		const merge = await readContexts(pr.potentialMergeCommit?.statusCheckRollup, number);
		const checks = latestRequiredContexts(head);
		// GitHub uses a test-merge result when that context exists there, and the
		// head result otherwise. Never let a stale head failure beat a merge pass.
		for (const [key, context] of latestRequiredContexts(merge)) checks.set(key, context);
		return {
			number, issueNumbers: [...issueNumbers], mergeable: pr.mergeable,
			mergeStateStatus: pr.mergeStateStatus,
			hasReviewComments: pr.reviews.totalCount > 0 || pr.reviewThreads.totalCount > 0,
			checks: [...checks.values()],
		};
	};
	return {
		async readOpenPullRequests() {
			const numbers = [];
			let after = null;
			do {
				const data = await graphql(`query($owner:String!, $name:String!, $after:String) {
					repository(owner:$owner,name:$name) { pullRequests(first:100,states:OPEN,after:$after) {
						nodes { number } ${PAGE_INFO}
					} }
				}`, { owner, name, after });
				const connection = data.repository.pullRequests;
				numbers.push(...connection.nodes.map((pr) => pr.number));
				after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
			} while (after);
			const snapshots = [];
			for (const number of numbers) {
				const snapshot = await readPullRequest(number);
				if (snapshot) snapshots.push(snapshot);
			}
			return snapshots;
		},
	};
}

export async function syncPullRequestStatuses({ client, source }) {
	const pullRequests = await source.readOpenPullRequests();
	const priorities = { 'In progress': 1, 'In review': 2, Pending: 3 };
	const statuses = new Map();
	for (const pr of pullRequests) {
		const status = choosePullRequestStatus(pr);
		for (const number of pr.issueNumbers) {
			if (!statuses.has(number) || priorities[status] > priorities[statuses.get(number)]) statuses.set(number, status);
		}
	}
	if (!statuses.size) return [];
	const project = await client.getProject();
	const results = [];
	for (const [number, status] of statuses) {
		const issue = await client.readIssue(number, { allowNotFound: true });
		// PRs can reference other PRs and completed issues. Neither is an active
		// issue card, and PR activity must never reopen a completed issue.
		if (!issue || issue.pull_request || issue.state !== 'open') continue;
		const item = client.projectItemForIssue(project, issue.node_id);
		if (!item) continue;
		await client.setIssueStatusLabel(issue, status);
		const previous = item.fieldValues.nodes.find((value) => value.field?.id === project.statusField.id)?.name ?? null;
		const changed = await client.setProjectStatus(project, item.id, status, previous);
		results.push({ number, status, action: changed ? 'updated' : 'unchanged' });
	}
	return results;
}

async function main() {
	const options = {
		repository: process.env.GITHUB_REPOSITORY,
		token: process.env.FRAMEKIT_PROJECT_TOKEN,
		apiUrl: process.env.GITHUB_API_URL,
	};
	const result = await syncPullRequestStatuses({
		client: createProjectStatusClient({
			...options,
			projectOwner: process.env.FRAMEKIT_PROJECT_OWNER ?? 'morshoto',
			projectNumber: Number(process.env.FRAMEKIT_PROJECT_NUMBER ?? 3),
		}),
		source: createPullRequestStatusSource(options),
	});
	console.log(`PR project status sync: ${JSON.stringify(result)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
