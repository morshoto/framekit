export const MAINTENANCE_RELEASE_SUMMARY: 'Maintenance and internal';
export const FORMATTED_RELEASE_NOTES_MARKER: '<!-- Framekit formatted release notes -->';

export function collapseMaintenanceReleaseNotes(markdown: string): string;
export function selectMilestoneDescription(milestones: Array<{ title: string; description: string | null }>, version: string): string | undefined;
export function formatReleaseNotes(markdown: string, description?: string): string;
