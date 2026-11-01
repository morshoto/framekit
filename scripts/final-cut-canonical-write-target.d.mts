type Target = { projectId: string; projectName: string; sequenceId: string };
type Call = (name: string, args?: any) => Promise<any>;
export function selectCanonicalWriteTarget(callJson: Call, expected: Target, expectedRevision: string): Promise<any>;
export function readCanonicalWriteTarget(callJson: Call, expected: Target): Promise<any>;
