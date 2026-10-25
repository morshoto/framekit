export function shouldConfigureFinalCutProjectPublisher(input: {
  liveMode: boolean;
  fcpxmlPath: string | undefined;
  canonicalNativeProviderEnabled: boolean;
}): boolean {
  return input.liveMode && (Boolean(input.fcpxmlPath) || input.canonicalNativeProviderEnabled);
}
