import { InMemorySemanticMediaIndexStore, InMemoryAnalysisArtifactStore, pinAnalysisEvidence, verifyLocalMediaSource } from '../../../packages/runtime/src/index.ts';
import { bindSpeechAnalysis } from '../../../packages/runtime/src/speech/analysis.ts';
import { planCaptionGroups } from '../../../packages/runtime/src/planning/caption-planning.ts';
import { assessCaptionPlan, sampleFreeWordIndices } from './caption-quality.mjs';

/** Plan against a verified local source and provider output; this is not output or native verification. */
export async function probeCaptionPlan(source, revision, provider, payload, options = {}) {
  const range = {start:0,end:source.duration};
  const speech = bindSpeechAnalysis({...payload,mediaId:source.mediaId,sourceIdentity:source,revision,provider,
    coverageProvenance:payload.observedRange ? 'provider' : 'inferred'}, {input:{project:{revision},media:source},provider,range});
  const index = new InMemorySemanticMediaIndexStore();
  await index.save({mediaId:source.mediaId,source:source.source,sourceIdentity:source,analysisRevision:revision,speech,
    semantic:{subjects:[],scenes:[],environments:[],timeOfDay:[],moods:[],usableRanges:[]},
    analysis:[{capability:'speech',status:'analyzed',provenance:{source,analyzer:provider,ranges:[range]}}]});
  const artifacts = new InMemoryAnalysisArtifactStore();
  const current = {kind:'speech',source,provider,revision,range};
  const ref = await pinAnalysisEvidence(index,artifacts,current,verifyLocalMediaSource);
  const zero = {value:'0',timescale:'1'}, duration = {value:String(source.duration),timescale:'1'};
  const snapshot = {projectId:'caption-quality',projectName:'Caption quality',revision,media:[source],timeline:{id:'sequence',name:'Sequence',duration:source.duration,
    frameDuration:{value:'1',timescale:'30'}, clips:[{id:'clip',mediaId:source.mediaId,name:'Clip',start:0,duration:source.duration,sourceStart:0,sourceStartTime:zero,startTime:zero,durationTime:duration,track:0}],storyElements:[],captions:[],markers:[]}};
  const request = {snapshot,projectId:snapshot.projectId,timelineId:snapshot.timeline.id,revision,occurrenceId:'clip',style:'basic',maxWordsPerGroup:5,maxCharsPerLine:32,maxLines:2};
  const result = await planCaptionGroups(request,ref,current,artifacts,verifyLocalMediaSource);
  const groups = result.status === 'available' ? result.plan.groups : null;
  return {planStatus:result.status,...(result.status === 'available' ? {groups:groups.length,warnings:result.plan.warnings,nativeTitleStatus:result.plan.nativeTitleStatus} : {reason:result.reason}),
    recognizedWords:speech.words.length,sampleFreeWordIndices:sampleFreeWordIndices(speech.words,30),lowConfidenceWords:speech.words.filter((word)=>word.confidence < 0.8).length,
    assessment:assessCaptionPlan(speech.words,groups,1/30), ...(options.includeGroups && groups ? {captionGroups:groups} : {}), renderedTextStatus:'unavailable',transcriptionAccuracy:'unavailable'};
}
