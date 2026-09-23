export const maxScannableBytes: number;

export type StagedContentFinding = {
  path: string;
  category: string;
  line?: number;
};

export function scanText(text: string, filePath?: string): StagedContentFinding[];
export function scanStagedContent(cwd?: string): StagedContentFinding[];
export function stagedPaths(cwd?: string): string[];
