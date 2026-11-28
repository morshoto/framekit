// Usage: node --import tsx run-production-evidence.mjs TS3003A_WAV PYTHON NEW_OUTPUT_DIRECTORY
// Set the FRAMEKIT_WHISPER_*, FRAMEKIT_SILERO_VAD_*, and FRAMEKIT_SPEECH_ANALYZER_{VERSION,MODEL_ID} variables.
// Test-program confirmation and artifact mutations occur only in the new disposable headless project.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { isEvidenceRejection } from './evidence-quality.mjs';
const [sourceArg,pythonArg,outputArg]=process.argv.slice(2);
if (!sourceArg || !pythonArg || !outputArg || process.argv.length!==5) throw new Error('Expected source, Python and new output directory');
for(const name of ['FRAMEKIT_WHISPER_BACKEND','FRAMEKIT_WHISPER_MODEL','FRAMEKIT_SILERO_VAD_MODEL','FRAMEKIT_SILERO_VAD_SHA256','FRAMEKIT_SPEECH_ANALYZER_VERSION','FRAMEKIT_SPEECH_ANALYZER_MODEL_ID']) if(!process.env[name]?.trim()) throw new Error(`Missing ${name}`);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'), source=resolve(sourceArg), python=resolve(pythonArg), output=resolve(outputArg);
const asset=(await loadCorpus()).assets.find((entry)=>entry.id==='TS3003a'); await verifyAsset(source,asset.sha256); await mkdir(output);
const input=join(output,'input-with-tail.mp4'), ffmpeg=process.env.FFMPEG_BIN || 'ffmpeg';
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=11','-ss','72','-i',source,'-filter_complex','[1:a]atrim=duration=10,apad=pad_dur=1[a]','-map','0:v:0','-map','[a]','-t','11','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',input]);
const wrapper=join(output,'speech-wrapper.mjs'), backend=join(root,'apps/mcp-server/runtime/whisper-speech-backend.py');
await writeFile(wrapper,`#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nlet input=''; for await (const chunk of process.stdin) input+=chunk;\nconst child=spawnSync(${JSON.stringify(python)},[${JSON.stringify(backend)}],{input,encoding:'utf8',maxBuffer:33554432,env:process.env});\nif(child.error) throw child.error; process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode=child.status ?? 1;\n`); await chmod(wrapper,0o700);
const state=join(output,'state'),env={...process.env,FRAMEKIT_EDITOR:'final-cut-live',FRAMEKIT_AUTO_CONNECT:'0',FRAMEKIT_FINAL_CUT_HEADLESS:'1',FRAMEKIT_FINAL_CUT_NATIVE_WRITES:'0',FRAMEKIT_FINAL_CUT_SOCKET:join(output,'missing.sock'),FRAMEKIT_STATE_DIR:state,FRAMEKIT_SPEECH_ANALYZER:wrapper,FRAMEKIT_SPEECH_REQUIRE_VAD:'1',FRAMEKIT_AUDIO_ANALYZER:''};
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(root,'apps/mcp-server/src/main.ts')],env,stderr:'pipe'}),client=new Client({name:'production-evidence-probe',version:'1.0.0'}); await client.connect(transport);
const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});if(response.isError || response.content?.[0]?.type!=='text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);return JSON.parse(response.content[0].text);};
try {
 const timeline={schemaVersion:1,project:{id:'evidence-real-eval',name:'Disposable evidence eval'},sequence:{id:'sequence',name:'Sequence',durationTime:{value:'0',timescale:'1'},frameDuration:{value:'1',timescale:'30'},occurrences:[],storyElements:[],markers:[],captions:[],titles:[],transitions:[]},resources:[],revision:{id:'r0',sequence:0,timestamp:'2026-10-05T00:00:00.000Z'}};
 const created=await call('headless.project.create',{timeline}), projectId=timeline.project.id,sequenceId=timeline.sequence.id;
 const media=await call('headless.media.register',{projectId,sourcePath:input,expectedRevision:created.timeline.revision});
 const placed=await call('headless.edit.execute',{projectId,sequenceId,expectedRevision:media.project.timeline.revision,operations:[{type:'insert-occurrence',placement:'append',occurrence:{id:'interview',name:'Interview',mediaId:media.resource.id,startTime:{value:'0',timescale:'1'},durationTime:{value:'11',timescale:'1'},sourceStartTime:{value:'0',timescale:'1'},track:0,role:'video'}}]});
 const revision=placed.after.timeline.revision,target={projectId,sequenceId,expectedRevision:revision}; await call('media.understand',{projectId,mediaId:media.resource.id});
 const brief={schemaVersion:1,id:'evidence-real',version:1,purpose:{kind:'specified',value:'interview'},audience:{kind:'no-preference'},durationSeconds:{min:10,max:12},aspectRatio:'16:9',theme:'natural',visualDirection:'natural',requiredContent:['intro'],excludedContent:[],sourceCoverage:[{requirement:'intro',sourceId:media.resource.id,sourceDigest:media.resource.sourceDigest,start:0,end:1}],speechPolicy:{kind:'specified',value:'preserve'},musicPolicy:{kind:'specified',value:'none'},captionPolicy:{kind:'specified',value:'basic'},inferences:[],reviewPrompts:[]};
 const draft=await call('headless.brief.create',{...target,brief}); await call('headless.brief.accept',{...target,expectedDigest:draft.record.digest,confirmed:true});
 const pin={...target,mediaId:media.resource.id,range:{start:0,end:11}}, speechRef=(await call('headless.analysis.pin',{...pin,kind:'speech'})).ref, vadRef=(await call('headless.analysis.pin',{...pin,kind:'vad'})).ref;
 const inputPlan={projectId,timelineId:sequenceId,revision,occurrenceId:'interview',speechRef,vadRef,caption:{style:'basic',maxWordsPerGroup:6,maxCharsPerLine:38,maxLines:2},music:{occurrenceId:'music-plan',placement:{start:0,end:1},targetLane:-1,context:{speech:'present',audioEvidence:'unavailable'},capabilities:{staticMusicPreview:false,ducking:false,fades:false}}};
 const plan=await call('headless.decision.plan',inputPlan); if(plan.status!=='available' || !plan.plan.decisions.some((item)=>item.kind==='caption')) throw new Error(`Caption plan unavailable: ${plan.reason}`);
 const before=(await call('headless.project.inspect',{projectId})).timeline;
 if(!/^sha256:[0-9a-f]{64}$/.test(speechRef.artifactDigest)) throw new Error('Invalid artifact digest');
 const artifact=join(state,'analysis-artifacts',speechRef.artifactDigest.slice(7)), bytes=await readFile(artifact);
 const sourceBytes=await readFile(input), statuses={};
 for(const mode of ['tampered','missing','changedSource']) {
   const preview=await call('headless.decision.approved-preview-captions',{...inputPlan,planDigest:plan.plan.planDigest});
   if(mode==='tampered') await writeFile(artifact,'tampered');
   else if(mode==='missing') await unlink(artifact);
   else await writeFile(input,Buffer.concat([sourceBytes,Buffer.from('changed')]));
   const args={projectId,sequenceId,previewToken:preview.previewToken,approved:true};
   try {
     const rejected=await client.callTool({name:'headless.decision.approved-execute-captions',arguments:args});
     const expected=mode==='changedSource' ? 'MEDIA_CHANGED' : 'STALE_DECISION_PLAN';
     if(!isEvidenceRejection(rejected,expected)) throw new Error(`${mode}: unexpected rejection ${JSON.stringify(rejected.content)}`);
     statuses[mode]=expected;
   } finally { await writeFile(artifact,bytes); if(mode==='changedSource') await writeFile(input,sourceBytes); }
   const after=(await call('headless.project.inspect',{projectId})).timeline;
   if(JSON.stringify(after)!==JSON.stringify(before)) throw new Error(`${mode}: timeline changed`);
   const replay=await client.callTool({name:'headless.decision.approved-execute-captions',arguments:args}); if(replay.isError!==true) throw new Error(`${mode}: rejected token reused`);
 }
 const fresh=await call('headless.decision.approved-preview-captions',{...inputPlan,planDigest:plan.plan.planDigest});
 const applied=await call('headless.decision.approved-execute-captions',{projectId,sequenceId,previewToken:fresh.previewToken,approved:true});
 if(applied.status!=='applied') throw new Error('Unchanged control did not apply'); statuses.unchanged='applied';
 const sha=async(path)=>createHash('sha256').update(await readFile(path)).digest('hex');
 const report={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:asset.sha256,sourceWindowSeconds:[72,82],addedTailSeconds:1,inputSha256:await sha(input),declaredModel:env.FRAMEKIT_WHISPER_MODEL,providerVersion:env.FRAMEKIT_SPEECH_ANALYZER_VERSION,captionGroups:plan.plan.decisions.filter((item)=>item.kind==='caption').length,statuses,rejectedTokensSingleUse:true,programmaticConfirmation:true,nativeWrites:false,nativeAcceptance:'unavailable',limitation:'One real-provider, disposable headless production-stdio run. Model bytes and transcript truth were not independently verified; this is not native acceptance or a speech-safety judgment.'};
 await writeFile(join(output,'report.json'),`${JSON.stringify(report,null,2)}\n`); process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally {await client.close(); await transport.close();}
