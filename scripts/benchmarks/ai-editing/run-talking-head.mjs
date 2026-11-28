// Usage: node --import tsx run-talking-head.mjs SOURCE_WEBM PYTHON [NEW_OUTPUT_DIRECTORY]
// Configure the production speech backend through FRAMEKIT_* environment variables.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadCorpus, verifyAsset } from './corpus.mjs';
import { probeCaptionPlan } from './caption-plan-probe.mjs';
import { renderCaptionProbe } from './caption-render-probe.mjs';

const [file,python,outputDirectory] = process.argv.slice(2);
if (!file || !python) throw new Error('Expected interview video and Python');
const asset = (await loadCorpus()).supplementalAssets.find((item)=>item.id==='novara-interview');
await verifyAsset(file,asset.sha256);
const directory = await mkdtemp(join(tmpdir(),'framekit-talking-head-'));
try {
  const sample = join(directory,'sample.mp4');
  execFileSync('ffmpeg',['-v','error','-ss','0','-i',file,'-t','30','-vf','scale=640:360,fps=30','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-ac','2','-ar','48000',sample]);
  const hash = (bytes)=>createHash('sha256').update(bytes).digest('hex');
  const sampleDigest = hash(await readFile(sample));
  const media = {mediaId:asset.id,source:sample,sourceDigest:sampleDigest,mediaKind:'video',duration:30};
  const revision = {id:'talking-head',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
  const repository = fileURLToPath(new URL('../../../',import.meta.url));
  const child = spawnSync(python,['apps/mcp-server/runtime/whisper-speech-backend.py'],{cwd:repository,env:process.env,
    input:JSON.stringify({media,revision,range:{start:0,end:30}}),encoding:'utf8',maxBuffer:32*1024*1024});
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Speech backend failed: ${child.stderr}`);
  const output = JSON.parse(child.stdout);
  const model = process.env.FRAMEKIT_WHISPER_MODEL ?? 'unknown';
  const provider = {...output.provider,model,configurationDigest:hash(JSON.stringify({model,vad:process.env.FRAMEKIT_SILERO_VAD_SHA256 ?? null}))};
  const plan = await probeCaptionPlan(media,revision,provider,output,{includeGroups:!!outputDirectory});
  const groups = plan.captionGroups;
  delete plan.captionGroups;
  let rendered;
  if (outputDirectory && groups) {
    await mkdir(outputDirectory);
    rendered = await renderCaptionProbe(sample,sampleDigest,30,groups,outputDirectory);
    const midpoint = (groups[0].sequenceRange.start + groups[0].sequenceRange.end) / 2;
    execFileSync('ffmpeg',['-v','error','-ss',String(midpoint),'-i',join(outputDirectory,'caption-output.mp4'),'-frames:v','1',join(outputDirectory,'caption-sample.png')]);
  }
  const report = {gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),sourceSha256:asset.sha256,
    sourceWindowSeconds:asset.windowSeconds,derivedSha256:sampleDigest,backendOutputSha256:hash(child.stdout),declaredModel:model,provider:output.provider,plan,...(rendered ? {rendered} : {}),
    limitation:'No independently checked transcript or word boundaries. Plan coverage is relative to recognized words only; it does not verify caption rendering or native acceptance. Declared model identity does not authenticate loaded bytes.'};
  if (outputDirectory && rendered) await writeFile(join(outputDirectory,'report.json'),`${JSON.stringify(report,null,2)}\n`);
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { await rm(directory,{recursive:true,force:true}); }
