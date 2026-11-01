export declare function runPublishStages(
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  input: { artifactPath: string; targetLibraryPath: string; artifactDigest: string } & ({ transactionId: string; headlessExecutionId?: never } | { headlessExecutionId: string; transactionId?: never }),
  onStage: (stage: string, job: any) => void,
): Promise<any>;
export declare function verifyPublishedTarget(input: {
  result: any;
  beforeLive: any;
  afterLive: any;
  expectedProject: string;
  expectedSequence?: string;
  sourceSequence?: string;
  targetLibraryPath?: string;
}): void;
export declare function verifyAcceptanceFixture(snapshot: any): void;
export declare function verifyPublisherPreflight(editor: any, expectedCommit: string): void;
