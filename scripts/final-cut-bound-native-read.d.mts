export function readBoundNativeProject(
  callJson: (name: string, args?: any) => Promise<any>,
  expectedProject: string,
  expectedSequence?: string,
): Promise<{ catalog: any; project: any; sequence: any; snapshot: any }>;
