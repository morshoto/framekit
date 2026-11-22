export function previewAndExecuteCanonicalRename(
  callJson: (name: string, args?: any) => Promise<any>,
  readTarget: () => Promise<any>, before: any, clipId: string, name: string,
): Promise<any>;
