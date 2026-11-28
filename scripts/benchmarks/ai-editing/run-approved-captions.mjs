// Usage: node --import tsx run-approved-captions.mjs SOURCE_WEBM PYTHON NEW_OUTPUT_DIRECTORY
// Set the FRAMEKIT_WHISPER_*, FRAMEKIT_SILERO_VAD_*, and FRAMEKIT_SPEECH_ANALYZER_{VERSION,MODEL_ID} variables.
// Confirmation is programmatic in a disposable headless project; it is not human or native approval.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadCorpus } from './corpus.mjs';
import { prepareApprovedCaptionOutput } from './caption-approved-preflight.mjs';

const [sourceArg, pythonArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !pythonArg || !outputArg || process.argv.length !== 5) throw new Error('Expected source, Python and new output directory');
for (const name of ['FRAMEKIT_WHISPER_BACKEND','FRAMEKIT_WHISPER_MODEL','FRAMEKIT_SILERO_VAD_MODEL','FRAMEKIT_SILERO_VAD_SHA256','FRAMEKIT_SPEECH_ANALYZER_VERSION','FRAMEKIT_SPEECH_ANALYZER_MODEL_ID']) {
  if (!process.env[name]?.trim()) throw new Error(`Missing ${name}`);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = resolve(sourceArg), python = resolve(pythonArg), output = resolve(outputArg);
const asset = (await loadCorpus()).supplementalAssets.find((item) => item.id === 'novara-interview');
await prepareApprovedCaptionOutput(source, output, asset.sha256);
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const first = join(output, 'interview-30.mp4'), input = join(output, 'input-with-tail.mp4'), renderedPath = join(output, 'approved-captions.mp4');
execFileSync(ffmpeg, ['-v','error','-ss','0','-i',source,'-t','30','-vf','scale=640:360,fps=30','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',first]);
execFileSync(ffmpeg, ['-v','error','-i',first,'-vf','tpad=stop_mode=clone:stop_duration=1','-af','apad=pad_dur=1','-t','31','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',input]);
const wrapper = join(output, 'speech-wrapper.mjs');
const backend = join(root, 'apps/mcp-server/runtime/whisper-speech-backend.py');
await writeFile(wrapper, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nlet input=''; for await (const chunk of process.stdin) input+=chunk;\nconst child=spawnSync(${JSON.stringify(python)},[${JSON.stringify(backend)}],{input,encoding:'utf8',maxBuffer:33554432,env:process.env});\nif(child.error) throw child.error; process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode=child.status ?? 1;\n`);
await chmod(wrapper, 0o700);
const env = {...process.env, FRAMEKIT_EDITOR:'final-cut-live', FRAMEKIT_AUTO_CONNECT:'0', FRAMEKIT_FINAL_CUT_HEADLESS:'1', FRAMEKIT_FINAL_CUT_NATIVE_WRITES:'0', FRAMEKIT_FINAL_CUT_SOCKET:join(output,'missing.sock'), FRAMEKIT_STATE_DIR:join(output,'state'), FRAMEKIT_SPEECH_ANALYZER:wrapper, FRAMEKIT_SPEECH_REQUIRE_VAD:'1', FRAMEKIT_AUDIO_ANALYZER:''};
const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx',join(root,'apps/mcp-server/src/main.ts')],env,stderr:'pipe'});
const client = new Client({name:'approved-caption-probe',version:'1.0.0'});
await client.connect(transport);
const call = async (name,args) => {
  const response = await client.callTool({name,arguments:args});
  if (response.isError || response.content?.[0]?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(response.content[0].text);
};
try {
  const timeline={schemaVersion:1,project:{id:'caption-real-eval',name:'Disposable caption eval'},sequence:{id:'sequence',name:'Sequence',durationTime:{value:'0',timescale:'1'},frameDuration:{value:'1',timescale:'30'},occurrences:[],storyElements:[],markers:[],captions:[],titles:[],transitions:[]},resources:[],revision:{id:'r0',sequence:0,timestamp:'2026-10-05T00:00:00.000Z'}};
  const created=await call('headless.project.create',{timeline}); const projectId=timeline.project.id, sequenceId=timeline.sequence.id;
  const media=await call('headless.media.register',{projectId,sourcePath:input,expectedRevision:created.timeline.revision});
  const placed=await call('headless.edit.execute',{projectId,sequenceId,expectedRevision:media.project.timeline.revision,operations:[{type:'insert-occurrence',placement:'append',occurrence:{id:'interview',name:'Interview',mediaId:media.resource.id,startTime:{value:'0',timescale:'1'},durationTime:{value:'31',timescale:'1'},sourceStartTime:{value:'0',timescale:'1'},track:0,role:'video'}}]});
  const revision=placed.after.timeline.revision;
  await call('media.understand',{projectId,mediaId:media.resource.id});
  const target={projectId,sequenceId,expectedRevision:revision};
  const brief={schemaVersion:1,id:'caption-real',version:1,purpose:{kind:'specified',value:'interview'},audience:{kind:'no-preference'},durationSeconds:{min:20,max:35},aspectRatio:'16:9',theme:'natural',visualDirection:'natural',requiredContent:['intro'],excludedContent:[],sourceCoverage:[{requirement:'intro',sourceId:media.resource.id,sourceDigest:media.resource.sourceDigest,start:0,end:1}],speechPolicy:{kind:'specified',value:'preserve'},musicPolicy:{kind:'specified',value:'none'},captionPolicy:{kind:'specified',value:'basic'},inferences:[],reviewPrompts:[]};
  const draft=await call('headless.brief.create',{...target,brief}); await call('headless.brief.accept',{...target,expectedDigest:draft.record.digest,confirmed:true});
  const pin={...target,mediaId:media.resource.id,range:{start:0,end:31}};
  const speechRef=(await call('headless.analysis.pin',{...pin,kind:'speech'})).ref, vadRef=(await call('headless.analysis.pin',{...pin,kind:'vad'})).ref;
  const decisionInput={projectId,timelineId:sequenceId,revision,occurrenceId:'interview',speechRef,vadRef,caption:{style:'basic',maxWordsPerGroup:6,maxCharsPerLine:38,maxLines:2},music:{occurrenceId:'music-plan',placement:{start:0,end:1},targetLane:-1,context:{speech:'present',audioEvidence:'unavailable'},capabilities:{staticMusicPreview:false,ducking:false,fades:false}}};
  const plan=await call('headless.decision.plan',decisionInput); if(plan.status!=='available') throw new Error(`Decision plan unavailable: ${plan.reason}`);
  const groups=plan.plan.decisions.filter((item)=>item.kind==='caption').map((item)=>({range:item.range,lines:item.group.lines}));
  if (!groups.length) throw new Error('No caption groups to review');
  const preview=await call('headless.decision.approved-preview-captions',{...decisionInput,planDigest:plan.plan.planDigest});
  const applied=await call('headless.decision.approved-execute-captions',{projectId,sequenceId,previewToken:preview.previewToken,approved:true});
  if(applied.status!=='applied') throw new Error('Caption execution was not applied');
  const final=await call('headless.project.inspect',{projectId});
  const render=await call('headless.render',{projectId,sequenceId,expectedRevision:final.timeline.revision,parameters:{outputPath:renderedPath,format:'mp4',width:320,height:180,frameRate:{value:'30',timescale:'1'}}});
  if(render.status!=='passed') throw new Error(`Render did not pass: ${render.status}`);
  const sha = async (path)=>createHash('sha256').update(await readFile(path)).digest('hex');
  const report={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:asset.sha256,sourceWindowSeconds:[0,30],addedTailSeconds:1,inputSha256:await sha(input),outputSha256:await sha(renderedPath),ffmpegVersion:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0],providerVersion:env.FRAMEKIT_SPEECH_ANALYZER_VERSION,declaredModel:env.FRAMEKIT_WHISPER_MODEL,groups,programmaticConfirmation:true,nativeWrites:false,nativeAcceptance:'unavailable',limitation:'One exploratory headless run with programmatic confirmation. Text and speech timestamps are not independently verified; model declarations do not authenticate model bytes.'};
  await writeFile(join(output,'report.json'),`${JSON.stringify(report,null,2)}\n`);
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { await client.close(); await transport.close(); }
