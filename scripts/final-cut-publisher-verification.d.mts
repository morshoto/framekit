export declare function runPublishStages(
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  input: { artifactPath: string; transactionId: string; targetLibraryPath: string; artifactDigest: string },
  onStage: (stage: string, job: any) => void,
): Promise<any>;
export declare function verifyPublishedTarget(input: {
  result: any;
  beforeLive: any;
  afterLive: any;
  expectedProject: string;
  expectedSequence?: string;
  sourceSequence?: string;
}): void;
