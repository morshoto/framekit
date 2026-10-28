export type ProjectStatus = 'Backlog' | 'In progress' | 'In review' | 'Pending' | 'Done';

export const PROJECT_STATUSES: ProjectStatus[];
export const STATUS_LABEL_PREFIX: 'Status: ';

export function statusFromLabel(label: string | null): ProjectStatus | null;
export function chooseIssueStatus(options: {
	action: string;
	eventLabel?: string | null;
	labels: string[];
}): ProjectStatus;
export function backfillStatus(options: {
	labels: string[];
	boardStatus: string | null;
}): { conflict: true; labels: string[] } | { conflict: false; status: ProjectStatus; seedLabel: boolean };
export function statusLabelChanges(labels: string[], status: ProjectStatus): { add: string[]; remove: string[] };

export interface ProjectStatusItem {
	id: string;
	content?: { id: string } | null;
	fieldValues: { nodes: Array<{ field?: { id: string } | null; name: string }> };
}

export interface ProjectStatusClient {
	getProject(): Promise<{
		id: string;
		statusField: { id: string; name: string };
		options: Map<string, string>;
		items: ProjectStatusItem[];
	}>;
	readIssue(number: number): Promise<{ number: number; node_id: string; labels: Array<{ name: string }> }>;
	setIssueStatusLabel(issue: { number: number; labels: Array<{ name: string }> }, status: ProjectStatus): Promise<void>;
	setProjectStatus(project: Awaited<ReturnType<ProjectStatusClient['getProject']>>, itemId: string, status: ProjectStatus, previousStatus: string | null): Promise<boolean>;
	projectItemForIssue(project: Awaited<ReturnType<ProjectStatusClient['getProject']>>, issueNodeId: string): ProjectStatusItem | undefined;
	addIssueToProject(project: Awaited<ReturnType<ProjectStatusClient['getProject']>>, issueNodeId: string): Promise<string>;
}

export function createProjectStatusClient(options: {
	repository: string;
	token: string;
	projectOwner?: string;
	projectNumber?: number;
	apiUrl?: string;
	fetchImpl?: typeof fetch;
}): ProjectStatusClient;

export function syncIssueEvent(options: {
	client: ProjectStatusClient;
	issue: { node_id: string; number: number; state: string; pull_request?: unknown };
	action: string;
	eventLabel?: string | null;
}): Promise<{ action: 'skipped'; reason: 'issue-not-in-project' } | { action: 'updated' | 'unchanged'; status: ProjectStatus }>;

export function backfillProject(options: {
	client: ProjectStatusClient;
	repository: string;
	log?: Pick<Console, 'log' | 'error'>;
}): Promise<{ scanned: number; updated: number; conflicts: number }>;
