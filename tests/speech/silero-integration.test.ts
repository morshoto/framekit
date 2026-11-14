import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function run(t: test.TestContext, options: { badDigest?: boolean; required?: boolean; intervals?: unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "framekit-silero-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.wav"), model = join(root, "model.jit");
  await writeFile(source, "synthetic source");
  await writeFile(model, "pinned VAD model");
  for (const name of ["mlx_whisper", "silero_vad"]) await mkdir(join(root, name));
  await writeFile(join(root, "mlx_whisper/__init__.py"), 'def transcribe(*args, **kwargs):\n return {"segments":[{"start":1.25,"end":1.75,"words":[{"word":"hello","start":1.25,"end":1.75,"probability":0.9}]}]}\n');
  await writeFile(join(root, "torch.py"), [
    'float32 = "f32"', 'def set_num_threads(n): assert n == 1',
    'class Tensor:', ' def __init__(self,n): self.n=n', ' def __len__(self): return self.n',
    ' def numel(self): return self.n', ' def clone(self): return self',
    'def frombuffer(data,dtype): return Tensor(len(data)//4)',
    'class Model:', ' def eval(self): return self',
    'class jit:', ' @staticmethod', ' def load(path,map_location): assert map_location=="cpu"; return Model()',
  ].join('\n'));
  await writeFile(join(root, "silero_vad/__init__.py"), [
    'import json, os',
    'def get_speech_timestamps(audio,model,**options):',
    ' assert len(audio)==64000',
    ' assert options == {"sampling_rate":16000,"threshold":0.5,"min_speech_duration_ms":250,"min_silence_duration_ms":100,"speech_pad_ms":30,"return_seconds":False}',
    ' return json.loads(os.environ["TEST_VAD_INTERVALS"])',
  ].join('\n'));
  const ffmpeg = join(root, "ffmpeg");
  await writeFile(ffmpeg, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.alloc(64000*4));\n');
  await chmod(ffmpeg, 0o755);
  const request = { schemaVersion: 1, media: { mediaId: "media", source, duration: 4 },
    revision: { id: "rev-1", sequence: 1, timestamp: "2026-11-15T00:00:00Z" }, range: { start: 1, end: 3 } };
  const result = await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn('python3',['scripts/whisper-speech-backend.py'],{env:{...process.env,
      PATH:root+':'+process.env.PATH,PYTHONPATH:root,FRAMEKIT_WHISPER_BACKEND:'mlx-whisper',FRAMEKIT_WHISPER_MODEL:'fixture',
      FRAMEKIT_SILERO_VAD_MODEL:model,FRAMEKIT_SILERO_VAD_SHA256:options.badDigest?'0'.repeat(64):createHash('sha256').update('pinned VAD model').digest('hex'),
      FRAMEKIT_SPEECH_REQUIRE_VAD:options.required?'1':'0',FRAMEKIT_SPEECH_ANALYZER_VERSION:'fixture-asr-vad@1',
      TEST_VAD_INTERVALS:JSON.stringify(options.intervals??[{start:8000,end:20000},{start:32000,end:52000}]),
    },stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x;});child.stderr.on('data',x=>{stderr+=x;});
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(request));
  });
  return {...result,request};
}

test("optional Silero evidence retains source sample coordinates and strict request provenance", async t=>{
  const result=await run(t,{required:true});assert.equal(result.code,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.deepEqual(data.words,[{text:'hello',start:1.25,end:1.75,confidence:0.9}]);
  assert.deepEqual(data.vadSegments,[{start:1,end:1.25,kind:'speech'},{start:2,end:3,kind:'speech'}]);
  assert.deepEqual(data.sourceTimebase,{value:'1',timescale:'16000'});
  assert.deepEqual(data.observedRange,{start:1,end:3});
  assert.deepEqual(data.sourceIdentity,result.request.media);
  assert.deepEqual(data.revision,result.request.revision);
  assert.deepEqual(data.requestedRange,result.request.range);
  assert.deepEqual(data.provider,{id:'command.speech',provider:'command',version:'fixture-asr-vad@1'});
});

test("optional VAD model failure preserves transcription with an explicit unavailable reason",async t=>{
  const result=await run(t,{badDigest:true});assert.equal(result.code,0,result.stderr);
  const data=JSON.parse(result.stdout);
  assert.equal(data.words[0].text,'hello');assert.equal(data.vadSegments,undefined);
  assert.equal(data.vadUnavailableReason,'SILERO_VAD_MODEL_MISMATCH');
});

test("required VAD model failure rejects the combined provider result",async t=>{
  const result=await run(t,{badDigest:true,required:true});assert.notEqual(result.code,0);
  assert.equal(result.stdout,'');assert.match(result.stderr,/SILERO_VAD_MODEL_MISMATCH/);
});

for(const intervals of [[{start:-1,end:20000}],[{start:1,end:64001}],[{start:100,end:100}],[{start:100,end:100.5}],[{start:100,end:200},{start:199,end:300}]]) {
  test(`Silero rejects malformed sample evidence ${JSON.stringify(intervals)}`,async t=>{
    const result=await run(t,{intervals});assert.equal(result.code,0,result.stderr);
    const data=JSON.parse(result.stdout);assert.equal(data.vadSegments,undefined);
    assert.equal(data.vadUnavailableReason,'SILERO_VAD_OUTPUT_INVALID');
  });
}
