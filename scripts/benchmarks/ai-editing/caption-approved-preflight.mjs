import { mkdir } from 'node:fs/promises';
import { verifyAsset } from './corpus.mjs';

/** Verify the source before creating a new, exclusive output directory. */
export async function prepareApprovedCaptionOutput(source, output, digest) {
  await verifyAsset(source, digest);
  await mkdir(output);
}
