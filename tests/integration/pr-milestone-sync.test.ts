import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	extractIssueReferences,
	resolvePullRequestMilestone,
	syncPullRequestMilestone,
} from '../../scripts/sync-pr-milestone.mjs';

test('extracts unique GitHub issue references from a PR body', () => {
	assert.deepEqual(extractIssueReferences('Refs #123, see also #456 and #123.'), [123, 456]);
	assert.deepEqual(extractIssueReferences('No issue references here.'), []);
});

test('selects the single milestone shared by linked issues', () => {
	const milestone = { id: 21, number: 21, title: 'Release for v0.1.18' };
	assert.deepEqual(
		resolvePullRequestMilestone([
			{ number: 123, milestone },
			{ number: 456, milestone },
		], null),
		{ action: 'update', milestone },
	);
});

test('leaves the PR unchanged when links have no milestone or disagree', () => {
	const first = { id: 21, number: 21, title: 'Release for v0.1.18' };
	const second = { id: 22, number: 22, title: 'Release for v0.1.19' };
	assert.deepEqual(resolvePullRequestMilestone([], null), { action: 'skip', reason: 'no-linked-issues' });
	assert.deepEqual(
		resolvePullRequestMilestone([{ number: 123, milestone: null }], null),
		{ action: 'skip', reason: 'no-linked-milestone' },
	);
	assert.deepEqual(
		resolvePullRequestMilestone([
			{ number: 123, milestone: first },
			{ number: 456, milestone: second },
		], null),
		{ action: 'skip', reason: 'conflicting-milestones' },
	);
});

test('does not write when the PR already has the resolved milestone', () => {
	const milestone = { id: 21, number: 21, title: 'Release for v0.1.18' };
	assert.deepEqual(
		resolvePullRequestMilestone([{ number: 123, milestone }], milestone),
		{ action: 'unchanged', milestone },
	);
});

test('updates a PR only after GitHub confirms the issue cross-reference', async () => {
	const requests: Array<{ url: string; method: string; body?: unknown }> = [];
	const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		const method = init.method ?? 'GET';
		requests.push({ url, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (url.endsWith('/issues/22') && method === 'GET') {
			return jsonResponse({ number: 22, milestone: null, pull_request: { url: 'https://api.github.com/repos/acme/framekit/pulls/22' } });
		}
		if (url.endsWith('/issues/123') && method === 'GET') {
			return jsonResponse({ number: 123, milestone: { id: 21, number: 21, title: 'Release for v0.1.18' } });
		}
		if (url.endsWith('/issues/123/timeline?per_page=100')) {
			return jsonResponse([{
				event: 'cross-referenced',
				source: { issue: { number: 22, pull_request: { url: 'https://api.github.com/repos/acme/framekit/pulls/22' } } },
			}]);
		}
		if (url.endsWith('/issues/22') && method === 'PATCH') {
			return jsonResponse({ number: 22, milestone: { number: 21 } });
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	};

	const result = await syncPullRequestMilestone({
		repository: 'acme/framekit',
		pullRequestNumber: 22,
		body: 'Refs #123',
		token: 'test-token',
		apiUrl: 'https://api.github.com',
		fetchImpl,
	});

	assert.deepEqual(result, { action: 'updated', milestoneNumber: 21 });
	assert.ok(requests.some(({ method, url, body }) => method === 'PATCH' && url.endsWith('/issues/22') && (body as any).milestone === 21));
});

test('ignores body references that GitHub has not linked to the PR', async () => {
	const requests: Array<{ url: string; method: string }> = [];
	const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		const method = init.method ?? 'GET';
		requests.push({ url, method });
		if (url.endsWith('/issues/22')) {
			return jsonResponse({ number: 22, milestone: null, pull_request: { url: 'https://api.github.com/repos/acme/framekit/pulls/22' } });
		}
		if (url.endsWith('/issues/123')) {
			return jsonResponse({ number: 123, milestone: { id: 21, number: 21, title: 'Release for v0.1.18' } });
		}
		if (url.endsWith('/issues/123/timeline?per_page=100')) return jsonResponse([]);
		throw new Error(`Unexpected request: ${method} ${url}`);
	};

	const result = await syncPullRequestMilestone({
		repository: 'acme/framekit',
		pullRequestNumber: 22,
		body: 'A plain #123 mention is not enough by itself.',
		token: 'test-token',
		apiUrl: 'https://api.github.com',
		fetchImpl,
	});

	assert.deepEqual(result, { action: 'skip', reason: 'no-linked-issues' });
	assert.equal(requests.some(({ method }) => method === 'PATCH'), false);
});

test('rechecks PR body edits with write permission for milestones', async () => {
	const workflow = await readFile(new URL('../../.github/workflows/assign.yml', import.meta.url), 'utf8');
	assert.match(workflow, /types:\s*\[[^\]]*edited/);
	assert.match(workflow, /pull_request_target:\s*\n\s+types:/);
	assert.match(workflow, /sync-pull-request-milestone:/);
	assert.match(workflow, /head\.repo\.full_name == github\.repository/);
	assert.match(workflow, /head\.repo\.full_name != github\.repository/);
	assert.match(workflow, /ref:\s*\$\{\{\s*github\.sha\s*\}\}/);
	assert.match(workflow, /pull-requests:\s*write/);
});

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}
