import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_STATUSES = ['Backlog', 'In progress', 'In review', 'Pending', 'Done'];
export const STATUS_LABEL_PREFIX = 'Status: ';
const STATUS_LABELS = new Set(PROJECT_STATUSES.map((status) => `${STATUS_LABEL_PREFIX}${status}`));

export function statusFromLabel(label) {
	if (!STATUS_LABELS.has(label)) return null;
	return label.slice(STATUS_LABEL_PREFIX.length);
}

export function chooseIssueStatus({ action, eventLabel, labels }) {
	if (action === 'opened' || action === 'reopened') return 'Backlog';
	if (action === 'closed') return 'Done';

	const currentStatusLabels = labels.filter((label) => STATUS_LABELS.has(label));
	if (action === 'labeled' && STATUS_LABELS.has(eventLabel) && currentStatusLabels.includes(eventLabel)) {
		return statusFromLabel(eventLabel);
	}
	if (currentStatusLabels.length > 1) {
		throw new Error(`MULTIPLE_STATUS_LABELS: ${currentStatusLabels.join(', ')}`);
	}
	return currentStatusLabels.length === 1 ? statusFromLabel(currentStatusLabels[0]) : 'Backlog';
}

export function backfillStatus({ labels, boardStatus }) {
	const currentStatusLabels = labels.filter((label) => STATUS_LABELS.has(label));
	if (currentStatusLabels.length > 1) {
		return { conflict: true, labels: currentStatusLabels };
	}
	if (currentStatusLabels.length === 1) {
		return { conflict: false, status: statusFromLabel(currentStatusLabels[0]), seedLabel: false };
	}
	return {
		conflict: false,
		status: PROJECT_STATUSES.includes(boardStatus) ? boardStatus : 'Backlog',
		seedLabel: true,
	};
}

export function statusLabelChanges(labels, status) {
	if (!PROJECT_STATUSES.includes(status)) throw new Error(`UNKNOWN_PROJECT_STATUS: ${status}`);
	const selectedLabel = `${STATUS_LABEL_PREFIX}${status}`;
	return {
		add: labels.includes(selectedLabel) ? [] : [selectedLabel],
		remove: labels.filter((label) => STATUS_LABELS.has(label) && label !== selectedLabel),
	};
}

const PROJECT_QUERY = `
	query($login: String!, $number: Int!, $after: String) {
		user(login: $login) {
			projectV2(number: $number) {
				id
				fields(first: 100) {
					nodes {
						__typename
						... on ProjectV2SingleSelectField { id name options { id name } }
					}
				}
				items(first: 100, after: $after) {
					nodes {
						id
						fieldValues(first: 100) {
							nodes {
								... on ProjectV2ItemFieldSingleSelectValue {
									name
									field { ... on ProjectV2SingleSelectField { id name } }
								}
							}
						}
						content {
							__typename
							... on Issue {
								id number state repository { nameWithOwner }
								labels(first: 100) { nodes { name } }
							}
							... on PullRequest {
								id number state repository { nameWithOwner }
								labels(first: 100) { nodes { name } }
							}
						}
					}
					pageInfo { hasNextPage endCursor }
				}
			}
		}
	}
`;

const ADD_ITEM_MUTATION = `
	mutation($project: ID!, $content: ID!) {
		addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
			item { id }
		}
	}
`;

const UPDATE_STATUS_MUTATION = `
	mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
		updateProjectV2ItemFieldValue(input: {
			projectId: $project
			itemId: $item
			fieldId: $field
			value: { singleSelectOptionId: $option }
		}) { projectV2Item { id } }
	}
`;

function statusValue(item, fieldId) {
	return item.fieldValues.nodes.find((value) => value.field?.id === fieldId)?.name ?? null;
}

function issueLabels(issue) {
	return issue.labels.map((label) => label.name);
}

export function createProjectStatusClient({
	repository,
	token,
	projectOwner = 'morshoto',
	projectNumber = 3,
	apiUrl = 'https://api.github.com',
	fetchImpl = fetch,
}) {
	if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY_INVALID');
	if (!token) throw new Error('FRAMEKIT_PROJECT_TOKEN_REQUIRED');
	if (!Number.isInteger(projectNumber) || projectNumber <= 0) throw new Error('PROJECT_NUMBER_INVALID');

	const apiRoot = apiUrl.replace(/\/$/, '');
	const headers = {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
		'X-GitHub-Api-Version': '2022-11-28',
		'Content-Type': 'application/json',
	};
	const rest = async (path, { method = 'GET', body } = {}) => {
		const url = `${apiRoot}/repos/${repository}${path}`;
		const response = await fetchImpl(url, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			throw new Error(`GITHUB_API_REQUEST_FAILED: ${method} ${new URL(url).pathname} returned ${response.status}`);
		}
		if (response.status === 204) return null;
		return response.json();
	};
	const graphql = async (query, variables) => {
		const url = `${apiRoot}/graphql`;
		const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
		if (!response.ok) {
			throw new Error(`GITHUB_GRAPHQL_REQUEST_FAILED: returned ${response.status}`);
		}
		const result = await response.json();
		if (result.errors?.length) {
			const messages = result.errors.map((error) => error.message).join('; ');
			throw new Error(`GITHUB_GRAPHQL_REQUEST_FAILED: ${messages}`);
		}
		return result.data;
	};

	const getProject = async () => {
		const items = [];
		let after = null;
		let project = null;
		do {
			const data = await graphql(PROJECT_QUERY, { login: projectOwner, number: projectNumber, after });
			project = data.user?.projectV2;
			if (!project) throw new Error('PROJECT_NOT_FOUND_OR_UNAVAILABLE');
			items.push(...project.items.nodes);
			after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
		} while (after);

		const statusField = project.fields.nodes.find((field) => field.name === 'Status' && field.options);
		if (!statusField) throw new Error('PROJECT_STATUS_FIELD_NOT_FOUND');
		const options = new Map(statusField.options.map((option) => [option.name, option.id]));
		for (const status of PROJECT_STATUSES) {
			if (!options.has(status)) throw new Error(`PROJECT_STATUS_OPTION_NOT_FOUND: ${status}`);
		}
		return { id: project.id, statusField, options, items };
	};

	const setProjectStatus = async (project, itemId, status, previousStatus) => {
		if (status === previousStatus) return false;
		await graphql(UPDATE_STATUS_MUTATION, {
			project: project.id,
			item: itemId,
			field: project.statusField.id,
			option: project.options.get(status),
		});
		return true;
	};

	const setIssueStatusLabel = async (issue, status) => {
		const changes = statusLabelChanges(issueLabels(issue), status);
		if (changes.add.length) {
			await rest(`/issues/${issue.number}/labels`, { method: 'POST', body: { labels: changes.add } });
		}
		for (const label of changes.remove) {
			await rest(`/issues/${issue.number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
		}
	};

	const projectItemForIssue = (project, issueNodeId) => project.items.find((item) => item.content?.id === issueNodeId);
	const addIssueToProject = async (project, issueNodeId) => {
		try {
			const data = await graphql(ADD_ITEM_MUTATION, { project: project.id, content: issueNodeId });
			return data.addProjectV2ItemById.item.id;
		} catch (error) {
			// The project auto-add workflow may add the same issue between our query and mutation.
			const refreshed = await getProject();
			const existing = projectItemForIssue(refreshed, issueNodeId);
			if (existing) return existing.id;
			throw error;
		}
	};

	return {
		getProject,
		readIssue: (number) => rest(`/issues/${number}`),
		setIssueStatusLabel,
		setProjectStatus,
		projectItemForIssue,
		addIssueToProject,
	};
}

export async function syncIssueEvent({ client, issue, action, eventLabel }) {
	let project = await client.getProject();
	let item = client.projectItemForIssue(project, issue.node_id);
	if (!item && issue.state === 'open' && action === 'opened') {
		const itemId = await client.addIssueToProject(project, issue.node_id);
		project = await client.getProject();
		item = client.projectItemForIssue(project, issue.node_id) ?? { id: itemId, fieldValues: { nodes: [] } };
	}
	if (!item || issue.pull_request) return { action: 'skipped', reason: 'issue-not-in-project' };

	const currentIssue = await client.readIssue(issue.number);
	const labels = issueLabels(currentIssue);
	const status = chooseIssueStatus({ action, eventLabel, labels });
	await client.setIssueStatusLabel(currentIssue, status);
	const changed = await client.setProjectStatus(project, item.id, status, statusValue(item, project.statusField.id));
	return { action: changed ? 'updated' : 'unchanged', status };
}

export async function backfillProject({ client, repository, log = console }) {
	const project = await client.getProject();
	let scanned = 0;
	let updated = 0;
	let conflicts = 0;
	for (const item of project.items) {
		const issue = item.content;
		if (issue?.__typename !== 'Issue' || issue.repository?.nameWithOwner !== repository) continue;
		scanned += 1;
		const currentIssue = await client.readIssue(issue.number);
		const labels = issueLabels(currentIssue);
		const decision = backfillStatus({
			labels,
			boardStatus: statusValue(item, project.statusField.id),
		});
		if (decision.conflict) {
			conflicts += 1;
			log.error(`Issue #${issue.number} has multiple Status labels: ${decision.labels.join(', ')}`);
			continue;
		}
		const beforeLabelCount = statusLabelChanges(issueLabels(currentIssue), decision.status);
		const labelChanged = beforeLabelCount.add.length > 0 || beforeLabelCount.remove.length > 0;
		await client.setIssueStatusLabel(currentIssue, decision.status);
		const boardChanged = await client.setProjectStatus(
			project,
			item.id,
			decision.status,
			statusValue(item, project.statusField.id),
		);
		if (labelChanged || boardChanged) updated += 1;
	}
	const summary = { scanned, updated, conflicts };
	log.log(`Project status backfill: ${JSON.stringify(summary)}`);
	if (conflicts) throw new Error(`PROJECT_STATUS_BACKFILL_CONFLICTS: ${conflicts}`);
	return summary;
}

async function main() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error('GITHUB_EVENT_PATH_REQUIRED');
	const event = JSON.parse(await readFile(eventPath, 'utf8'));
	const client = createProjectStatusClient({
		repository: process.env.GITHUB_REPOSITORY,
		token: process.env.FRAMEKIT_PROJECT_TOKEN,
		projectOwner: process.env.FRAMEKIT_PROJECT_OWNER ?? 'morshoto',
		projectNumber: Number(process.env.FRAMEKIT_PROJECT_NUMBER ?? 3),
		apiUrl: process.env.GITHUB_API_URL,
	});

	if (event.action === undefined) {
		await backfillProject({ client, repository: process.env.GITHUB_REPOSITORY });
		return;
	}
	if (!event.issue) throw new Error('ISSUE_EVENT_REQUIRED');
	const eventLabel = event.label?.name ?? null;
	if ((event.action === 'labeled' || event.action === 'unlabeled') && !statusFromLabel(eventLabel)) {
		console.log(`Issue #${event.issue.number}: ignoring non-status label event.`);
		return;
	}
	const result = await syncIssueEvent({
		client,
		issue: event.issue,
		action: event.action,
		eventLabel,
	});
	console.log(`Issue #${event.issue.number} project status sync: ${JSON.stringify(result)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
