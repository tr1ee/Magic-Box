import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createFormatFactoryManager } from '../server/format_factory.mjs';
import { FACTORY_FORMATS } from '../shared/formatFactory.mjs';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const ffmpeg = require('ffmpeg-static'), ffprobe = require('ffprobe-static').path;
let root, manager, server, url, video, silent, audio, picture, pdf;
async function probe(file) { return JSON.parse((await exec(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{windowsHide:true})).stdout); }
async function submit(category, outputFormat, files, options = {}, expectedStatus = 202) {
  const form = new FormData();
  Object.entries({category,outputFormat,outputDir:path.join(root,'outputs'),...options}).forEach(([key,value]) => form.append(key,String(value)));
  files.forEach(([name,data]) => form.append('files',new Blob([data]),name));
  const response = await fetch(`${url}/jobs`,{method:'POST',body:form});
  const job = await response.json(); assert.equal(response.status,expectedStatus,JSON.stringify(job));
  return job;
}
async function finish(job, successful = true) {
  const deadline = Date.now()+60000;
  while (!['completed','failed','cancelled'].includes(job.status) && Date.now()<deadline) {
    await new Promise(resolve => setTimeout(resolve,30));
    job = await (await fetch(`${url}/jobs/${job.id}`)).json();
  }
  if (successful) { assert.equal(job.status,'completed',JSON.stringify(job)); assert.equal(job.error,null,JSON.stringify(job)); for (const output of job.outputs) assert.ok((await fs.stat(output.path)).size > 0); }
  return job;
}
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(),'magicbox-factory-tests-'));
  manager = createFormatFactoryManager({defaultDownloadDir:root});
  const app = express(); app.use('/factory',manager.router);
  server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  url = `http://127.0.0.1:${server.address().port}/factory`;
  await exec(ffmpeg,['-y','-f','lavfi','-i','testsrc2=size=160x120:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(root,'clip.mp4')],{windowsHide:true});
  await exec(ffmpeg,['-y','-f','lavfi','-i','color=c=blue:s=120x160:r=12','-t','1','-c:v','libx264',path.join(root,'silent.mp4')],{windowsHide:true});
  await exec(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=660:sample_rate=44100','-t','2',path.join(root,'audio.wav')],{windowsHide:true});
  video=await fs.readFile(path.join(root,'clip.mp4')); silent=await fs.readFile(path.join(root,'silent.mp4')); audio=await fs.readFile(path.join(root,'audio.wav'));
  picture=await sharp({create:{width:80,height:40,channels:4,background:'#3d8eaa'}}).png().toBuffer();
  const doc=await PDFDocument.create(); doc.addPage([100,200]); doc.addPage([200,300]); doc.addPage([300,400]); pdf=await doc.save();
});
after(async () => { await manager?.close(); if(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } if(root) await fs.rm(root,{recursive:true,force:true}); });

test('all advertised video output formats produce readable streams',async () => {
  for(const format of FACTORY_FORMATS.video.outputs) {
    const job=await finish(await submit('video',format,[['clip.mp4',video]]));
    if(format === 'm3u8') {
      const manifest=await fs.readFile(job.outputs[0].path,'utf8');
      assert.match(manifest,/#EXT-X-ENDLIST/);
      assert.ok(job.outputs.some(output=>output.name.endsWith('.ts')));
      // The legacy bundled ffprobe cannot resolve Windows HLS relative paths reliably;
      // validate actual playback with the bundled FFmpeg decoder instead.
      await exec(ffmpeg,['-v','error','-i',job.outputs[0].path,'-t','0.1','-f','null','-'],{windowsHide:true,cwd:path.dirname(job.outputs[0].path)});
      continue;
    }
    assert.ok((await probe(job.outputs[0].path)).streams.some(stream => stream.codec_type === 'video'),format);
  }
});
test('all advertised audio output formats produce readable audio',async () => {
  for(const format of FACTORY_FORMATS.audio.outputs) {
    const job=await finish(await submit('audio',format,[['tone.wav',audio]]));
    assert.ok((await probe(job.outputs[0].path)).streams.some(stream => stream.codec_type === 'audio'),format);
  }
});
test('all picture outputs, Unicode watermark and rotation work',async () => {
  for(const format of FACTORY_FORMATS.picture.outputs) {
    const job=await finish(await submit('picture',format,[['照片.png',picture]],{rotation:90,watermark:'魔盒',width:40}));
    const info=['bmp','ico','tga'].includes(format) ? (await probe(job.outputs[0].path)).streams[0] : await sharp(job.outputs[0].path).metadata();
    assert.ok(info.width>0,format);
    assert.ok(job.outputs[0].name.startsWith('照片'),job.outputs[0].name);
    if(format !== 'ico') assert.equal(info.width,40,format);
  }
});
test('BMP, ICO and TGA input round trips',async () => {
  for(const format of ['bmp','ico','tga']) {
    const output=await finish(await submit('picture',format,[['image.png',picture]]));
    const job=await finish(await submit('picture','png',[[`image.${format}`,await fs.readFile(output.outputs[0].path)]]));
    assert.equal((await sharp(job.outputs[0].path).metadata()).format,'png');
  }
});
test('opaque rectangular images become valid square RGBA icons',async () => {
  const rgb=await sharp({create:{width:640,height:360,channels:3,background:'#138d90'}}).png().toBuffer();
  const job=await finish(await submit('picture','ico',[['opaque.png',rgb]]));
  const info=(await probe(job.outputs[0].path)).streams[0];
  assert.deepEqual([info.width,info.height],[256,256]);
});
test('trim and speed change the actual duration; extracting audio removes video',async () => {
  const job=await finish(await submit('video','mp3',[['clip.mp4',video]],{operation:'extract',start:0.5,end:1.5,speed:2,fadeIn:0.1,fadeOut:0.1,denoise:true}));
  const info=await probe(job.outputs[0].path);
  assert.ok(Number(info.format.duration)<0.7,info.format.duration);
  assert.ok(info.streams.every(stream => stream.codec_type !== 'video'));
  const trimmed=await finish(await submit('video','mp4',[['clip.mp4',video]],{operation:'trim',start:0.5,end:1.5}));
  assert.ok(Math.abs(Number((await probe(trimmed.outputs[0].path)).format.duration)-1)<0.2);
});
test('crop, rotation, delogo and frames operate on actual pixels',async () => {
  const crop=await finish(await submit('video','mp4',[['clip.mp4',video]],{operation:'crop',cropWidth:80,cropHeight:60,cropX:10,cropY:10,rotation:90}));
  const stream=(await probe(crop.outputs[0].path)).streams.find(s=>s.codec_type==='video');
  assert.deepEqual([stream.width,stream.height],[60,80]);
  await finish(await submit('video','mp4',[['clip.mp4',video]],{operation:'delogo',cropWidth:20,cropHeight:20,cropX:10,cropY:10}));
  const frames=await finish(await submit('video','png',[['clip.mp4',video]],{operation:'frames',interval:0.5}));
  assert.equal(frames.outputs.length,4);
});
test('video merge handles different dimensions and missing audio; mux adds audio',async () => {
  const merged=await finish(await submit('video','mp4',[['clip.mp4',video],['silent.mp4',silent]],{operation:'merge'}));
  assert.ok(Math.abs(Number((await probe(merged.outputs[0].path)).format.duration)-3)<0.3);
  const muxed=await finish(await submit('video','mp4',[['silent.mp4',silent],['audio.wav',audio]],{operation:'mux'}));
  assert.equal((await probe(muxed.outputs[0].path)).streams.length,2);
});
test('audio merge, mix, segmentation and original copies work',async () => {
  for(const operation of ['merge','mix']) {
    const job=await finish(await submit('audio','wav',[['a.wav',audio],['b.wav',audio]],{operation,keepOriginal:true}));
    assert.equal(job.outputs.length,3);
    const duration=Number((await probe(job.outputs[0].path)).format.duration);
    assert.ok(Math.abs(duration-(operation==='merge'?4:2))<0.15,duration);
  }
  const split=await finish(await submit('audio','mp3',[['a.wav',audio]],{operation:'split',segmentSeconds:1}));
  assert.ok(split.outputs.length>=2);
  const vsplit=await finish(await submit('video','mp4',[['clip.mp4',video]],{operation:'split',segmentSeconds:1}));
  assert.ok(vsplit.outputs.length>=2);
});
test('PDF page selection, rotation, splitting, merging and Unicode PDF work',async () => {
  const job=await finish(await submit('document','pdf',[['doc.pdf',pdf]],{operation:'pages',pages:'3,1',rotation:90}));
  const output=await PDFDocument.load(await fs.readFile(job.outputs[0].path));
  assert.equal(output.getPageCount(),2); assert.equal(output.getPage(0).getWidth(),300); assert.equal(output.getPage(0).getRotation().angle,90);
  const split=await finish(await submit('document','pdf',[['doc.pdf',pdf]],{operation:'split',pages:'1-2'})); assert.equal(split.outputs.length,2);
  const merged=await finish(await submit('document','pdf',[['one.pdf',pdf],['two.pdf',pdf]],{operation:'merge',keepOriginal:true}));
  assert.equal(merged.outputs.length,3);
  await finish(await submit('document','pdf',[['中文.txt',Buffer.from('格式工厂，中文内容保留。')]]));
});
test('invalid operations, time ranges, pages and incompatible inputs fail explicitly',async () => {
  await submit('audio','mp3',[['a.wav',audio]],{operation:'trim',start:2,end:1},400);
  await submit('video','mp4',[['clip.mp4',video]],{operation:'crop'},400);
  await submit('video','mp4',[['clip.mp4',video]],{operation:'mux'},400);
  await submit('picture','png',[['image.png',picture]],{operation:'execute'},400);
  await submit('document','txt',[['image.png',picture]],{},400);
  await submit('document','pdf',[['doc.pdf',pdf]],{pages:'1;delete'},400);
  const job=await finish(await submit('document','pdf',[['doc.pdf',pdf]],{operation:'pages',pages:'99'}),false); assert.equal(job.status,'failed');
});
test('output directory failure finalizes the job; listing survives view changes',async () => {
  const blocked=path.join(root,'not-a-directory'); await fs.writeFile(blocked,'file');
  const job=await finish(await submit('picture','png',[['image.png',picture]],{outputDir:blocked}),false);
  assert.equal(job.status,'failed'); assert.equal(job.items[0].status,'failed');
  const listing=await (await fetch(`${url}/jobs`)).json(); assert.ok(listing.jobs.some(entry=>entry.id===job.id));
});
test('cancel leaves a terminal state and cleans upload and partial output files',async () => {
  const job=await submit('video','webm',[['clip.mp4',video]],{width:1920,height:1080});
  const internal=manager.jobs.get(job.id);
  const activeDelete=await fetch(`${url}/jobs/${job.id}`,{method:'DELETE'}); assert.equal(activeDelete.status,409);
  await fetch(`${url}/jobs/${job.id}/cancel`,{method:'POST'});
  const done=await finish(job,false); assert.equal(done.status,'cancelled');
  await internal.finished;
  await assert.rejects(fs.access(internal.items[0].tempPath));
  for(const partial of internal.partialOutputs) await assert.rejects(fs.access(partial));
  const removed=await fetch(`${url}/jobs/${job.id}`,{method:'DELETE'}); assert.equal(removed.status,200);
  const listing=await (await fetch(`${url}/jobs`)).json(); assert.ok(!listing.jobs.some(entry=>entry.id===job.id));
});
