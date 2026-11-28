// Usage: FRAMEKIT_WHISPER_MODEL=mlx-community/whisper-tiny node run-human-timing.mjs PINNED_PARQUET PYTHON [expanded]
// Python needs pyarrow and the selected speech backend. Set the remaining FRAMEKIT_* backend options explicitly.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAsset } from './corpus.mjs';
import { assessHumanBackendResponse, summarizeHumanTargets } from './caption-quality.mjs';
const [parquetArg,python,selection]=process.argv.slice(2);
if (!parquetArg || !python || process.argv.length>5) throw new Error('Expected pinned parquet and Python executable');
if (selection!==undefined && selection!=='expanded') throw new Error('Unknown human timing selection');
const configPath=fileURLToPath(new URL(selection==='expanded' ? './human-timing-expanded-case.json' : './human-timing-case.json',import.meta.url));
const config=JSON.parse(await readFile(configPath,'utf8'));
const parquet=resolve(parquetArg);
await verifyAsset(parquet,config.parquetSha256);
if (process.env.FRAMEKIT_WHISPER_MODEL!==config.model) throw new Error('Model does not match fixed case');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'framekit-human-timing-'));
try {
  const audioDirectory=join(temporary,'audio');
  const extractor=fileURLToPath(new URL('./extract-human-targets.py',import.meta.url));
  const extracted=execFileSync(python,[extractor,parquet,configPath,audioDirectory],{encoding:'utf8',maxBuffer:4*1024*1024});
  const extraction=JSON.parse(extracted), samples=extraction.samples;
  if(samples.length!==config.sampleIds.length || samples.some((sample,index)=>sample.id!==config.sampleIds[index])) throw new Error('Sample IDs differ from fixed case');
  const rows=[];
  for(const sample of samples){
    const media={mediaId:sample.id,source:join(audioDirectory,sample.file),sourceDigest:sample.audioSha256,mediaKind:'audio',duration:sample.duration};
    const revision={id:sample.id,sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
    const child=spawnSync(python,['apps/mcp-server/runtime/whisper-speech-backend.py'],{cwd:root,env:process.env,input:JSON.stringify({media,revision,range:{start:0,end:sample.duration}}),encoding:'utf8',maxBuffer:8*1024*1024});
    let assessment, provider=null, outputSha256=null;
    if(child.error || child.status!==0) assessment={status:'backend-error'};
    else {
      outputSha256=createHash('sha256').update(child.stdout).digest('hex');
      ({assessment,provider}=assessHumanBackendResponse(child.stdout,{text:sample.target,start:sample.start,end:sample.end},config.toleranceSeconds));
    }
    rows.push({id:sample.id,audioSha256:sample.audioSha256,duration:sample.duration,target:sample.target,humanRange:{start:sample.start,end:sample.end},provider,outputSha256,...assessment});
  }
  const report={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),datasetRevision:config.revision,parquetSha256:config.parquetSha256,pythonVersion:extraction.pythonVersion,pyarrowVersion:extraction.pyarrowVersion,declaredBackend:process.env.FRAMEKIT_WHISPER_BACKEND ?? null,declaredVadSha256:process.env.FRAMEKIT_SILERO_VAD_SHA256 ?? null,model:config.model,toleranceSeconds:config.toleranceSeconds,minimumWithinFraction:config.minimumWithinFraction,summary:summarizeHumanTargets(rows,config.minimumWithinFraction),rows,limitation:config.limitation+' Model declarations do not authenticate loaded bytes; no native operation or subjective listening was performed.'};
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { await rm(temporary,{recursive:true,force:true}); }
