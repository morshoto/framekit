import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFramekitRenderPlan, createFramekitRenderRequest } from '../../../packages/runtime/src/index.ts';
import { FfmpegTimelineRenderer } from '../../../adapters/headless/typescript/src/index.ts';

/** Sample changed pixels at planned title boundaries; this cannot prove glyph identity or native output. */
export async function renderCaptionProbe(source, expectedDigest, duration, groups, directory) {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (digest(await readFile(source)) !== expectedDigest) throw new Error('Source digest mismatch');
  if (!groups.length) throw new Error('Caption groups are required');
  const streams = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',source],{encoding:'utf8'})).streams;
  const video = streams.find((item)=>item.codec_type==='video');
  const audio = streams.find((item)=>item.codec_type==='audio');
  if (!video) throw new Error('Video source is required');
  const time = (n)=>({value:String(n),timescale:'1'});
  const resource = {id:'video',name:'Video',mediaKind:'video',source,sourceKind:'local-file',sourceDigest:expectedDigest,
    metadata:{durationTime:time(duration),streams:[{kind:'video',width:video.width,height:video.height,frameRate:time(30)},
      ...(audio ? [{kind:'audio',sampleRate:Number(audio.sample_rate),channels:audio.channels}] : [])]}};
  const timeline = {schemaVersion:1,project:{id:'caption-eval',name:'Caption evaluation'},revision:{id:'r1',sequence:1,timestamp:'2026-01-01T00:00:00.000Z'},resources:[resource],
    sequence:{id:'sequence',name:'Sequence',durationTime:time(duration),frameDuration:{value:'1',timescale:'30'},
      occurrences:[{id:'clip',name:'Clip',startTime:time(0),durationTime:time(duration),sourceStartTime:time(0),track:0,role:'video',mediaId:'video'}],
      storyElements:[],markers:[],captions:[],transitions:[],titles:[]}};
  const renderer = new FfmpegTimelineRenderer();
  async function render(name, titles) {
    const candidate = structuredClone(timeline); candidate.sequence.titles = titles;
    const path = join(directory,`${name}.mp4`);
    const request = createFramekitRenderRequest({timeline:candidate,target:{projectId:candidate.project.id,sequenceId:candidate.sequence.id},
      parameters:{outputPath:path,format:'mp4',width:320,height:180,frameRate:time(30)}});
    await renderer.render(createFramekitRenderPlan(request,renderer.capabilities(request)));
    return path;
  }
  const titles = groups.map((group,i)=>({id:`caption-${i}`,text:group.lines.join('\n'),startTime:group.sequenceRange.startTime,durationTime:group.sequenceRange.durationTime,lane:1}));
  const baseline = await render('caption-baseline',[]);
  const captions = await render('caption-output',titles);
  const frame = (path,index)=>execFileSync('ffmpeg',['-v','error','-i',path,'-vf',`select=eq(n\\,${index})`,'-fps_mode','passthrough','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:2*1024*1024});
  const samples = [];
  for (const [index,group] of groups.entries()) {
    const first = Math.round(group.sequenceRange.start*30), last = Math.round(group.sequenceRange.end*30)-1;
    if (first < 0 || last < first || Math.abs(group.sequenceRange.start*30-first)>1e-6 || Math.abs(group.sequenceRange.end*30-(last+1))>1e-6) throw new Error('Caption timing is not frame aligned');
    for (const position of [first,last]) {
      const a = frame(baseline,position), b = frame(captions,position);
      if (a.length !== 320*180*3 || b.length !== a.length) throw new Error('Caption frame unavailable');
      let changedPixels = 0;
      for (let i=0;i<a.length;i+=3) if (Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>40) changedPixels++;
      samples.push({group:index,frame:position,changedPixels});
    }
  }
  return {baselineSha256:digest(await readFile(baseline)),outputSha256:digest(await readFile(captions)),sampledActiveFrames:samples.length,
    framesWithChangedPixels:samples.filter((sample)=>sample.changedPixels>20).length,samples,textAccuracy:'unavailable',nativeStatus:'unavailable',
    limitation:'Pixel differences indicate rendered changes, not correct glyphs, readability, transcription accuracy or native output.'};
}
