import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	backfillStatus,
	chooseIssueStatus,
	PROJECT_STATUSES,
	createProjectStatusClient,
	statusFromLabel,
	statusLabelChanges,
	backfillProject,
	syncIssueEvent,
} from '../../scripts/sync-project-status.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function readRepositoryFile(relativePath: string): Promise<string> {
	return readFile(resolve(repository, relativePath), 'utf8');
}

test('project statuses map only the five workflow labels', () => {
	assert.deepEqual(PROJECT_STATUSES, ['Backlog', 'In progress', 'In review', 'Pending', 'Done']);
	assert.equal(statusFromLabel('Status: In review'), 'In review');
	assert.equal(statusFromLabel('Problem: Bug'), null);
});

test('issue lifecycle assigns the documented default status', () => {
	assert.equal(chooseIssueStatus({ action: 'opened', labels: ['Status: In review'] }), 'Backlog');
	assert.equal(chooseIssueStatus({ action: 'reopened', labels: ['Status: Done'] }), 'Backlog');
	assert.equal(chooseIssueStatus({ action: 'closed', labels: ['Status: In progress'] }), 'Done');
});

test('opened pull request events do not add pull request cards to the project', async () => {
	let addCalls = 0;
	const project = { id: 'project-3', statusField: { id: 'status-field' }, options: new Map(), items: [] };
	const client = {
		getProject: async () => project,
		projectItemForIssue: () => undefined,
		addIssueToProject: async () => { addCalls += 1; return 'item-pr-8'; },
	};

	const result = await syncIssueEvent({
		client: client as unknown as Parameters<typeof syncIssueEvent>[0]['client'],
		issue: { node_id: 'pull-request-node-8', number: 8, state: 'open', pull_request: {} },
		action: 'opened',
	});

	assert.deepEqual(result, { action: 'skipped', reason: 'issue-not-in-project' });
	assert.equal(addCalls, 0);
});

test('status label events use the newly added label while it remains on the issue', () => {
	assert.equal(chooseIssueStatus({
		action: 'labeled',
		eventLabel: 'Status: In review',
		labels: ['Status: In review'],
	}), 'In review');
	assert.equal(chooseIssueStatus({
		action: 'labeled',
		eventLabel: 'Status: In review',
		labels: ['Status: Pending'],
	}), 'Pending');
	assert.equal(chooseIssueStatus({ action: 'unlabeled', labels: [] }), 'Backlog');
	assert.equal(chooseIssueStatus({
		action: 'labeled',
		eventLabel: 'Status: Done',
		labels: ['Status: Done', 'Status: Pending'],
	}), 'Done');
	assert.throws(
		() => chooseIssueStatus({ action: 'unlabeled', labels: ['Status: Done', 'Status: Pending'] }),
		/MULTIPLE_STATUS_LABELS/,
	);
});

test('backfill follows one existing label and seeds missing labels from the board', () => {
	assert.deepEqual(backfillStatus({ labels: ['Status: Pending'], boardStatus: 'In progress' }), {
		conflict: false,
		status: 'Pending',
		seedLabel: false,
	});
	assert.deepEqual(backfillStatus({ labels: [], boardStatus: 'In review' }), {
		conflict: false,
		status: 'In review',
		seedLabel: true,
	});
	assert.deepEqual(backfillStatus({ labels: [], boardStatus: null }), {
		conflict: false,
		status: 'Backlog',
		seedLabel: true,
	});
	assert.deepEqual(backfillStatus({ labels: ['Status: Pending', 'Status: Done'], boardStatus: 'Done' }), {
		conflict: true,
		labels: ['Status: Pending', 'Status: Done'],
	});
});

test('status label changes preserve unrelated labels and leave exactly one status', () => {
	assert.deepEqual(statusLabelChanges(['Problem: Bug', 'Status: Backlog'], 'In progress'), {
		add: ['Status: In progress'],
		remove: ['Status: Backlog'],
	});
	assert.deepEqual(statusLabelChanges(['Problem: Bug', 'Status: In progress'], 'In progress'), {
		add: [],
		remove: [],
	});
});

test('label event removes the previous status label and updates the project field', async () => {
	const calls: Array<{ method: string; pathname: string; body?: Record<string, unknown> }> = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		calls.push({ method, pathname: url.pathname, body });

		if (url.pathname === '/graphql') {
			const query = String(body?.query);
			if (query.includes('updateProjectV2ItemFieldValue')) {
				return new Response(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-8' } } } }));
			}
			return new Response(JSON.stringify({
				data: {
					user: {
						projectV2: {
							id: 'project-3',
							fields: { nodes: [{ id: 'status-field', name: 'Status', options: PROJECT_STATUSES.map((name) => ({ id: `option-${name}`, name })) }] },
							items: {
								nodes: [{
									id: 'item-8',
									fieldValues: { nodes: [{ field: { id: 'status-field', name: 'Status' }, name: 'Backlog' }] },
									content: { id: 'issue-node-8' },
								}],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				},
			}));
		}
		if (url.pathname.endsWith('/issues/8')) {
			return new Response(JSON.stringify({
				number: 8,
				node_id: 'issue-node-8',
				labels: [{ name: 'Problem: Bug' }, { name: 'Status: Backlog' }, { name: 'Status: In progress' }],
			}));
		}
		if (method === 'DELETE') return new Response(null, { status: 204 });
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	};
	const client = createProjectStatusClient({
		repository: 'morshoto/framekit',
		token: 'fixture-token',
		fetchImpl,
	});

	const result = await syncIssueEvent({
		client,
		issue: { node_id: 'issue-node-8', number: 8, state: 'open' },
		action: 'labeled',
		eventLabel: 'Status: In progress',
	});

	assert.deepEqual(result, { action: 'updated', status: 'In progress' });
	assert.ok(calls.some((call) => call.method === 'DELETE'
		&& call.pathname.endsWith('/labels/Status%3A%20Backlog')));
	const update = calls.find((call) => String(call.body?.query).includes('updateProjectV2ItemFieldValue'));
	assert.deepEqual(update?.body?.variables, {
		project: 'project-3',
		item: 'item-8',
		field: 'status-field',
		option: 'option-In progress',
	});
});

test('backfill seeds matching project issues without importing PRs or other repositories', async () => {
	const project = {
		id: 'project-3',
		statusField: { id: 'status-field', name: 'Status' },
		options: new Map(PROJECT_STATUSES.map((status) => [status, `option-${status}`])),
		items: [
			{
				id: 'item-8',
				fieldValues: { nodes: [{ field: { id: 'status-field' }, name: 'In progress' }] },
				content: {
					__typename: 'Issue',
					number: 8,
					repository: { nameWithOwner: 'morshoto/framekit' },
					labels: { nodes: [] },
				},
			},
			{
				id: 'item-9',
				fieldValues: { nodes: [] },
				content: { __typename: 'PullRequest', number: 9, repository: { nameWithOwner: 'morshoto/framekit' } },
			},
			{
				id: 'item-10',
				fieldValues: { nodes: [] },
				content: {
					__typename: 'Issue',
					number: 10,
					repository: { nameWithOwner: 'other/repo' },
					labels: { nodes: [] },
				},
			},
		],
	};
	const changes: string[] = [];
	const client = {
		getProject: async () => project,
		readIssue: async (number: number) => ({ number, node_id: `issue-node-${number}`, labels: [] }),
		setIssueStatusLabel: async (_issue: { number: number }, status: string) => { changes.push(`label:${status}`); },
		setProjectStatus: async (_project: unknown, _item: string, status: string, previous: string | null) => {
			changes.push(`board:${previous}->${status}`);
			return previous !== status;
		},
	} as unknown as Parameters<typeof backfillProject>[0]['client'];
	const log = { log: () => {}, error: () => {} };

	const result = await backfillProject({ client, repository: 'morshoto/framekit', log });

	assert.deepEqual(result, { scanned: 1, updated: 1, conflicts: 0 });
	assert.deepEqual(changes, ['label:In progress', 'board:In progress->In progress']);
});

test('workflow uses the dedicated project token and supports event sync plus backfill', async () => {
	const workflow = await readRepositoryFile('.github/workflows/project-status-sync.yml');
	assert.match(workflow, /^\s*issues:\s*$/m);
	assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
	assert.match(workflow, /secrets\.FRAMEKIT_PROJECT_TOKEN/);
	assert.match(workflow, /node scripts\/sync-project-status\.mjs/);
	assert.match(workflow, /cancel-in-progress:\s+false/);
});
