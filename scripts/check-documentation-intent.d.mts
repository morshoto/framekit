export interface DocumentationIntentResult {
	valid: true;
}

export interface DocumentationIntentFailure {
	valid: false;
	message: string;
}

export function collectDocumentationPaths(changedFiles: string[]): string[];

export function validateDocumentationIntent(
	changedFiles: string[],
	pullRequestBody: string,
): DocumentationIntentResult | DocumentationIntentFailure;

export function fetchPullRequestSnapshot(options: {
	repository: string;
	pullRequestNumber: number;
	token: string;
	apiUrl?: string;
	fetchImpl?: typeof fetch;
}): Promise<{ body: string; files: string[] }>;
