import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCUMENTATION_EXTENSIONS = new Set(['.adoc', '.md', '.mdx', '.rst']);
const DECLARATION_FIELDS = [
	'intent',
	'paths',
	'purpose',
	'minimality',
];

export function collectDocumentationPaths(changedFiles) {
	return [...new Set(changedFiles
		.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, ''))
		.filter((path) => path.startsWith('docs/')
			|| DOCUMENTATION_EXTENSIONS.has(extensionOf(path))))]
		.sort();
}

export function validateDocumentationIntent(changedFiles, pullRequestBody) {
	const documentationPaths = collectDocumentationPaths(changedFiles);
	if (documentationPaths.length === 0) return { valid: true };

	const fields = parseDeclarationFields(pullRequestBody);
	const errors = [];
	for (const field of DECLARATION_FIELDS) {
		const values = fields.get(field);
		if (!values || values.length === 0) {
			errors.push(`Provide a non-empty "Documentation ${field}:" declaration.`);
		} else if (field !== 'paths' && values.length > 1) {
			errors.push(`Use only one "Documentation ${field}:" declaration.`);
		}
	}

	const intent = fields.get('intent')?.[0]?.toLowerCase();
	if (intent && intent !== 'intentional') {
		errors.push('Set "Documentation intent:" to "intentional" for changed documentation.');
	}

	const purpose = fields.get('purpose')?.[0] ?? '';
	if (purpose && !isMeaningful(purpose)) {
		errors.push('Explain the user-facing purpose of the documentation change.');
	}

	const minimality = fields.get('minimality')?.[0] ?? '';
	if (minimality && !isMeaningful(minimality)) {
		errors.push('Explain why the documentation diff is the minimum necessary change.');
	}

	const declaredPaths = fields.get('paths') ?? [];
	if (declaredPaths.length === 0) {
		errors.push('List each changed documentation path under "Documentation paths:".');
	}
	if (new Set(declaredPaths).size !== declaredPaths.length) {
		errors.push('Remove duplicate entries from "Documentation paths:".');
	}

	const unsafePaths = declaredPaths.filter((path) => path.startsWith('/')
		|| path.split('/').includes('..'));
	if (unsafePaths.length > 0) {
		errors.push(`Use repository-relative paths: ${unsafePaths.join(', ')}.`);
	}

	const unmatched = declaredPaths.filter((declaredPath) =>
		!documentationPaths.some((changedPath) => pathDeclarationMatches(declaredPath, changedPath)));
	if (unmatched.length > 0) {
		errors.push(`These declared paths are not changed documentation files: ${unmatched.join(', ')}.`);
	}

	const missing = documentationPaths.filter((changedPath) =>
		!declaredPaths.some((declaredPath) => pathDeclarationMatches(declaredPath, changedPath)));
	if (missing.length > 0) {
		errors.push(`Name every changed documentation path; missing: ${missing.join(', ')}.`);
	}

	if (declaredPaths.includes('docs/**') && !pullRequestBody.includes('#572')) {
		errors.push('The docs/** migration declaration must link to issue #572.');
	}

	return errors.length === 0
		? { valid: true }
		: {
			valid: false,
			message: [
				'Documentation changed without a complete, matching intent declaration.',
				...errors,
				'Update the PR body using the documentation declaration format in the PR template.',
			].join('\n'),
		};
}

export async function fetchPullRequestSnapshot({
	repository,
	pullRequestNumber,
	token,
	apiUrl = 'https://api.github.com',
	fetchImpl = fetch,
}) {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error('GITHUB_REPOSITORY_INVALID');
	}
	if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
		throw new Error('PULL_REQUEST_NUMBER_INVALID');
	}
	if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

	const apiRoot = apiUrl.replace(/\/$/, '');
	const headers = {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
		'X-GitHub-Api-Version': '2022-11-28',
	};
	const request = async (path) => {
		const url = `${apiRoot}/repos/${repository}${path}`;
		const response = await fetchImpl(url, { headers });
		if (!response.ok) {
			throw new Error(`GITHUB_API_REQUEST_FAILED: GET ${new URL(url).pathname} returned ${response.status}`);
		}
		return response.json();
	};

	const pullRequest = await request(`/pulls/${pullRequestNumber}`);
	if (pullRequest.number !== pullRequestNumber) throw new Error('PULL_REQUEST_NOT_FOUND');

	const files = [];
	for (let page = 1; ; page += 1) {
		const pageFiles = await request(`/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`);
		if (!Array.isArray(pageFiles)) throw new Error('GITHUB_PULL_REQUEST_FILES_INVALID');
		files.push(...pageFiles.map((file) => file.filename));
		if (pageFiles.length < 100) break;
	}

	return { body: pullRequest.body ?? '', files };
}

function extensionOf(path) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const extensionIndex = name.lastIndexOf('.');
	return extensionIndex < 0 ? '' : name.slice(extensionIndex).toLowerCase();
}

function parseDeclarationFields(body) {
	const fields = new Map();
	let insideHtmlComment = false;
	const lines = body.split(/\r?\n/).map((line) => {
		const visible = textOutsideHtmlComments(line, insideHtmlComment);
		insideHtmlComment = visible.insideHtmlComment;
		return visible.text;
	});
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(/^\s*Documentation (intent|paths|purpose|minimality):\s*(.*?)\s*$/i);
		if (!match) continue;

		const field = match[1].toLowerCase();
		const values = field === 'paths'
			? match[2].split(',').map((value) => value.trim().replace(/^`(.*)`$/, '$1')).filter(Boolean)
			: match[2].trim() ? [match[2].trim()] : [];
		if (field === 'paths') {
			for (index += 1; index < lines.length; index += 1) {
				if (/^\s*Documentation (?:intent|paths|purpose|minimality):/i.test(lines[index])) {
					index -= 1;
					break;
				}
				const value = lines[index].trim().replace(/^[-*]\s+/, '').replace(/^`(.*)`$/, '$1');
				if (value) values.push(value);
			}
		}
		fields.set(field, [...(fields.get(field) ?? []), ...values]);
	}
	return fields;
}

function textOutsideHtmlComments(line, insideHtmlComment) {
	const visibleParts = [];
	let offset = 0;
	while (offset < line.length) {
		if (insideHtmlComment) {
			const closingMarker = line.indexOf('-->', offset);
			if (closingMarker < 0) return { text: visibleParts.join(''), insideHtmlComment: true };
			offset = closingMarker + 3;
			insideHtmlComment = false;
			continue;
		}

		const openingMarker = line.indexOf('<!--', offset);
		if (openingMarker < 0) {
			visibleParts.push(line.slice(offset));
			break;
		}
		visibleParts.push(line.slice(offset, openingMarker));
		offset = openingMarker + 4;
		insideHtmlComment = true;
	}
	return { text: visibleParts.join(''), insideHtmlComment };
}

function isMeaningful(value) {
	return value.trim().length > 0
		&& !/^(?:none|n\/?a|tbd|todo|why|purpose|minimality|\.\.\.)$/i.test(value.trim());
}

function pathDeclarationMatches(declaredPath, changedPath) {
	if (declaredPath === 'docs/**') return changedPath.startsWith('docs/');
	return declaredPath === changedPath;
}

async function main() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	const token = process.env.GITHUB_TOKEN;
	if (!eventPath) throw new Error('GITHUB_EVENT_PATH_REQUIRED');
	if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

	const event = JSON.parse(await readFile(eventPath, 'utf8'));
	const pullRequestNumber = event.pull_request?.number;
	if (!pullRequestNumber) throw new Error('PULL_REQUEST_EVENT_REQUIRED');

	const { body, files } = await fetchPullRequestSnapshot({
		repository: process.env.GITHUB_REPOSITORY,
		pullRequestNumber,
		token,
		apiUrl: process.env.GITHUB_API_URL,
	});
	const result = validateDocumentationIntent(files, body);
	if (!result.valid) {
		console.error(`::error title=Documentation intent required::${escapeWorkflowCommandData(result.message)}`);
		process.exitCode = 1;
		return;
	}

	const changedDocumentation = collectDocumentationPaths(files);
	console.log(changedDocumentation.length === 0
		? 'No documentation files changed; no declaration is required.'
		: 'Documentation intent declaration validated.');
}

function escapeWorkflowCommandData(value) {
	return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
