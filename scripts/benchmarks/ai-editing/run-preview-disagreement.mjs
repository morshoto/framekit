// Usage: FRAMEKIT_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo node run-preview-disagreement.mjs DERIVED_MP4 PYTHON
// Input must be the exact derived file from run-production-cut-preview.mjs; model declarations do not authenticate model bytes.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyAsset } from './corpus.mjs';
import { adjacentCandidateWords, compareProviderCuts } from './evidence-quality.mjs';
const [path,python]=process.argv.slice(2);
if(!path || !python || process.argv.length!==4) throw new Error('Expected derived source and Python executable');
const config=JSON.parse(await readFile(new URL('./preview-disagreement-case.json',import.meta.url),'utf8'));
await verifyAsset(path,config.inputSha256);
if(process.env.FRAMEKIT_WHISPER_MODEL!==config.model) throw new Error('Secondary model does not match fixed case');
const repository=fileURLToPath(new URL('../../../',import.meta.url));
const media={mediaId:'preview-disagreement',source:path,sourceDigest:config.inputSha256,mediaKind:'video',duration:config.durationSeconds};
const revision={id:'preview-disagreement',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'};
const backend=spawnSync(python,['apps/mcp-server/runtime/whisper-speech-backend.py'],{cwd:repository,env:process.env,input:JSON.stringify({media,revision,range:{start:0,end:config.durationSeconds}}),encoding:'utf8',maxBuffer:32*1024*1024});
if(backend.error) throw backend.error;
if(backend.status!==0) throw new Error(`Speech backend failed: ${backend.stderr}`);
const response=JSON.parse(backend.stdout), hash=(text)=>createHash('sha256').update(text).digest('hex');
const screening=compareProviderCuts([config.candidate],config.inputSha256,{sourceSha256:config.inputSha256,coverage:response.observedRange,words:response.words});
const report={gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),inputSha256:config.inputSha256,candidateRelativeSeconds:config.candidate,originalSourceOffsetSeconds:config.originalSourceOffsetSeconds,primaryModel:config.primaryModel,declaredSecondaryModel:config.model,secondaryProvider:response.provider,backendOutputSha256:hash(backend.stdout),recognizedWords:response.words.length,screening,adjacentWords:screening.status==='unavailable' ? null : adjacentCandidateWords(config.candidate,response.words),adjacentWordsDesignation:'Post hoc context; not verified boundaries.',limitation:config.interpretation+' Same transformed input and requested duration; model declarations do not authenticate loaded bytes. No native execution or listening was performed.'};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
