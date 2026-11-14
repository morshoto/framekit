export function parseDialogueApproval(env: Record<string, string | undefined>): any;
export function requireDialogueCapabilities(editor: any): void;
export function reviewDialogueMeasurement(measurement: any, snapshot: any, approval: any): any;
export function previewApprovedDialogue(callJson: (name: string, args?: any) => Promise<any>, readProject: () => Promise<any>, before: any, approval: any): Promise<any>;
export function verifyDialogueReadback(before: any, after: any, restored: any, preview: any, measurement: any, approval: any): any;
