export declare function runPublishStages(
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  input: { artifactPath: string; targetLibraryPath: string; artifactDigest: string } & ({ transactionId: string; headlessExecutionId?: never } | { headlessExecutionId: string; transactionId?: never }),
  onStage: (stage: string, job: any) => unknown,
  beforeDispatch?: (jobId: string) => Promise<void>,
  options?: { stopAfterDispatch?: boolean },
): Promise<any>;
