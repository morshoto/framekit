import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

	assert.match(workflow, /push:\s+branches:\s+- main/);
	assert.match(
		workflow,
		/group:\s+codeql-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
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
	assert.match(workflow, /push:\s+branches:\s+- main/);
	assert.match(workflow, /^\s*workflow_dispatch:/m);
	assert.match(workflow, /^\s*schedule:/m);
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
		'.github/workflows/swift.yml',
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
		/\n[ \t]+- name: Type-check Swift sources for CodeQL extraction\n[ \t]+timeout-minutes: 25\n[ \t]+run: \|/,
	);
});

test('JavaScript CodeQL uploads without waiting on remote processing', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const javascriptJob = getJob(workflow, 'analyze');

	assert.ok(javascriptJob, 'JavaScript CodeQL job should be present');
	assert.match(
		javascriptJob,
		/name: Analyze with CodeQL[\s\S]*?wait-for-processing: false/,
	);
});

test('Swift CodeQL extraction uses the checked-in shim only', async () => {
	const workflow = await readRepositoryFile('.github/workflows/codeql.yml');
	const project = await readRepositoryFile(
		'adapters/final-cut/swift-bridge/FinalCutWorkflowExtension/project.yml',
	);
	const swiftJob = getJob(workflow, 'analyze-swift');

	assert.ok(swiftJob, 'Swift CodeQL job should be present');

	assert.match(swiftJob, /xcrun --sdk macosx swiftc/);
	assert.match(swiftJob, /-typecheck/);
	assert.match(swiftJob, /-parse-as-library/);
	assert.match(swiftJob, /-target \"\$\(uname -m\)-apple-macos15\.0\"/);
	assert.match(swiftJob, /-swift-version 5/);
	assert.match(swiftJob, /timeout-minutes: 40/);
	assert.match(swiftJob, /timeout-minutes: 25/);
	assert.match(swiftJob, /-D FRAMEKIT_CODEQL/);
	assert.doesNotMatch(swiftJob, /xcodebuild/);
	assert.doesNotMatch(swiftJob, /-scheme FramekitFinalCutWorkflowExtension/);
	assert.doesNotMatch(swiftJob, /-destination/);
	assert.doesNotMatch(swiftJob, /-emit-module/);
	assert.doesNotMatch(swiftJob, /ProExtensionHostShim/);
	assert.doesNotMatch(swiftJob, /Final Cut Pro\.app/);
	assert.doesNotMatch(swiftJob, /ProExtensionHost\.framework/);
	assert.doesNotMatch(swiftJob, /\/tmp\/framekit-finalcut-frameworks/);
	assert.doesNotMatch(swiftJob, /build\.sh/);
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

test('Swift CI remains an independent native validation gate', async () => {
	const workflow = await readRepositoryFile('.github/workflows/swift.yml');

	assert.match(workflow, /name: Swift CI/);
	assert.match(workflow, /xcodebuild[\s\S]*-list/);
	assert.match(workflow, /xcrun swiftc/);
	assert.match(workflow, /ProExtensionHostShim/);
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
