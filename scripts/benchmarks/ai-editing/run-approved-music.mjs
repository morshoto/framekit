// Usage: node --import tsx run-approved-music.mjs AMI_WAV MUSIC_OGG NEW_OUTPUT_DIRECTORY
// Confirmation is programmatic in a disposable headless project; it is not human or native approval.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { headlessProbeEnvironment, loadCorpus } from './corpus.mjs';
import { prepareApprovedMusicOutput } from './music-approved-preflight.mjs';

const [speechArg,musicArg,outputArg] = process.argv.slice(2);
if (!speechArg || !musicArg || !outputArg || process.argv.length !== 5) throw new Error('Expected speech, music and new output directory');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const speech=resolve(speechArg), music=resolve(musicArg), output=resolve(outputArg);
const corpus=await loadCorpus(), config=JSON.parse(await readFile(new URL('./music-corpus.json',import.meta.url),'utf8'));
const asset=corpus.assets.find((item)=>item.id===config.speech.corpusAsset);
await prepareApprovedMusicOutput(speech,music,output,asset.sha256,config.music.sha256);
const ffmpeg=process.env.FFMPEG_BIN || 'ffmpeg', input=join(output,'source-speech.mp4');
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=10','-ss','60','-i',speech,'-t','10','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',input]);
const ffmpegVersion=execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0];
const env={...headlessProbeEnvironment(process.env,output),FRAMEKIT_SPEECH_ANALYZER:'',FRAMEKIT_AUDIO_ANALYZER:join(root,'apps/mcp-server/runtime/ffmpeg-audio-backend.py'),FRAMEKIT_AUDIO_ANALYZER_VERSION:ffmpegVersion};
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(root,'apps/mcp-server/src/main.ts')],env,stderr:'pipe'});
const client=new Client({name:'approved-music-probe',version:'1.0.0'}); await client.connect(transport);
const call=async(name,args)=>{const response=await client.callTool({name,arguments:args}); if(response.isError || response.content?.[0]?.type!=='text') throw new Error(`${name}: ${JSON.stringify(response.content)}`); return JSON.parse(response.content[0].text);};
try {
  const timeline={schemaVersion:1,project:{id:'music-real-eval',name:'Disposable music eval'},sequence:{id:'sequence',name:'Sequence',durationTime:{value:'0',timescale:'1'},frameDuration:{value:'1',timescale:'30'},occurrences:[],storyElements:[],markers:[],captions:[],titles:[],transitions:[]},resources:[],revision:{id:'r0',sequence:0,timestamp:'2026-10-05T00:00:00.000Z'}};
  const created=await call('headless.project.create',{timeline}), projectId=timeline.project.id, sequenceId=timeline.sequence.id;
  const video=await call('headless.media.register',{projectId,sourcePath:input,expectedRevision:created.timeline.revision});
  const track=await call('headless.media.register',{projectId,sourcePath:music,expectedRevision:video.project.timeline.revision});
  const placed=await call('headless.edit.execute',{projectId,sequenceId,expectedRevision:track.project.timeline.revision,operations:[{type:'insert-occurrence',occurrence:{id:'interview',name:'Interview',mediaId:video.resource.id,startTime:{value:'0',timescale:'1'},durationTime:{value:'10',timescale:'1'},sourceStartTime:{value:'0',timescale:'1'},track:0,role:'video'}}]});
  const revision=placed.after.timeline.revision, target={projectId,sequenceId,expectedRevision:revision};
  await call('media.understand',{projectId,mediaId:video.resource.id});
  const audioRef=(await call('headless.analysis.pin',{...target,mediaId:video.resource.id,kind:'audio',range:{start:0,end:10}})).ref;
  const brief={schemaVersion:1,id:'music-real',version:1,purpose:{kind:'specified',value:'interview'},audience:{kind:'no-preference'},durationSeconds:{min:9,max:11},aspectRatio:'16:9',theme:'natural',visualDirection:'natural',requiredContent:[],excludedContent:[],sourceCoverage:[],speechPolicy:{kind:'specified',value:'preserve'},musicPolicy:{kind:'specified',value:'background'},captionPolicy:{kind:'specified',value:'none'},inferences:[],reviewPrompts:[]};
  const draft=await call('headless.brief.create',{...target,brief}); await call('headless.brief.accept',{...target,expectedDigest:draft.record.digest,confirmed:true});
  const musicDuration=track.resource.metadata.durationTime;
  const inputPlan={projectId,timelineId:sequenceId,revision,occurrenceId:'interview',audioRef,caption:{style:'basic',maxWordsPerGroup:6,maxCharsPerLine:38,maxLines:2},music:{occurrenceId:'music-track',music:{mediaId:track.resource.id,source:music,sourceDigest:track.resource.sourceDigest,mediaKind:'audio',duration:Number(musicDuration.value)/Number(musicDuration.timescale)},placement:{start:2,end:8,startTime:{value:'2',timescale:'1'},durationTime:{value:'6',timescale:'1'}},gainDb:-24,targetLane:1,context:{speech:'unknown',audioEvidence:'unavailable'},capabilities:{staticMusicPreview:true,ducking:false,fades:false}}};
  const plan=await call('headless.decision.plan',inputPlan); if(plan.status!=='available') throw new Error(`Decision plan unavailable: ${plan.reason}`);
  const preview=await call('headless.decision.approved-preview-music',{...inputPlan,planDigest:plan.plan.planDigest});
  const applied=await call('headless.decision.approved-execute-music',{projectId,sequenceId,previewToken:preview.previewToken,approved:true});
  if(applied.status!=='applied') throw new Error('Music execution was not applied');
  const final=await call('headless.project.inspect',{projectId}), occurrence=final.timeline.sequence.occurrences.find((item)=>item.id==='music-track');
  const seconds=(value)=>Number(value?.value)/Number(value?.timescale);
  if(!occurrence || occurrence.mediaId!==track.resource.id || occurrence.role!=='music' || occurrence.track!==1 || occurrence.gainDb!==-24
    || seconds(occurrence.startTime)!==2 || seconds(occurrence.durationTime)!==6 || seconds(occurrence.sourceStartTime)!==0) throw new Error('Unexpected music placement');
  const outputPath=join(output,'approved-mixed.mp4');
  const render=await call('headless.render',{projectId,sequenceId,expectedRevision:final.timeline.revision,parameters:{outputPath,format:'mp4',width:320,height:180,frameRate:{value:'30',timescale:'1'}}});
  if(render.status!=='passed') throw new Error(`Render did not pass: ${render.status}`);
  const sha=async(path)=>createHash('sha256').update(await readFile(path)).digest('hex');
  const report={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),speechSha256:asset.sha256,musicSha256:config.music.sha256,preparedSpeechSha256:await sha(input),outputSha256:await sha(outputPath),ffmpegVersion,placementSeconds:[2,8],gainDb:-24,programmaticConfirmation:true,nativeWrites:false,nativeAcceptance:'unavailable',dialogueIntelligibility:'unavailable',limitation:'One exploratory headless run with programmatic confirmation. Audio levels, creative suitability and dialogue intelligibility require separate measurement or listening.'};
  await writeFile(join(output,'report.json'),`${JSON.stringify(report,null,2)}\n`); process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally {await client.close(); await transport.close();}
