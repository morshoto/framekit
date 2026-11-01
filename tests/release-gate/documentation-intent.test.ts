import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	collectDocumentationPaths,
	fetchPullRequestSnapshot,
	validateDocumentationIntent,
} from '../../scripts/check-documentation-intent.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('does not require a declaration when a PR changes no documentation', () => {
	assert.deepEqual(collectDocumentationPaths(['src/app.ts', 'package.json']), []);
	assert.deepEqual(validateDocumentationIntent([], ''), { valid: true });
});

test('recognizes root guidance and documentation-tree files in mixed changes', () => {
	assert.deepEqual(
		collectDocumentationPaths([
			'src/app.ts',
			'AGENTS.md',
			'CONTRIBUTING.md',
			'README.md',
			'docs/generated/catalog.json',
			'packages/runtime/README.mdx',
		]),
		[
			'AGENTS.md',
			'CONTRIBUTING.md',
			'README.md',
			'docs/generated/catalog.json',
			'packages/runtime/README.mdx',
		],
	);
});

test('rejects changed documentation without an explicit intent declaration', () => {
	const result = validateDocumentationIntent(['README.md'], 'Summary: tidy up');
	assert.equal(result.valid, false);
	assert.match(result.message, /Documentation intent:/);
});

test('accepts a complete declaration for docs-only and mixed changes', () => {
	const body = [
		'Documentation intent: intentional',
		'Documentation paths: README.md, docs/architecture.md',
		'Documentation purpose: Explain the supported workflow change.',
		'Documentation minimality: Update the existing canonical section only.',
	].join('\n');
	assert.deepEqual(
		validateDocumentationIntent(
			['README.md', 'docs/architecture.md'],
			body,
		),
		{ valid: true },
	);
});

test('rejects declarations that omit changed docs or name unchanged docs', () => {
	const omitted = validateDocumentationIntent(
		['README.md', 'CONTRIBUTING.md'],
		[
			'Documentation intent: intentional',
			'Documentation paths: README.md',
			'Documentation purpose: Clarify setup.',
			'Documentation minimality: Update one section.',
		].join('\n'),
	);
	assert.equal(omitted.valid, false);
	assert.match(omitted.message, /CONTRIBUTING\.md/);

	const unchanged = validateDocumentationIntent(
		['README.md'],
		[
			'Documentation intent: intentional',
			'Documentation paths: README.md, CONTRIBUTING.md',
			'Documentation purpose: Clarify setup.',
			'Documentation minimality: Update one section.',
		].join('\n'),
	);
	assert.equal(unchanged.valid, false);
	assert.match(unchanged.message, /CONTRIBUTING\.md/);
});

test('rejects empty and whitespace-only intent, purpose, and minimality values', () => {
	for (const field of ['intent', 'purpose', 'minimality']) {
		for (const value of ['', '   ']) {
			const declaration = {
				intent: 'intentional',
				paths: 'README.md',
				purpose: 'Clarify the changed user-facing setup.',
				minimality: 'Update only the existing setup section.',
				[field]: value,
			};
			const body = [
				`Documentation intent: ${declaration.intent}`,
				`Documentation paths: ${declaration.paths}`,
				`Documentation purpose: ${declaration.purpose}`,
				`Documentation minimality: ${declaration.minimality}`,
			].join('\n');
			assert.equal(
				validateDocumentationIntent(['README.md'], body).valid,
				false,
				`${field} must not be empty or whitespace-only`,
			);
		}
	}
});

test('allows the one-time multi-file docs migration with a linked issue', () => {
	const body = [
		'Documentation intent: intentional',
		'Documentation paths: docs/**',
		'Documentation purpose: One-time consolidation tracked by [#572](https://github.com/morshoto/framekit/issues/572).',
		'Documentation minimality: Retain only the five canonical files and preserve unique evidence.',
	].join('\n');
	assert.deepEqual(
		validateDocumentationIntent(
			['docs/README.md', 'docs/adr/001.md', 'docs/testing.md'],
			body,
		),
		{ valid: true },
	);
});

test('requires the #572 reference when a docs-wide path is declared', () => {
	const result = validateDocumentationIntent(
		['docs/README.md', 'docs/adr/001.md'],
		[
			'Documentation intent: intentional',
			'Documentation paths: docs/**',
			'Documentation purpose: Consolidate documentation.',
			'Documentation minimality: Keep only the canonical documents.',
		].join('\n'),
	);
	assert.equal(result.valid, false);
	assert.match(result.message, /#572/);
});

test('requires purpose and minimality explanations for changed documentation', () => {
	const result = validateDocumentationIntent(
		['CONTRIBUTING.md'],
		[
			'Documentation intent: intentional',
			'Documentation paths: CONTRIBUTING.md',
		].join('\n'),
	);
	assert.equal(result.valid, false);
	assert.match(result.message, /purpose/i);
	assert.match(result.message, /minimality/i);
});

test('reads the current PR body and all changed files through read-only API calls', async () => {
	const requests: Array<{ url: string; method: string; authHeader: string | null }> = [];
	const fetchImpl: typeof fetch = async (input, init = {}) => {
		const url = String(input);
		const headers = new Headers(init.headers);
		requests.push({
			url,
			method: init.method ?? 'GET',
		authHeader: headers.get('authorization'),
		});
		if (url.endsWith('/pulls/17')) {
			return jsonResponse({ number: 17, body: 'Current PR body from GitHub.' });
		}
		if (url.endsWith('/pulls/17/files?per_page=100&page=1')) {
			return jsonResponse(Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` })));
		}
		if (url.endsWith('/pulls/17/files?per_page=100&page=2')) {
			return jsonResponse([{ filename: 'docs/testing.md' }]);
		}
		throw new Error(`Unexpected API request: ${url}`);
	};

	const snapshot = await fetchPullRequestSnapshot({
		repository: 'morshoto/framekit',
		pullRequestNumber: 17,
		token: 'x',
		apiUrl: 'https://api.github.test',
		fetchImpl,
	});

	assert.equal(snapshot.body, 'Current PR body from GitHub.');
	assert.equal(snapshot.files.length, 101);
	assert.equal(snapshot.files.at(-1), 'docs/testing.md');
	assert.equal(requests.length, 3);
	assert.ok(requests.every((request) => request.authHeader === 'Bearer x'));
	assert.ok(requests.every((request) => request.method === 'GET'));
});

test('fails closed when GitHub does not provide the PR diff', async () => {
	const fetchImpl: typeof fetch = async () => new Response('private error details', { status: 403 });
	await assert.rejects(
		fetchPullRequestSnapshot({
			repository: 'morshoto/framekit',
			pullRequestNumber: 17,
			token: 'x',
			apiUrl: 'https://api.github.test',
			fetchImpl,
		}),
		(error: Error) => {
			assert.match(error.message, /returned 403/);
			assert.doesNotMatch(error.message, /private error details/);
			return true;
		},
	);
});

test('lets code-only PRs use the template without filling a docs declaration', async () => {
	const template = await readFile(
		resolve(repositoryRoot, '.github/pull_request_template.md'),
		'utf8',
	);
	assert.match(template, /Docs: not needed \(state why\)/);
	assert.deepEqual(validateDocumentationIntent(['src/app.ts'], template), { valid: true });
	assert.equal(validateDocumentationIntent(['CONTRIBUTING.md'], template).valid, false);
});

test('does not accept declarations left inside an unfinished HTML comment', () => {
	const body = [
		'<!-- Documentation example left open',
		'Documentation intent: intentional',
		'Documentation paths: README.md',
		'Documentation purpose: Clarify the changed setup.',
		'Documentation minimality: Update the smallest relevant section.',
	].join('\n');
	assert.equal(validateDocumentationIntent(['README.md'], body).valid, false);
});

test('contributor guidance limits docs changes to the four stated triggers', async () => {
	const [agents, contributing] = await Promise.all([
		readFile(resolve(repositoryRoot, 'AGENTS.md'), 'utf8'),
		readFile(resolve(repositoryRoot, 'CONTRIBUTING.md'), 'utf8'),
	]);
	for (const guidance of [agents, contributing]) {
		const normalizedGuidance = guidance.replace(/\s+/g, ' ');
		assert.match(normalizedGuidance, /user-facing setup or commands/);
		assert.match(normalizedGuidance, /public MCP/);
		assert.match(normalizedGuidance, /architecture.*capability boundaries/);
		assert.match(normalizedGuidance, /release process/);
		assert.match(
			normalizedGuidance,
			/unchanged external behavior do not (?:require documentation edits|need a docs edit)/,
		);
		assert.doesNotMatch(guidance, /Update documentation when moving files/);
	}
	assert.match(contributing, /TDD plans, detailed QA transcripts, run logs/);
	assert.match(contributing, /smallest relevant section/);
});

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}
