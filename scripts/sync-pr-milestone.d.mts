export interface IssueMilestone {
	id: number;
	number: number;
	title: string;
}

export type MilestoneDecision =
	| { action: 'update'; milestone: IssueMilestone }
	| { action: 'unchanged'; milestone: IssueMilestone }
	| { action: 'skip'; reason: 'no-linked-issues' | 'no-linked-milestone' | 'conflicting-milestones' };

export function extractIssueReferences(body: string): number[];
export function resolvePullRequestMilestone(
	linkedIssues: Array<{ number: number; milestone: IssueMilestone | null }>,
	currentMilestone: IssueMilestone | null,
): MilestoneDecision;
export function syncPullRequestMilestone(options: {
	repository: string;
	pullRequestNumber: number;
	body: string;
	token: string;
	apiUrl: string;
	fetchImpl?: typeof fetch;
	timelineRetryDelaysMs?: number[];
	sleepImpl?: (milliseconds: number) => Promise<void>;
}): Promise<{ action: 'updated'; milestoneNumber: number } | MilestoneDecision>;
