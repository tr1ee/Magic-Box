import { FACTORY_FORMATS } from '../shared/formatFactory.mjs';

function number(body, key, fallback, min, max, integer = false) {
  if (body[key] == null || body[key] === '') return fallback;
  const value = Number(body[key]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} 必须在 ${min}–${max} 之间${integer ? '且为整数' : ''}。`);
  return value;
}
export function parseFactoryOptions(body, category) {
  const operation = body.operation || 'convert';
  const allowed = { video: ['convert','trim','merge','extract','crop','delogo','frames','split','mux','repair'], audio: ['convert','trim','merge','mix','split'], picture: ['convert'], document: ['convert','merge','split','pages'] };
  if (!allowed[category]?.includes(operation)) throw new Error('此分类不支持该操作。');
  const start = number(body, 'start', 0, 0, 604800);
  const end = number(body, 'end', null, 0, 604800);
  if (end !== null && end <= start) throw new Error('结束时间必须大于开始时间。');
  const rotation = number(body, 'rotation', 0, 0, 270, true);
  if (![0,90,180,270].includes(rotation)) throw new Error('旋转角度必须是 0、90、180 或 270。');
  const flip = body.flip || '';
  if (!['','horizontal','vertical'].includes(flip)) throw new Error('无效的翻转方向。');
  const watermarkPosition = body.watermarkPosition || 'southeast';
  if (!['northwest','northeast','center','southwest','southeast'].includes(watermarkPosition)) throw new Error('无效的水印位置。');
  const options = {
    operation, start, end, rotation, flip, watermarkPosition,
    width: number(body, 'width', null, 1, 16384, true), height: number(body, 'height', null, 1, 16384, true),
    speed: number(body, 'speed', 1, 0.25, 4), volume: number(body, 'volume', 1, 0, 5),
    fps: number(body, 'fps', null, 1, 120), bitrate: number(body, 'bitrate', null, 32, 50000, true),
    sampleRate: number(body, 'sampleRate', null, 8000, 192000, true), channels: number(body, 'channels', null, 1, 2, true),
    fadeIn: number(body, 'fadeIn', 0, 0, 60), fadeOut: number(body, 'fadeOut', 0, 0, 60),
    denoise: body.denoise === 'true', mute: body.mute === 'true',
    cropX: number(body, 'cropX', 0, 0, 16384, true), cropY: number(body, 'cropY', 0, 0, 16384, true),
    cropWidth: number(body, 'cropWidth', null, 1, 16384, true), cropHeight: number(body, 'cropHeight', null, 1, 16384, true),
    interval: number(body, 'interval', 10, 0.1, 3600), segmentSeconds: number(body, 'segmentSeconds', 60, 1, 86400),
    pages: String(body.pages || '').trim(), watermark: String(body.watermark || '').slice(0, 200)
  };
  if (['crop','delogo'].includes(operation) && (!options.cropWidth || !options.cropHeight)) throw new Error('请填写区域宽度和高度。');
  if (operation === 'delogo' && (!options.cropX || !options.cropY)) throw new Error('去水印区域需离画面边缘至少 1 像素。');
  if (options.pages && !/^\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*$/.test(options.pages)) throw new Error('页码格式示例：1-3,5。');
  return options;
}
export function pageIndices(range, count) {
  if (!range) return Array.from({ length: count }, (_, i) => i);
  const indices = [];
  for (const part of range.split(',')) {
    const [start, end = start] = part.trim().split('-').map(Number);
    if (start < 1 || end < start || end > count) throw new Error(`页码超出范围；此文档共 ${count} 页。`);
    for (let index = start; index <= end; index++) indices.push(index - 1);
    if (indices.length > 10000) throw new Error('一次最多处理 10000 页。');
  }
  return indices;
}
export function videoFilters(job) {
  const filters = [];
  if (job.operation === 'crop') filters.push(`crop=${job.cropWidth}:${job.cropHeight}:${job.cropX}:${job.cropY}`);
  if (job.operation === 'delogo') filters.push(`delogo=x=${job.cropX}:y=${job.cropY}:w=${job.cropWidth}:h=${job.cropHeight}`);
  if (job.rotation === 90) filters.push('transpose=1');
  if (job.rotation === 180) filters.push('hflip','vflip');
  if (job.rotation === 270) filters.push('transpose=2');
  if (job.flip) filters.push(job.flip === 'horizontal' ? 'hflip' : 'vflip');
  if (job.width || job.height) filters.push(`scale=${job.width || -2}:${job.height || -2}:force_original_aspect_ratio=decrease`);
  // H.264/yuv420p requires even dimensions, including after a crop or resize.
  filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (job.speed !== 1) filters.push(`setpts=PTS/${job.speed}`);
  if (job.fps) filters.push(`fps=${job.fps}`);
  return filters;
}
export function audioFilters(job, duration = 0) {
  const filters = [];
  if (job.speed !== 1) {
    let speed = job.speed;
    while (speed > 2) { filters.push('atempo=2'); speed /= 2; }
    while (speed < 0.5) { filters.push('atempo=0.5'); speed /= 0.5; }
    filters.push(`atempo=${speed}`);
  }
  if (job.volume !== 1) filters.push(`volume=${job.volume}`);
  if (job.denoise) filters.push('afftdn');
  if (job.fadeIn) filters.push(`afade=t=in:d=${job.fadeIn}`);
  if (job.fadeOut && duration) filters.push(`afade=t=out:st=${Math.max(0, duration - job.fadeOut)}:d=${job.fadeOut}`);
  return filters;
}
export function audioCodec(format, job) {
  const bitrate = `${job.bitrate || (job.quality === 'small' ? 96 : job.quality === 'balanced' ? 160 : 256)}k`;
  const codec = { mp3:'libmp3lame', wav:'pcm_s16le', m4a:'aac', aac:'aac', flac:'flac', ogg:'libvorbis', opus:'libopus', wma:'wmav2', aiff:'pcm_s16be', ac3:'ac3' }[format];
  if (!codec) throw new Error(`不支持音频输出 ${format}`);
  if (format === 'ogg') return ['-c:a',codec,...(job.bitrate ? ['-b:a',bitrate] : ['-q:a',job.quality === 'small' ? '2' : job.quality === 'balanced' ? '4' : '6']),...(job.sampleRate ? ['-ar',String(job.sampleRate)] : []),...(job.channels ? ['-ac',String(job.channels)] : [])];
  return ['-c:a', codec, ...(['wav','flac','aiff'].includes(format) ? [] : ['-b:a', bitrate]), ...(job.sampleRate ? ['-ar', String(job.sampleRate)] : []), ...(job.channels ? ['-ac', String(job.channels)] : [])];
}
export function videoCodec(format, job) {
  const crf = String(job.quality === 'small' ? 30 : job.quality === 'balanced' ? 24 : 18);
  if (format === 'webm') return ['-c:v','libvpx-vp9','-crf',crf,'-b:v',job.bitrate ? `${job.bitrate}k` : '0','-row-mt','1','-c:a','libopus','-b:a','128k'];
  const legacy = { avi:['mpeg4','libmp3lame'], wmv:['wmv2','wmav2'], flv:['flv','libmp3lame'], mpg:['mpeg2video','mp2'], '3gp':['h263','aac'] }[format];
  if (legacy) return ['-c:v',legacy[0],'-q:v',job.quality === 'small' ? '8' : '3','-c:a',legacy[1],'-b:a','128k', ...(format === '3gp' ? ['-ar','44100'] : []), ...(job.bitrate ? ['-b:v',`${job.bitrate}k`] : [])];
  return ['-c:v','libx264','-preset','medium',...(job.bitrate ? ['-b:v',`${job.bitrate}k`] : ['-crf',crf]),'-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',...(['mp4','mov'].includes(format) ? ['-movflags','+faststart'] : [])];
}
export function isAudioFile(item) { return FACTORY_FORMATS.audio.inputs.includes(item.sourceFormat); }
