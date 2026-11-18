/** Artifact measurements cannot establish how a movie was produced or imported. */
export interface ExportMeasurements {
  durationSeconds: number;
  samples: Array<{ timeSeconds: number; rgb: [number, number, number] }>;
  toneAmplitudes: number[];
}

export function evaluateExportMeasurements(observed: ExportMeasurements) {
  const samples = [0.5, 1.5, 2.5];
  const duration = Number.isFinite(observed.durationSeconds) && Math.abs(observed.durationSeconds - 3) <= 0.05;
  const video = observed.samples.length === 3 && observed.samples.every((sample, index) => {
    const [r, g, b] = sample.rgb;
    const components = [r, g, b];
    const dominant = components[index]!;
    return Math.abs(sample.timeSeconds - samples[index]!) < 0.001
      && components.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
      && dominant > 140 && components.every((value, channel) => channel === index || dominant - value > 100);
  });
  const audio = observed.toneAmplitudes.length === 3 && observed.toneAmplitudes.every((value) => Number.isFinite(value) && value >= 0.002 && value <= 0.2);
  return {
    status: duration && video && audio ? "PASS" as const : "FAIL" as const,
    checks: { duration, video, audio },
    nativeImport: "UNVERIFIED" as const,
    titleEditability: "UNVERIFIED" as const,
    finalCutProvenance: "UNVERIFIED" as const,
  };
}
