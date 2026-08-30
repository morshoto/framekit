import type { AudioAnalysis } from "@framekit/runtime";

export const SILENT_AUDIO_FIXTURE: AudioAnalysis = {
  integratedLufs: -80,
  truePeakDb: -80,
  silenceMs: 10_000,
  audibleSamples: 0,
  analyzedDurationSeconds: 10,
};

export const VALID_AUDIO_FIXTURE: AudioAnalysis = {
  integratedLufs: -18,
  truePeakDb: -3,
  silenceMs: 120,
  audibleSamples: 1_000,
  analyzedDurationSeconds: 10,
};

export const TOO_QUIET_AUDIO_FIXTURE: AudioAnalysis = {
  integratedLufs: -42,
  truePeakDb: -40,
  silenceMs: 1_000,
  audibleSamples: 200,
  analyzedDurationSeconds: 10,
};
