import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	collapseMaintenanceReleaseNotes,
	formatReleaseNotes,
	MAINTENANCE_RELEASE_SUMMARY,
} from '../../scripts/format-release-notes.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('collapses maintenance release notes without hiding user-facing sections', () => {
	const source = `## What's Changed
### Feature changes
* feat: add something
### Patch changes
* fix: repair something
### Maintenance and internal
* chore: update tooling
* test: expand coverage

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

	const formatted = collapseMaintenanceReleaseNotes(source);

	assert.match(formatted, /### Feature changes\n\* feat: add something/);
	assert.match(formatted, /### Patch changes\n\* fix: repair something/);
	assert.match(
		formatted,
		new RegExp(
			`<details>\\n<summary>${MAINTENANCE_RELEASE_SUMMARY}</summary>\\n\\n\\* chore: update tooling\\n\\* test: expand coverage\\n\\n</details>`,
		),
	);
	assert.match(formatted, /<\/details>\n\n\*\*Full Changelog\*\*:/);
	assert.doesNotMatch(formatted, /### Maintenance and internal/);
});

test('keeps following generated sections outside the maintenance details block', () => {
	const source = `## What's Changed
### Maintenance and internal
* chore: update tooling

## New Contributors
* @contributor made their first contribution

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

	const formatted = collapseMaintenanceReleaseNotes(source);
	const detailsEnd = formatted.indexOf('</details>');
	const contributors = formatted.indexOf('## New Contributors');

	assert.ok(detailsEnd !== -1);
	assert.ok(
		contributors > detailsEnd,
		'New Contributors must remain outside the collapsed maintenance section',
	);
});

test('release note formatting is idempotent', () => {
	const source = `## What's Changed
### Maintenance and internal
* chore: update tooling

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

	const once = collapseMaintenanceReleaseNotes(source);
	assert.equal(collapseMaintenanceReleaseNotes(once), once);
});

test('formats v0.1.16 generated notes into Codex sections and a complete changelog', async () => {
	const source = await readFile(
		resolve(repository, 'tests/fixtures/release-notes/v0.1.16.md'),
		'utf8',
	);
	const formatted = formatReleaseNotes(source);

	assert.match(formatted, /^<!-- Release notes generated[\s\S]*?-->/);
	assert.match(formatted, /## New Features[\s\S]*?\[#495\]/);
	assert.match(formatted, /## Bug Fixes[\s\S]*?\[#501\]/);
	assert.match(formatted, /## Documentation[\s\S]*?\[#446\]/);
	assert.match(formatted, /## Chores[\s\S]*?\[#441\]/);
	assert.match(formatted, /\*\*Full Changelog\*\*: https:\/\/github\.com\/morshoto\/framekit\/compare\/v0\.1\.15\.\.\.v0\.1\.16/);
	assert.match(formatted, /## Changelog[\s\S]*\[#495\].*feat: harden editable FCPXML materialization.*@morshoto/);
	assert.equal((formatted.match(/\[#\d+\]/g) ?? []).length, 20);
	assert.equal(formatReleaseNotes(formatted), formatted);
});

test('formats v0.1.15 notes including an existing maintenance details wrapper', async () => {
	const source = await readFile(
		resolve(repository, 'tests/fixtures/release-notes/v0.1.15.md'),
		'utf8',
	);
	const formatted = formatReleaseNotes(source);

	assert.match(formatted, /## New Features/);
	assert.match(formatted, /## Documentation/);
	assert.match(formatted, /## Chores/);
	assert.match(formatted, /## Changelog[\s\S]*\[#462\].*docs: record background read NO-GO gate.*@morshoto/);
	assert.equal((formatted.match(/\[#\d+\]/g) ?? []).length, 40);
	assert.equal(formatReleaseNotes(formatted), formatted);
});

test('preserves release comments and handles CRLF and unusual pull request titles', () => {
	const source = [
		'<!-- human release comment -->',
		'',
		'## What\'s Changed',
		'### Other changes',
		'* feat: support [special] `title` by @some-user in https://github.com/example/project/pull/4',
		'* docs: explain thing by @docs-user in https://github.com/example/project/pull/5',
		'',
		'<!-- keep this release note comment -->',
		'',
		'**Full Changelog**: https://github.com/example/project/compare/v1...v2',
	].join('\r\n');
	const formatted = formatReleaseNotes(source);

	assert.match(formatted, /^<!-- human release comment -->/);
	assert.match(formatted, /## New Features[\s\S]*support.*special.*title/);
	assert.match(formatted, /## Documentation[\s\S]*\[#5\]/);
	assert.match(formatted, /<!-- keep this release note comment -->/);
	assert.match(formatted, /## Changelog[\s\S]*\[#4\].*some-user/);
	assert.equal(formatReleaseNotes(formatted), formatted);
});

test('leaves manually edited formatted notes untouched', () => {
	const source = '<!-- Framekit formatted release notes -->\n\n## New Features\n\nHuman edit\n\n## Changelog\n\n* hand-edited entry';
	assert.equal(formatReleaseNotes(source), source);
});

test('leaves release notes without maintenance changes untouched', () => {
	const source = `## What's Changed
### Feature changes
* feat: add something

**Full Changelog**: https://github.com/example/repo/compare/v0.1.7...v0.1.8`;

	assert.equal(collapseMaintenanceReleaseNotes(source), source);
});

test('classifies release categories from existing labels and excludes tagpr', async () => {
	const config = await readFile(resolve(repository, '.github/release.yml'), 'utf8');
	const categoryTitles = [...config.matchAll(/- title: '([^']+)'/g)].map((match) => match[1]);

	assert.deepEqual(categoryTitles, ['New Features', 'Bug Fixes', 'Documentation', 'Chores', 'Other changes']);
	assert.match(config, /exclude:[\s\S]*?labels:[\s\S]*?- tagpr/);
	assert.match(config, /Type: New Feature/);
	assert.match(config, /Problem: Bug/);
	assert.match(config, /Type: Document/);
	assert.match(config, /Type: Chore/);
	assert.match(config, /Other changes[\s\S]*?- '\*'/);
});

test('format workflows target tag PR previews, draft releases, and published releases', async () => {
	const workflow = await readFile(
		resolve(repository, '.github/workflows/format-release-notes.yml'),
		'utf8',
	);

	assert.match(
		workflow,
		/pull_request:\s*\n\s+types: \[opened, synchronize, reopened\]/,
	);
	assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
	assert.match(workflow, /startsWith\(github\.head_ref, 'tagpr-from-'\)/);
	assert.match(workflow, /pull-requests: write/);
	assert.match(workflow, /github-release:[\s\S]*?contents: write/);
	assert.equal(
		workflow.match(/node scripts\/format-release-notes\.mjs/g)?.length,
		2,
		'the same formatter should be used for the release PR and final release',
	);
	const releaseWorkflow = await readFile(resolve(repository, '.github/workflows/release.yml'), 'utf8');
	assert.match(releaseWorkflow, /name: Format draft release notes/);
	assert.match(releaseWorkflow, /node scripts\/format-release-notes\.mjs/);
	assert.match(releaseWorkflow, /steps\.run-tagpr\.outputs\.tag/);
});
