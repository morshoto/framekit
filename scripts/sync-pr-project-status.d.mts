import type { ProjectStatus, ProjectStatusClient } from './sync-project-status.mjs';

export interface PullRequestStatusSnapshot {
	number: number;
	issueNumbers: number[];
	mergeable: string;
	mergeStateStatus: string;
	hasReviewComments: boolean;
	checks: Array<{ required: boolean; status?: string; conclusion?: string | null; state?: string }>;
}
export interface PullRequestStatusSource {
	readOpenPullRequests(): Promise<PullRequestStatusSnapshot[]>;
}
export function choosePullRequestStatus(pr: Omit<PullRequestStatusSnapshot, 'number' | 'issueNumbers'>): ProjectStatus;
export function extractLinkedIssueNumbers(body: string, repository: string): number[];
export function createPullRequestStatusSource(options: {
	repository: string;
	token: string;
	apiUrl?: string;
	fetchImpl?: typeof fetch;
}): PullRequestStatusSource;
export function syncPullRequestStatuses(options: {
	client: ProjectStatusClient;
	source: PullRequestStatusSource;
}): Promise<Array<{ number: number; status: ProjectStatus; action: 'updated' | 'unchanged' }>>;
