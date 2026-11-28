import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemorySemanticMediaIndexStore } from '../../../packages/runtime/src/application/semantic-media-index-store.ts';
import { InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyAnalysisEvidence } from '../../../packages/runtime/src/planning/analysis-evidence.ts';
import { bindSpeechAnalysis } from '../../../packages/runtime/src/speech/analysis.ts';
import { verifyLocalMediaSource } from '../../../packages/runtime/src/index.ts';

/** Do not treat unrelated failures as evidence of a coverage guard. */
export function classifyPartialRejection(error) {
  if (error instanceof Error && /ANALYSIS_INVALID: speech coverage is incomplete or not provider-reported/.test(error.message)) return 'rejected';
  throw error;
}

/** Exercise evidence checks against a disposable copy, never mutating the caller's source. */
export async function exerciseEvidence(media, revision, provider, payload) {
  const directory = await mkdtemp(join(tmpdir(), 'framekit-real-evidence-'));
  try {
    const path = join(directory, 'source.wav');
    await copyFile(media.source, path);
    const source = {...media,source:path};
    const range = {start:0,end:source.duration};
    const speech = bindSpeechAnalysis({...payload,mediaId:source.mediaId,sourceIdentity:source,revision,provider,
      coverageProvenance:payload.observedRange ? 'provider' : 'inferred'}, {input:{project:{revision},media:source},provider,range});
    const record = {mediaId:source.mediaId,source:path,sourceIdentity:source,analysisRevision:revision,
      semantic:{subjects:[],scenes:[],environments:[],timeOfDay:[],moods:[],usableRanges:[]},
      analysis:[{capability:'speech',status:'analyzed',provenance:{source,analyzer:provider,ranges:[range]}}],speech};
    const index = new InMemorySemanticMediaIndexStore();
    await index.save(record);
    const artifacts = new InMemoryAnalysisArtifactStore();
    const context = {kind:'vad',source,provider,revision,range};
    const reference = await pinAnalysisEvidence(index,artifacts,context,verifyLocalMediaSource);
    const check = (store, current) => verifyAnalysisEvidence(store, reference, current, verifyLocalMediaSource);
    const statuses = {};
    statuses.original = (await check(artifacts,context)).status;
    statuses.staleProvider = (await check(artifacts,{...context,provider:{...provider,model:provider.model+'-changed'}})).status;
    statuses.staleRevision = (await check(artifacts,{...context,revision:{...revision,sequence:revision.sequence+1}})).status;
    statuses.missingArtifact = (await check(new InMemoryAnalysisArtifactStore(),context)).status;
    statuses.tamperedArtifact = (await check({get:async()=>Buffer.from('tampered'),put:async()=>{}},context)).status;
    const partial = new InMemorySemanticMediaIndexStore();
    await partial.save({...record,speech:{...speech,observedRange:{start:0,end:source.duration/2}}});
    try { await pinAnalysisEvidence(partial,new InMemoryAnalysisArtifactStore(),context,verifyLocalMediaSource); statuses.partialCoverage='incorrectly-accepted'; }
    catch (error) { statuses.partialCoverage=classifyPartialRejection(error); }
    await writeFile(path, 'tampered source');
    statuses.changedSource = (await check(artifacts,context)).status;
    return {artifactDigest:reference.artifactDigest,artifactDigestScope:'Includes a disposable source path; digest is run-specific.',statuses};
  } finally { await rm(directory,{recursive:true,force:true}); }
}
