import { verifyAsset } from './corpus.mjs';
import { prepareOutputDirectory } from './music-quality.mjs';

/** Verify both sources before creating a new disposable output directory. */
export async function prepareApprovedMusicOutput(speech, music, output, speechDigest, musicDigest) {
  await verifyAsset(speech, speechDigest);
  await verifyAsset(music, musicDigest);
  await prepareOutputDirectory(output);
}
