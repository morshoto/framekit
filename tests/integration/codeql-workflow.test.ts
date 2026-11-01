import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function readRepositoryFile(relativePath: string): Promise<string> {
	return readFile(resolve(repository, relativePath), 'utf8');
}

/** Extract a job without assuming two-space or four-space YAML indentation. */
function getJob(workflow: string, jobName: string): string | undefined {
	const lines = workflow.split(/\r?\n/);
	const jobsLine = lines.findIndex((line) => /^jobs:\s*$/.test(line));
	if (jobsLine < 0) return undefined;

	let start = -1;
	let indentation = -1;
	for (let i = jobsLine + 1; i < lines.length; i++) {
		const match = lines[i].match(/^([ \t]+)([a-z][a-z0-9-]*):\s*$/);
		if (match?.[2] === jobName) {
			start = i;
			indentation = match[1].length;
			break;
		}
	}
	if (start < 0) return undefined;

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const match = lines[i].match(/^([ \t]+)([a-z][a-z0-9-]*):\s*$/);
		if (match && match[1].length === indentation) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

test('CodeQL keeps default-branch runs from being cancelled', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');

	assert.match(
		workflow,
		/group:\s+codeql-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.number \|\| github\.run_id \}\}/,
	);
	assert.match(
		workflow,
		/cancel-in-progress:\s+\$\{\{ github\.event_name == 'pull_request' \}\}/,
	);
});

test('CodeQL runs on ready pull requests without scanning each draft push', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	assert.match(workflow, /^\s+pull_request:\s*$/m);
	for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
		assert.match(workflow, new RegExp('^\\s+- ' + action + '$', 'm'));
	}
	assert.match(workflow, /^\s*workflow_call:/m);
	assert.doesNotMatch(workflow, /\n\s+- converted_to_draft\n/);
});

test('CodeQL retains both analysis jobs for default-branch runs', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const javascriptJob = getJob(workflow, 'analyze');
	const swiftJob = getJob(workflow, 'analyze-swift');

	assert.ok(
		javascriptJob,
		'JavaScript/TypeScript CodeQL job should be present',
	);
	assert.ok(swiftJob, 'Swift CodeQL job should be present');
	assert.match(
		javascriptJob,
		/name: Analyze \(\$\{\{ matrix\.language \}\}\)/,
	);
	assert.match(javascriptJob, /language: javascript-typescript/);
	assert.match(javascriptJob, /needs: detect-changes/);
	assert.match(javascriptJob, /needs\.detect-changes\.outputs\.run_codeql == 'true'/);
	assert.match(swiftJob, /name: Analyze \(swift\)/);
	assert.match(swiftJob, /needs: detect-changes/);
	assert.match(swiftJob, /needs\.detect-changes\.outputs\.swift == 'true'/);
	assert.doesNotMatch(workflow, /\n  changes:\n|needs: changes/);
});

test('detect-changes gates Swift while preserving full weekly and manual scans', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const detectorJob = getJob(workflow, 'detect-changes');
	const javascriptJob = getJob(workflow, 'analyze');
	const swiftJob = getJob(workflow, 'analyze-swift');
	assert.ok(detectorJob && javascriptJob && swiftJob);
	assert.match(detectorJob, /name: Detect CodeQL scope/);
	assert.match(detectorJob, /pull-requests: read/);
	assert.match(detectorJob, /node \.github\/codeql\/detect-changes\.mjs/);
	assert.match(javascriptJob, /needs\.detect-changes\.outputs\.run_codeql == 'true'/);
	assert.match(swiftJob, /needs\.detect-changes\.outputs\.swift == 'true'/);
	assert.match(swiftJob, /category: \/language:swift/);

	const detector = await import(new URL('../../.github/codeql/detect-changes.mjs', import.meta.url).href) as {
		affectsSwift: (paths: string[]) => boolean;
		selectScans: (options: { eventName: string; draft?: boolean; paths?: string[] | null }) => {
			runCodeQL: boolean; swift: boolean;
		};
	};
	for (const file of [
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/project.yml',
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift',
		'.github/codeql/FinalCutWorkflowExtensionShim.swift',
		'.github/workflows/codeql.yml',
		'.github/workflows/ci.yml',
		'other/SomeFeature.swift',
	]) {
		assert.equal(detector.affectsSwift([file]), true, file);
	}
	assert.equal(detector.affectsSwift(['README.md', 'packages/runtime/src/model.ts']), false);
	assert.deepEqual(detector.selectScans({ eventName: 'pull_request', draft: true, paths: ['file.swift'] }), { runCodeQL: false, swift: false });
	assert.deepEqual(detector.selectScans({ eventName: 'pull_request', paths: ['packages/runtime/src/model.ts'] }), { runCodeQL: true, swift: false });
	assert.deepEqual(detector.selectScans({ eventName: 'push', paths: ['README.md'] }), { runCodeQL: true, swift: false });
	assert.deepEqual(detector.selectScans({ eventName: 'pull_request', paths: [] }), { runCodeQL: true, swift: true });
	for (const eventName of ['schedule', 'workflow_dispatch']) {
		assert.deepEqual(detector.selectScans({ eventName }), { runCodeQL: true, swift: true });
	}
});

test('CodeQL preserves JavaScript analysis and adds a bounded Swift job', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');

	assert.match(workflow, /language: javascript-typescript/);
	assert.match(workflow, /build-mode: none/);
	assert.match(workflow, /os: ubuntu-latest/);
	assert.match(workflow, /analyze-swift:/);
	assert.match(workflow, /name: Analyze \(swift\)/);
	assert.match(workflow, /runs-on: macos-26/);
	assert.match(workflow, /timeout-minutes: 40/);
	assert.match(workflow, /languages: swift/);
	assert.match(workflow, /build-mode: manual/);
	assert.match(workflow, /timeout-minutes: 25/);
	assert.match(
		workflow,
		/\n[ \t]+- name: Type-check Swift sources for CodeQL extraction\n[ \t]+timeout-minutes: 25\n[ \t]+run: bash \.github\/codeql\/typecheck-swift\.sh/,
	);
});

test('CodeQL waits for remote processing before policy evaluation', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const javascriptJob = getJob(workflow, 'analyze');
	const swiftJob = getJob(workflow, 'analyze-swift');

	assert.ok(javascriptJob && swiftJob, 'CodeQL analysis jobs should be present');
	assert.match(
		javascriptJob,
		/name: Analyze with CodeQL[\s\S]*?wait-for-processing: true/,
	);
	assert.match(swiftJob, /name: Analyze with CodeQL[\s\S]*?wait-for-processing: true/);
	assert.doesNotMatch(javascriptJob, /wait-for-processing: false/);
});

test('the pull request CodeQL job does not execute its policy from PR code', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const job = getJob(workflow, 'analyze');
	assert.ok(job);
	assert.doesNotMatch(job, /verify-policy\.mjs/);
	const security = await readRepositoryFile('.github/workflows/security.yml');
	const gate = getJob(security, 'pull-request-policy');
	assert.ok(gate, 'trusted pull-request policy job should be present');
	assert.match(gate, /node \.github\/codeql\/post-codeql-policy-check\.mjs/);
	assert.match(gate, /statuses: write/);
});

test('trusted policy reports failures on head and merge commits', async () => {
	const { evaluatePullRequest } = await import(
		new URL('../../.github/codeql/post-codeql-policy-check.mjs', import.meta.url).href
	) as { evaluatePullRequest: (input: Record<string, unknown>) => Promise<void> };
	const head = 'a'.repeat(40);
	const merge = 'b'.repeat(40);
	const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/pulls/7')) {
			return Response.json({ state: 'open', draft: false, base: { ref: 'main', sha: 'c'.repeat(40) }, head: { sha: head }, merge_commit_sha: merge });
		}
		if (url.pathname.includes('/statuses/')) {
			posts.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
			return Response.json({});
		}
		throw new Error(`Unexpected URL: ${url}`);
	}) as typeof fetch;
	try {
		await evaluatePullRequest({ apiUrl: 'https://api.github.com', repository: 'o/r', token: 'test',
			workflowRun: { head_sha: head, conclusion: 'failure', html_url: 'https://example.com/run' },
			pullRequestNumber: 7, expectedHeadSha: head });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(posts.map(({ path, body }) => [path, body.state, body.context]), [
		[`/repos/o/r/statuses/${head}`, 'pending', 'CodeQL PR policy'],
		[`/repos/o/r/statuses/${merge}`, 'pending', 'CodeQL PR policy'],
		[`/repos/o/r/statuses/${head}`, 'failure', 'CodeQL PR policy'],
		[`/repos/o/r/statuses/${merge}`, 'failure', 'CodeQL PR policy'],
	]);
});

test('trusted policy reports success only after current analysis is verified', async () => {
	const { evaluatePullRequest } = await import(
		new URL('../../.github/codeql/post-codeql-policy-check.mjs', import.meta.url).href
	) as { evaluatePullRequest: (input: Record<string, unknown>) => Promise<void> };
	const head = 'a'.repeat(40), merge = 'b'.repeat(40), base = 'c'.repeat(40);
	const pull = { state: 'open', draft: false, base: { ref: 'main', sha: base }, head: { sha: head }, merge_commit_sha: merge };
	const posts: Array<{ path: string; state: string }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/pulls/7')) return Response.json(pull);
		if (url.pathname.endsWith('/branches/main')) return Response.json({ commit: { sha: base } });
		if (url.pathname.endsWith('/code-scanning/alerts')) return Response.json([]);
		if (url.pathname.endsWith('/code-scanning/analyses/42')) return Response.json({ runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [] }] });
		if (url.pathname.endsWith('/code-scanning/analyses')) {
			const ref = url.searchParams.get('ref');
			return Response.json([{ id: 42, ref, commit_sha: ref === 'refs/heads/main' ? base : merge,
				category: '/language:javascript-typescript', tool: { name: 'CodeQL' }, rules_count: 87, results_count: 0 }]);
		}
		if (url.pathname.includes('/statuses/')) {
			posts.push({ path: url.pathname, state: JSON.parse(String(init?.body)).state });
			return Response.json({});
		}
		throw new Error(`Unexpected URL: ${url}`);
	}) as typeof fetch;
	try {
		await evaluatePullRequest({ apiUrl: 'https://api.github.com', repository: 'o/r', token: 'test',
			workflowRun: { head_sha: head, conclusion: 'success', html_url: 'https://example.com/run' },
			pullRequestNumber: 7, expectedHeadSha: head });
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(posts, [
		{ path: `/repos/o/r/statuses/${head}`, state: 'pending' },
		{ path: `/repos/o/r/statuses/${merge}`, state: 'pending' },
		{ path: `/repos/o/r/statuses/${head}`, state: 'success' },
		{ path: `/repos/o/r/statuses/${merge}`, state: 'success' },
	]);
});

test('the trusted policy gate accepts only current CodeQL pull request runs', async () => {
	const { pullRequestsForCodeQLRun } = await import(
		new URL('../../.github/codeql/post-codeql-policy-check.mjs', import.meta.url).href
	) as { pullRequestsForCodeQLRun: (run: Record<string, unknown>) => Array<{ number: number; headSha: string }> };
	const run = {
		event: 'pull_request', path: '.github/workflows/codeql.yml', head_sha: 'head-sha',
		pull_requests: [{ number: 7, head: { sha: 'head-sha' } }],
	};
	assert.deepEqual(pullRequestsForCodeQLRun(run), [{ number: 7, headSha: 'head-sha' }]);
	assert.deepEqual(pullRequestsForCodeQLRun({ ...run, path: '.github/workflows/other.yml' }), []);
	assert.deepEqual(pullRequestsForCodeQLRun({ ...run, event: 'push' }), []);
	assert.deepEqual(pullRequestsForCodeQLRun({ ...run, pull_requests: [{ number: 7, head: { sha: 'stale' } }] }), []);
});

test('a Swift-only finding does not block the JavaScript PR policy', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as { evaluateCodeQLPolicy: (input: Record<string, unknown>) => { pass: boolean; reasons: string[] } };
	const result = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha', pullRequestHeadSha: 'head-sha', pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{ ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:javascript-typescript', error: '', rules_count: 87, tool: { name: 'CodeQL' } }],
		pullRequestAlerts: [{ number: 9, state: 'open', rule: { severity: 'warning', security_severity_level: 'high' }, instances: [{ ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:swift', state: 'open' }] }],
		baseAlerts: [],
	});
	assert.deepEqual(result, { pass: true, reasons: [] });
});

test('the JavaScript policy blocks a new current high-severity finding', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as { evaluateCodeQLPolicy: (input: Record<string, unknown>) => { pass: boolean; reasons: string[] } };
	const result = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha', pullRequestHeadSha: 'head-sha', pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{ ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:javascript-typescript', error: '', rules_count: 87, tool: { name: 'CodeQL' } }],
		pullRequestAlerts: [{ number: 9, state: 'open', rule: { severity: 'warning', security_severity_level: 'high' }, instances: [{ ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:javascript-typescript', state: 'open' }] }],
		baseAlerts: [],
	});
	assert.equal(result.pass, false);
	assert.match(result.reasons.join('\n'), /1 new CodeQL alert/);
});

test('the JavaScript policy requires current base analysis and handles fixed alerts on PRs', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as { evaluateCodeQLPolicy: (input: Record<string, unknown>) => { pass: boolean; reasons: string[] } };
	const analysis = { ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:javascript-typescript', error: '', rules_count: 87, tool: { name: 'CodeQL' } };
	const baseline = { ...analysis, ref: 'refs/heads/main', commit_sha: 'base-sha' };
	const input = { workflowHeadSha: 'head-sha', pullRequestHeadSha: 'head-sha', pullRequestNumber: 7,
		mergeSha: 'merge-sha', analyses: [analysis], pullRequestAlerts: [], baseAlerts: [],
		baseSha: 'base-sha', baseRef: 'refs/heads/main', baseAnalyses: [baseline] };
	assert.equal(evaluateCodeQLPolicy(input).pass, true);
	assert.equal(evaluateCodeQLPolicy({ ...input, baseAnalyses: [{ ...baseline, commit_sha: 'old' }] }).pass, false);
	const fixedOnMain = { number: 8, state: 'fixed', rule: { severity: 'warning', security_severity_level: 'high' },
		instances: [{ ref: 'refs/pull/7/merge', commit_sha: 'merge-sha', category: '/language:javascript-typescript', state: 'open' }] };
	assert.equal(evaluateCodeQLPolicy({ ...input, pullRequestAlerts: [fixedOnMain] }).pass, false);
	assert.equal(evaluateCodeQLPolicy({ ...input, pullRequestAlerts: [{ ...fixedOnMain, instances: [{ ...fixedOnMain.instances[0], state: 'fixed' }] }] }).pass, true);
	const inherited = { number: 8, state: 'open', most_recent_instance: { ref: 'refs/heads/main', commit_sha: 'base-sha', state: 'open' } };
	assert.equal(evaluateCodeQLPolicy({ ...input, pullRequestAlerts: [fixedOnMain], baseAlerts: [inherited] }).pass, true);
	assert.equal(evaluateCodeQLPolicy({ ...input, pullRequestAlerts: [fixedOnMain], baseAlerts: [{ ...inherited, most_recent_instance: { ...inherited.most_recent_instance, commit_sha: 'old' } }] }).pass, false);
});

test('release policy requires current Swift analysis and blocks open serious findings', async () => {
	const { evaluateSwiftReleasePolicy } = await import(
		new URL('../../.github/codeql/verify-release-policy.mjs', import.meta.url).href
	) as { evaluateSwiftReleasePolicy: (input: Record<string, unknown>) => { pass: boolean; reasons: string[] } };
	const analysis = { ref: 'refs/tags/v1.2.3', commit_sha: 'release-sha', category: '/language:swift', error: '', rules_count: 27, tool: { name: 'CodeQL' } };
	const finding = { number: 11, state: 'open', rule: { severity: 'warning', security_severity_level: 'high' }, most_recent_instance: { ref: 'refs/tags/v1.2.3', commit_sha: 'release-sha', category: '/language:swift', state: 'open' } };
	const input = { ref: 'refs/tags/v1.2.3', expectedSha: 'release-sha', analyses: [analysis], alerts: [] };
	assert.equal(evaluateSwiftReleasePolicy(input).pass, true);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [finding] }).pass, false);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [{ ...finding, state: 'dismissed' }] }).pass, true);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [{ ...finding, state: 'fixed' }] }).pass, false);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [{ ...finding, most_recent_instance: { ...finding.most_recent_instance, state: 'fixed' } }] }).pass, true);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [{ ...finding, rule: {} }] }).pass, false);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, analyses: [{ ...analysis, commit_sha: 'old-sha' }] }).pass, false);
	assert.equal(evaluateSwiftReleasePolicy({ ...input, alerts: [{ ...finding, most_recent_instance: undefined }] }).pass, false);
});

test('release analysis must map every SARIF finding to a GitHub alert', async () => {
	const { extractCodeQLAlertNumbers } = await import(
		new URL('../../.github/codeql/sarif-evidence.mjs', import.meta.url).href
	) as { extractCodeQLAlertNumbers: (sarif: unknown, resultsCount: number) => number[] };
	const sarif = { runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [{ properties: { 'github/alertNumber': 6 } }] }] };
	assert.deepEqual(extractCodeQLAlertNumbers(sarif, 1), [6]);
	assert.throws(() => extractCodeQLAlertNumbers(sarif, 2), /result count/i);
	assert.throws(() => extractCodeQLAlertNumbers({ runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [{}] }] }, 1), /alert number/i);
});

test('post-merge security calls reusable CodeQL and release publishing requires Swift evidence', async () => {
	const codeql = await readRepositoryFile('.github/workflows/codeql.yml');
	const security = await readRepositoryFile('.github/workflows/security.yml');
	const release = await readRepositoryFile('.github/workflows/release.yml');
	assert.match(codeql, /^\s+workflow_call:/m);
	assert.match(security, /^\s+push:/m);
	assert.match(security, /^\s+schedule:/m);
	assert.match(security, /^\s+workflow_dispatch:/m);
	assert.match(security, /^\s+workflow_run:/m);
	assert.match(security, /^\s+workflows:\s*\n\s+- CodeQL$/m);
	assert.match(security, /uses: \.\/\.github\/workflows\/codeql\.yml/);
	assert.match(security, /issues: write/);
	assert.match(security, /queue: max/);
	assert.match(release, /verify-release-policy\.mjs/);
	const publish = getJob(release, 'publish-npm');
	assert.ok(publish);
	assert.match(publish, /- swift-release-gate/);
});

test('security failure reporting identifies repeated attempts without duplicating comments', async () => {
	const { failureReport, hasReportedAttempt, isReportingIssue } = await import(
		new URL('../../.github/codeql/report-security-failure.mjs', import.meta.url).href
	) as {
		failureReport: (input: Record<string, string>) => string;
		hasReportedAttempt: (comments: Array<{ body?: string; user?: { login?: string } }>, runId: string, attempt: string) => boolean;
		isReportingIssue: (issue: { title: string; pull_request?: unknown; user?: { login?: string } }) => boolean;
	};
	const body = failureReport({ sha: 'abc123', runId: '42', attempt: '2', serverUrl: 'https://github.com', repository: 'owner/repo', codeql: 'failure', deep: 'success', consumer: 'success' });
	assert.match(body, /abc123/);
	assert.match(body, /https:\/\/github\.com\/owner\/repo\/actions\/runs\/42/);
	assert.equal(hasReportedAttempt([{ body, user: { login: 'github-actions[bot]' } }], '42', '2'), true);
	assert.equal(hasReportedAttempt([{ body, user: { login: 'contributor' } }], '42', '2'), false);
	assert.equal(hasReportedAttempt([{ body, user: { login: 'github-actions[bot]' } }], '42', '3'), false);
	assert.equal(isReportingIssue({ title: '[security-ci] Post-push checks failing', user: { login: 'github-actions[bot]' } }), true);
	assert.equal(isReportingIssue({ title: '[security-ci] Post-push checks failing', user: { login: 'contributor' } }), false);
	assert.equal(isReportingIssue({ title: '[security-ci] Post-push checks failing', pull_request: {}, user: { login: 'github-actions[bot]' } }), false);
});

test('CodeQL policy accepts a current JavaScript scan when Swift is unchanged', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as {
		evaluateCodeQLPolicy: (input: {
			workflowHeadSha: string;
			pullRequestHeadSha: string;
			pullRequestNumber: number;
			mergeSha: string;
			analyses: Array<Record<string, unknown>>;
			pullRequestAlerts: Array<Record<string, unknown>>;
			baseAlerts: Array<Record<string, unknown>>;
		}) => { pass: boolean; reasons: string[] };
	};
	const result = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{
			ref: 'refs/pull/7/merge',
			commit_sha: 'merge-sha',
			category: '/language:javascript-typescript',
			error: '',
			rules_count: 87,
			tool: { name: 'CodeQL' },
		}],
		pullRequestAlerts: [],
		baseAlerts: [],
	});

	assert.deepEqual(result, { pass: true, reasons: [] });
});

test('CodeQL policy rejects stale scans and newly introduced blocking alerts', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as {
		evaluateCodeQLPolicy: (input: {
			workflowHeadSha: string;
			pullRequestHeadSha: string;
			pullRequestNumber: number;
			mergeSha: string;
			analyses: Array<Record<string, unknown>>;
			pullRequestAlerts: Array<Record<string, unknown>>;
			baseAlerts: Array<Record<string, unknown>>;
		}) => { pass: boolean; reasons: string[] };
	};
	const javascript = {
		ref: 'refs/pull/7/merge',
		commit_sha: 'old-merge-sha',
		category: '/language:javascript-typescript',
		error: '',
		rules_count: 87,
		tool: { name: 'CodeQL' },
	};
	const stale = evaluateCodeQLPolicy({
		workflowHeadSha: 'old-head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [javascript],
		pullRequestAlerts: [],
		baseAlerts: [],
	});
	assert.equal(stale.pass, false);
	assert.match(stale.reasons.join('\n'), /head|current/i);

	const newHighAlert = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{ ...javascript, commit_sha: 'merge-sha' }],
		pullRequestAlerts: [{
			number: 9,
			state: 'open',
			rule: { severity: 'warning', security_severity_level: 'high' },
		}],
		baseAlerts: [],
	});
	assert.equal(newHighAlert.pass, false);
	assert.match(newHighAlert.reasons.join('\n'), /alert/i);

	const analysisError = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{ ...javascript, commit_sha: 'merge-sha', error: 'extraction failed' }],
		pullRequestAlerts: [],
		baseAlerts: [],
	});
	assert.equal(analysisError.pass, false);
	assert.match(analysisError.reasons.join('\n'), /failed/i);

	const newErrorAlert = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{ ...javascript, commit_sha: 'merge-sha' }],
		pullRequestAlerts: [{
			number: 10,
			state: 'open',
			rule: { severity: 'error' },
		}],
		baseAlerts: [],
	});
	assert.equal(newErrorAlert.pass, false);
});

test('CodeQL policy rejects invalid pull request identity', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as {
		evaluateCodeQLPolicy: (input: {
			workflowHeadSha: string;
			pullRequestHeadSha: string;
			pullRequestNumber: number;
			mergeSha: string;
			analyses: Array<Record<string, unknown>>;
			pullRequestAlerts: Array<Record<string, unknown>>;
			baseAlerts: Array<Record<string, unknown>>;
		}) => { pass: boolean; reasons: string[] };
	};
	const result = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 0,
		mergeSha: 'merge-sha',
		analyses: [],
		pullRequestAlerts: [],
		baseAlerts: [],
	});

	assert.equal(result.pass, false);
	assert.match(result.reasons.join('\n'), /pull request number/i);
});

test('CodeQL policy ignores inherited alerts below current thresholds', async () => {
	const { evaluateCodeQLPolicy } = await import(
		new URL('../../.github/codeql/verify-policy.mjs', import.meta.url).href
	) as {
		evaluateCodeQLPolicy: (input: {
			workflowHeadSha: string;
			pullRequestHeadSha: string;
			pullRequestNumber: number;
			mergeSha: string;
			analyses: Array<Record<string, unknown>>;
			pullRequestAlerts: Array<Record<string, unknown>>;
			baseAlerts: Array<Record<string, unknown>>;
		}) => { pass: boolean; reasons: string[] };
	};
	const result = evaluateCodeQLPolicy({
		workflowHeadSha: 'head-sha',
		pullRequestHeadSha: 'head-sha',
		pullRequestNumber: 7,
		mergeSha: 'merge-sha',
		analyses: [{
			ref: 'refs/pull/7/merge',
			commit_sha: 'merge-sha',
			category: '/language:javascript-typescript',
			error: '',
			rules_count: 87,
			tool: { name: 'CodeQL' },
		}],
		pullRequestAlerts: [{
			number: 11,
			state: 'open',
			rule: { severity: 'warning', security_severity_level: 'medium' },
		}, {
			number: 12,
			state: 'open',
			rule: { severity: 'warning', security_severity_level: 'medium' },
		}],
		baseAlerts: [{
			number: 11,
			state: 'open',
			rule: { severity: 'warning', security_severity_level: 'medium' },
		}],
	});

	assert.deepEqual(result, { pass: true, reasons: [] });
});

test('Swift CodeQL extraction uses the checked-in shim only', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const project = await readRepositoryFile(
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/project.yml',
	);
	const swiftJob = getJob(workflow, 'analyze-swift');
	const compilerScript = await readRepositoryFile('.github/codeql/typecheck-swift.sh');

	assert.ok(swiftJob, 'Swift CodeQL job should be present');

	assert.match(swiftJob, /run: bash \.github\/codeql\/typecheck-swift\.sh/);
	assert.match(compilerScript, /xcrun --sdk macosx swiftc/);
	assert.match(compilerScript, /-typecheck/);
	assert.match(compilerScript, /-parse-as-library/);
	assert.match(compilerScript, /-target \"\$\(uname -m\)-apple-macos15\.0\"/);
	assert.match(compilerScript, /-swift-version 5/);
	assert.match(swiftJob, /timeout-minutes: 40/);
	assert.match(swiftJob, /timeout-minutes: 25/);

	assert.match(compilerScript, /-D FRAMEKIT_CODEQL/);
	assert.match(compilerScript, /\.github\/codeql\/FinalCutWorkflowExtensionShim\.swift/);
	assert.match(compilerScript, /FinalCutLiveWorkflowExtension\.swift/);
	assert.match(swiftJob, /Benchmark Swift compiler without CodeQL tracing\n\s+if: \$\{\{ inputs\.profile_swift \}\}/);
	// The opt-in profiling step may query the Xcode version, but never builds.
	assert.doesNotMatch(compilerScript, /xcodebuild/);
	assert.doesNotMatch(swiftJob, /-scheme FramekitFinalCutWorkflowExtension/);
	assert.doesNotMatch(swiftJob, /-destination/);
	assert.doesNotMatch(compilerScript, /-emit-module/);
	assert.doesNotMatch(compilerScript, /ProExtensionHostShim/);
	assert.doesNotMatch(compilerScript, /Final Cut Pro\.app/);
	assert.doesNotMatch(compilerScript, /ProExtensionHost\.framework/);
	assert.doesNotMatch(compilerScript, /\/tmp\/framekit-finalcut-frameworks/);
	assert.doesNotMatch(compilerScript, /build\.sh/);
	assert.match(project, /FramekitFinalCutWorkflowCodeQL:/);
	assert.match(project, /type: library\.static/);
	assert.match(project, /FinalCutLiveWorkflowExtension\.swift/);
	assert.match(
		project,
		/\.github\/codeql\/FinalCutWorkflowExtensionShim\.swift/,
	);
});

test('CodeQL substitutes host declarations without changing the native import', async () => {
	const source = await readRepositoryFile(
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FinalCutLiveWorkflowExtension.swift',
	);
	const shim = await readRepositoryFile(
		'.github/codeql/FinalCutWorkflowExtensionShim.swift',
	);
	const project = await readRepositoryFile(
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/FramekitFinalCutWorkflow.xcodeproj/project.pbxproj',
	);

	assert.match(
		source,
		/#if !FRAMEKIT_CODEQL[\s\S]*import ProExtensionHost[\s\S]*#endif/,
	);
	assert.match(
		source,
		/#if !FRAMEKIT_CODEQL[\s\S]*import AppKit[\s\S]*#endif/,
	);
	assert.match(shim, /import CoreMedia/);
	assert.match(shim, /class NSViewController/);
	assert.match(shim, /protocol FCPXTimelineObserver/);
	assert.match(shim, /func ProExtensionHostSingleton/);
	assert.match(project, /FinalCutWorkflowExtensionShim\.swift/);
});

test('pull request CI is consolidated in local composite actions', async () => {
	const workflow = await readRepositoryFile('.github/workflows/ci.yml');
	const expectedJobs = [
		['lint', 'Lint / static checks', './.github/action/lint-static'],
		['test', 'Unit / integration tests', './.github/action/test'],
		['consumer-runtime', 'Published package consumer minimum', './.github/action/consumer-runtime'],
		['swift', 'Swift type-check', './.github/action/swift'],
	] as const;

	assert.match(workflow, /name: CI/);
	assert.match(workflow, /pull_request:/);
	assert.match(workflow, /cancel-in-progress: true/);
	for (const [jobName, checkName, actionPath] of expectedJobs) {
		const job = getJob(workflow, jobName);
		assert.ok(job, `${jobName} job is present`);
		assert.match(job, new RegExp(`name: ${checkName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
		assert.match(job, new RegExp(`uses: \\.?/?${actionPath.replaceAll('/', '\\/')}`));
		const action = await readRepositoryFile(`${actionPath.slice(2)}/action.yml`);
		assert.match(action, /using: composite/);
	}
	const workflows = await readdir(resolve(repository, '.github/workflows'));
	assert.equal(workflows.includes('typescript.yml'), false);
	assert.equal(workflows.includes('swift.yml'), false);
});

test('Swift type-check remains a native validation gate in combined CI', async () => {
	const workflow = await readRepositoryFile('.github/workflows/ci.yml');
	const swiftJob = getJob(workflow, 'swift');
	const action = await readRepositoryFile('.github/action/swift/action.yml');

	assert.ok(swiftJob);
	assert.match(swiftJob, /name: Swift type-check/);
	assert.match(swiftJob, /runs-on: macos-26/);
	assert.match(action, /xcodebuild[\s\S]*-list/);
	assert.match(action, /xcrun swiftc/);
	assert.match(action, /ProExtensionHostShim/);
});

test('Swift bridge documents the separate bounded CodeQL path', async () => {
	const documentation = await readRepositoryFile(
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/README.md',
	);

	assert.match(documentation, /CodeQL Swift extraction/);
	assert.match(documentation, /manual\s+`xcrun swiftc`/);
	assert.match(
		documentation,
		/checked-in\s+`.github\/codeql\/FinalCutWorkflowExtensionShim\.swift`/,
	);
	assert.match(documentation, /Direct\s+compiler\s+invocation/);
	assert.match(documentation, /does not\s+invoke[\s\S]*`build\.sh`/);
	assert.match(documentation, /forty and twenty-five minutes/);
	assert.match(documentation, /standalone Swift CI/);
});
