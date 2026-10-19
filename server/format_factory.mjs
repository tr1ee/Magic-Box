import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { FACTORY_FORMATS, OFFICE_INPUTS, FACTORY_TOOLS } from '../shared/formatFactory.mjs';
import { parseFactoryOptions, pageIndices, videoFilters, audioFilters, audioCodec, videoCodec, isAudioFile } from './format_factory_options.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const jobTtlMs = 60 * 60 * 1000;
const maxJobs = 40;
const maxFiles = 100;
const maxFileBytes = 4 * 1024 * 1024 * 1024;
const categoryFormats = Object.fromEntries(Object.entries(FACTORY_FORMATS).map(([key, value]) => [key, { inputs: new Set(value.inputs), outputs: new Set(value.outputs) }]));

let sharpPromise;
let pdfJsPromise;
let canvasPromise;
let libreOfficePromise;

function extensionOf(fileName) {
  return path.extname(String(fileName || "")).slice(1).toLowerCase();
}

function cleanStem(fileName) {
  return path.basename(String(fileName || "file"), path.extname(String(fileName || "")))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "file";
}

function cleanFileName(fileName) {
  const extension = extensionOf(fileName);
  return `${cleanStem(fileName)}${extension ? `.${extension}` : ""}`;
}

function decodeUploadName(name) {
  if ([...name].some(char => char.charCodeAt(0) > 255)) return name;
  try { return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(name,'latin1')); }
  catch { return name; }
}

async function uniqueOutputPath(outputDir, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(outputDir, fileName);
  let suffix = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(outputDir, `${stem}-${suffix}${extension}`);
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

function normalizeOutputDir(outputDir, fallbackDir) {
  const value = typeof outputDir === "string" && outputDir.trim()
    ? outputDir.trim()
    : path.join(fallbackDir, "Format Factory");
  return path.resolve(value);
}

function normalizeQuality(value) {
  return ["high", "balanced", "small"].includes(value) ? value : "high";
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    sourceFormat: item.sourceFormat,
    targetFormat: item.targetFormat,
    status: item.status,
    progress: item.progress,
    error: item.error || null,
    outputs: item.outputs || []
  };
}

function jobSnapshot(job) {
  const liveProgress = job.items.length
    ? Math.round(job.items.reduce((total, item) => total + (Number(item.progress) || 0), 0) / job.items.length)
    : 0;
  return {
    id: job.id,
    category: job.category,
    operation: job.operation,
    status: job.status,
    progress: Math.max(Number(job.progress) || 0, liveProgress),
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    outputDir: job.outputDir,
    error: job.error || null,
    items: job.items.map(publicItem),
    outputs: job.outputs || []
  };
}

function pruneJobs(jobs) {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && ["completed", "failed", "cancelled"].includes(job.status)) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= maxJobs) return;
  const removable = Array.from(jobs.values())
    .filter((job) => ["completed", "failed", "cancelled"].includes(job.status))
    .sort((left, right) => left.createdAt - right.createdAt);
  while (jobs.size > maxJobs && removable.length) {
    jobs.delete(removable.shift().id);
  }
}

async function loadSharp() {
  sharpPromise ||= import("sharp").then((module) => module.default);
  return sharpPromise;
}

async function loadPdfRenderer() {
  if (!canvasPromise) {
    canvasPromise = import("@napi-rs/canvas").then((canvas) => {
      if (!globalThis.DOMMatrix && canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
      if (!globalThis.ImageData && canvas.ImageData) globalThis.ImageData = canvas.ImageData;
      if (!globalThis.Path2D && canvas.Path2D) globalThis.Path2D = canvas.Path2D;
      return canvas;
    });
  }
  const canvas = await canvasPromise;
  pdfJsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  return { canvas, pdfjs: await pdfJsPromise };
}

async function locateLibreOffice() {
  if (libreOfficePromise) return libreOfficePromise;
  libreOfficePromise = (async () => {
    const candidates = [
      process.env.LIBREOFFICE_PATH,
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "LibreOffice", "program", "soffice.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "LibreOffice", "program", "soffice.exe"),
      process.platform === "darwin" ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : null,
      process.platform !== "win32" && process.platform !== "darwin" ? "/usr/bin/soffice" : null
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) return candidate;
    }
    try {
      const locator = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(locator, ["soffice"], { windowsHide: true, timeout: 4000 });
      const first = stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
      return first && fsSync.existsSync(first) ? first : null;
    } catch {
      return null;
    }
  })();
  return libreOfficePromise;
}

function imageQuality(quality) {
  return quality === "small" ? 62 : quality === "balanced" ? 82 : 94;
}

async function convertPicture(item, job) {
  const sharp = await loadSharp();
  const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}.${item.targetFormat}`);
  let sourcePath = item.tempPath;
  if (['bmp','ico','tga'].includes(item.sourceFormat)) {
    sourcePath = `${item.tempPath}.decoded.png`;
    job.scratchFiles.push(sourcePath);
    await runFfmpeg(item, job, sourcePath, ['-y','-i',item.tempPath,'-frames:v','1',sourcePath]);
  }
  let pipeline = sharp(sourcePath, { animated: !['bmp','ico','tga'].includes(item.targetFormat) });
  if (job.rotation) pipeline = pipeline.rotate(job.rotation);
  if (job.flip === 'horizontal') pipeline = pipeline.flop();
  if (job.flip === 'vertical') pipeline = pipeline.flip();
  if (job.width || job.height) {
    pipeline = pipeline.resize(job.width || null, job.height || null, { fit: "inside", withoutEnlargement: false });
  }
  const quality = imageQuality(job.quality);
  if (job.watermark) {
    const { canvas } = await loadPdfRenderer();
    const meta = await sharp(await pipeline.png().toBuffer()).metadata();
    const surface = canvas.createCanvas(Math.max(1, meta.width), Math.max(1, meta.height));
    const ctx = surface.getContext('2d');
    const size = Math.max(12, Math.round(Math.min(meta.width, meta.height) / 20));
    ctx.font = `${size}px "Microsoft YaHei", sans-serif`;
    const right = job.watermarkPosition.endsWith('east');
    const top = job.watermarkPosition.startsWith('north');
    const center = job.watermarkPosition === 'center';
    ctx.textAlign = center ? 'center' : right ? 'right' : 'left';
    ctx.textBaseline = center ? 'middle' : top ? 'top' : 'bottom';
    ctx.lineWidth = Math.max(1, size / 12); ctx.strokeStyle = '#0009'; ctx.fillStyle = '#fffd';
    const x = center ? meta.width / 2 : right ? meta.width - 8 : 8;
    const y = center ? meta.height / 2 : top ? 8 : meta.height - 8;
    ctx.strokeText(job.watermark, x, y, Math.max(1, meta.width - 16)); ctx.fillText(job.watermark, x, y, Math.max(1, meta.width - 16));
    pipeline = pipeline.composite([{ input: await surface.encode('png') }]);
  }
  if (['bmp','ico','tga'].includes(item.targetFormat)) {
    const intermediate = `${item.tempPath}.output.png`;
    job.scratchFiles.push(intermediate);
    if (item.targetFormat === 'ico') pipeline = pipeline.ensureAlpha().resize(256,256,{ fit:'contain', background:{r:0,g:0,b:0,alpha:0} });
    await pipeline.png().toFile(intermediate);
    await runFfmpeg(item, job, outputPath, ['-y','-i',intermediate,'-frames:v','1',...(item.targetFormat === 'ico' ? ['-c:v','png'] : []),outputPath]);
    return [outputPath];
  }
  switch (item.targetFormat) {
    case "jpg": pipeline = pipeline.jpeg({ quality, mozjpeg: true }); break;
    case "png": pipeline = pipeline.png({ compressionLevel: job.quality === "small" ? 9 : 7 }); break;
    case "webp": pipeline = pipeline.webp({ quality }); break;
    case "avif": pipeline = pipeline.avif({ quality: Math.max(35, quality - 18) }); break;
    case "tiff": pipeline = pipeline.tiff({ quality, compression: "lzw" }); break;
    case "gif": pipeline = pipeline.gif({ effort: job.quality === "high" ? 7 : 4 }); break;
    default: throw new Error(`Picture output .${item.targetFormat} is not supported.`);
  }
  if (job.keepMetadata) pipeline = pipeline.withMetadata();
  await pipeline.toFile(outputPath);
  return [outputPath];
}

async function probeDuration(inputPath) {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath
    ], { windowsHide: true, timeout: 30000 });
    const duration = Number.parseFloat(stdout);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

async function runFfmpeg(item, job, outputPath, args) {
  const duration = await probeDuration(item.tempPath);
  if (job.cancelRequested) throw new Error('Conversion cancelled.');
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    job.process = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        const [key, rawValue] = line.split("=", 2);
        if (duration && (key === "out_time_ms" || key === "out_time_us")) {
          const seconds = Number(rawValue) / 1_000_000;
          if (Number.isFinite(seconds)) item.progress = Math.max(item.progress, Math.min(98, Math.round((seconds / duration) * 100)));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-24000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      job.process = null;
      if (job.cancelRequested) {
        reject(new Error("Conversion cancelled."));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `FFmpeg exited with code ${code}.`));
      }
    });
  });
}

async function convertMedia(item, job) {
  const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}.${item.targetFormat}`);
  const args = ['-y', ...(job.operation === 'repair' ? ['-err_detect','ignore_err','-fflags','+genpts+discardcorrupt'] : []), ...(job.start ? ['-ss',String(job.start)] : []), '-i',item.tempPath];
  const duration = await probeDuration(item.tempPath);
  if (job.end !== null) args.push('-t',String((job.end - job.start) / job.speed));
  const audioOnly = job.category === 'audio' || job.operation === 'extract';
  const af = audioFilters(job, ((job.end || duration) - job.start) / job.speed);
  if (audioOnly) args.push('-vn',...audioCodec(item.targetFormat,job));
  else {
    const vf = videoFilters(job);
    if (item.targetFormat === '3gp') vf.push('scale=352:288:force_original_aspect_ratio=decrease','pad=352:288:(ow-iw)/2:(oh-ih)/2');
    if (item.targetFormat === 'gif') vf.push('fps=12','scale=min(1280\\,iw):-2:flags=lanczos');
    if (job.operation === 'frames') vf.push(`fps=1/${job.interval}`);
    args.push('-vf',vf.join(','));
    if (item.targetFormat === 'gif') args.push('-loop','0','-an');
    else if (job.operation === 'frames') args.push('-frames:v','500','-an');
    else args.push(...videoCodec(item.targetFormat,job));
  }
  if (job.mute && !audioOnly) args.push('-an');
  else if (af.length) args.push('-af',af.join(','));
  args.push('-map_metadata',job.keepMetadata ? '0' : '-1');
  if (item.targetFormat === 'm3u8') {
    const outDir = await fs.mkdtemp(path.join(job.outputDir,`${cleanStem(item.name)}-hls-`));
    job.partialOutputs.push(outDir);
    args.push('-f','hls','-hls_time','6','-hls_list_size','0','-hls_segment_filename',path.join(outDir,'segment-%04d.ts'),'-progress','pipe:1','-nostats',path.join(outDir,'index.m3u8'));
    await runFfmpeg(item,job,outDir,args);
    job.partialOutputs = job.partialOutputs.filter(value => value !== outDir);
    return (await fs.readdir(outDir)).sort().map(name => path.join(outDir,name));
  }
  if (['frames','split'].includes(job.operation)) {
    const outDir = await fs.mkdtemp(path.join(job.outputDir, `${cleanStem(item.name)}-${job.operation}-`));
    job.partialOutputs.push(outDir);
    if (job.operation === 'split') {
      if (!audioOnly) args.push('-force_key_frames',`expr:gte(t,n_forced*${job.segmentSeconds})`);
      args.push('-f','segment','-segment_time',String(job.segmentSeconds),'-segment_time_delta','0.1','-reset_timestamps','1');
    }
    args.push('-progress','pipe:1','-nostats',path.join(outDir,`%04d.${item.targetFormat}`));
    await runFfmpeg(item,job,outDir,args);
    const names = await fs.readdir(outDir);
    job.partialOutputs = job.partialOutputs.filter(value => value !== outDir);
    return names.sort().map(name => path.join(outDir,name));
  }
  args.push('-progress','pipe:1','-nostats',outputPath);
  job.partialOutputs.push(outputPath);
  await runFfmpeg(item, job, outputPath, args);
  job.partialOutputs = job.partialOutputs.filter(value => value !== outputPath);
  return [outputPath];
}

async function combineMedia(job) {
  const audioOnly = job.category === 'audio';
  const first = job.items[0];
  const format = first.targetFormat;
  const outputPath = await uniqueOutputPath(job.outputDir, `${job.operation === 'mix' ? 'mixed' : job.operation === 'mux' ? 'muxed' : 'merged'}.${format}`);
  job.partialOutputs.push(outputPath);
  const args = ['-y'];
  for (const item of job.items) { args.push('-i',item.tempPath); item.status = 'converting'; }
  const filters = [];
  if (job.operation === 'mux') {
    const audioIndex = job.items.findIndex(isAudioFile);
    const videoIndex = audioIndex === 0 ? 1 : 0;
    args.push('-map',`${videoIndex}:v:0`,'-map',`${audioIndex}:a:0`,'-shortest',...videoCodec(format,job));
  } else if (audioOnly) {
    job.items.forEach((_,i) => filters.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`));
    filters.push(`${job.items.map((_,i) => `[a${i}]`).join('')}${job.operation === 'mix' ? `amix=inputs=${job.items.length}:duration=longest:normalize=1` : `concat=n=${job.items.length}:v=0:a=1`}[outa]`);
    args.push('-filter_complex',filters.join(';'),'-map','[outa]',...audioCodec(format,job));
  } else {
    const probes = await Promise.all(job.items.map(async item => {
      const { stdout } = await execFileAsync(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',item.tempPath],{ windowsHide:true, maxBuffer:4*1024*1024 });
      return JSON.parse(stdout);
    }));
    const firstVideo = probes[0].streams.find(s => s.codec_type === 'video');
    const w = Math.max(2, Math.floor((job.width || firstVideo.width) / 2) * 2);
    const h = Math.max(2, Math.floor((job.height || firstVideo.height) / 2) * 2);
    probes.forEach((probe,i) => {
      filters.push(`[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${job.fps || 30},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
      if (probe.streams.some(s => s.codec_type === 'audio')) filters.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${Number(probe.format.duration) || 1}[a${i}]`);
    });
    filters.push(`${job.items.map((_,i) => `[v${i}][a${i}]`).join('')}concat=n=${job.items.length}:v=1:a=1[outv][outa]`);
    args.push('-filter_complex',filters.join(';'),'-map','[outv]','-map','[outa]',...videoCodec(format,job));
  }
  args.push('-progress','pipe:1','-nostats',outputPath);
  await runFfmpeg(first,job,outputPath,args);
  job.partialOutputs = job.partialOutputs.filter(value => value !== outputPath);
  const output = { name:path.basename(outputPath), path:outputPath };
  job.items.forEach(item => { item.status = 'completed'; item.progress = 100; item.outputs = [output]; });
  return [output];
}

async function pdfText(inputPath) {
  const { pdfjs } = await loadPdfRenderer();
  const bytes = new Uint8Array(await fs.readFile(inputPath));
  const loadingTask = pdfjs.getDocument({ data: bytes, disableWorker: true, useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim());
  }
  document.cleanup?.();
  await loadingTask.destroy?.();
  return pages.join("\n\n");
}

async function documentText(item) {
  if (["txt", "md"].includes(item.sourceFormat)) return fs.readFile(item.tempPath, "utf8");
  if (item.sourceFormat === "pdf") return pdfText(item.tempPath);
  if (item.sourceFormat === "docx") {
    const result = await mammoth.extractRawText({ path: item.tempPath });
    return result.value;
  }
  throw new Error(`Text extraction from .${item.sourceFormat} is not supported.`);
}

function wrapText(text, maxCharacters = 92) {
  const lines = [];
  for (const paragraph of String(text || "").replace(/\r/g, "").split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let remaining = paragraph.trim();
    while (remaining.length > maxCharacters) {
      let split = remaining.lastIndexOf(" ", maxCharacters);
      if (split < Math.floor(maxCharacters * 0.55)) split = maxCharacters;
      lines.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

async function appendTextToPdf(pdf, text, title) {
  // The built-in PDF fonts cannot encode Chinese. Rasterize only Unicode pages
  // with the local system font instead of silently replacing text with '?'.
  if (/[^\x00-\xFF]/.test(`${title}${text}`)) {
    const { canvas } = await loadPdfRenderer();
    const lines = [title, '', ...wrapText(text, 45)];
    for (let offset = 0; offset < lines.length; offset += 45) {
      const surface = canvas.createCanvas(1190,1684);
      const ctx = surface.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1190,1684);
      ctx.fillStyle = '#20262c'; ctx.font = '22px "Microsoft YaHei", sans-serif';
      lines.slice(offset,offset+45).forEach((line,index) => ctx.fillText(line,104,110+index*32,980));
      const image = await pdf.embedPng(await surface.encode('png'));
      pdf.addPage([595,842]).drawImage(image,{ x:0,y:0,width:595,height:842 });
    }
    return;
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [595.28, 841.89];
  const margin = 52;
  const lineHeight = 15;
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;
  page.drawText(title.slice(0, 90), { x: margin, y, size: 16, font: bold, color: rgb(0.12, 0.16, 0.17) });
  y -= 28;
  for (const line of wrapText(text)) {
    if (y < margin) {
      page = pdf.addPage(pageSize);
      y = pageSize[1] - margin;
    }
    const safeLine = line.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
    page.drawText(safeLine, { x: margin, y, size: 10.5, font, color: rgb(0.12, 0.15, 0.16) });
    y -= lineHeight;
  }
}

async function appendImageToPdf(pdf, item) {
  const sharp = await loadSharp();
  const source = sharp(item.tempPath, { animated: false, page: 0 });
  const metadata = await source.metadata();
  const png = await source.png().toBuffer();
  const embedded = await pdf.embedPng(png);
  const maxWidth = 720;
  const maxHeight = 960;
  const scale = Math.min(1, maxWidth / (metadata.width || embedded.width), maxHeight / (metadata.height || embedded.height));
  const width = Math.max(1, (metadata.width || embedded.width) * scale);
  const height = Math.max(1, (metadata.height || embedded.height) * scale);
  const page = pdf.addPage([width, height]);
  page.drawImage(embedded, { x: 0, y: 0, width, height });
}

async function appendDocumentToPdf(pdf, item) {
  if (item.sourceFormat === "pdf") {
    const source = await PDFDocument.load(await fs.readFile(item.tempPath), { ignoreEncryption: false });
    const pages = await pdf.copyPages(source, source.getPageIndices());
    pages.forEach((page) => pdf.addPage(page));
    return;
  }
  if (["jpeg", "jpg", "png", "tif", "tiff", "webp"].includes(item.sourceFormat)) {
    await appendImageToPdf(pdf, item);
    return;
  }
  await appendTextToPdf(pdf, await documentText(item), item.name);
}

async function renderPdfPages(item, job) {
  const { canvas, pdfjs } = await loadPdfRenderer();
  const bytes = new Uint8Array(await fs.readFile(item.tempPath));
  const loadingTask = pdfjs.getDocument({ data: bytes, disableWorker: true, useSystemFonts: true });
  const document = await loadingTask.promise;
  const outputs = [];
  const extension = item.targetFormat;
  for (const pageIndex of pageIndices(job.pages, document.numPages)) {
    const index = pageIndex + 1;
    if (job.cancelRequested) throw new Error("Conversion cancelled.");
    const page = await document.getPage(index);
    const viewport = page.getViewport({ scale: job.quality === "small" ? 1.2 : job.quality === "balanced" ? 1.7 : 2.2 });
    const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = surface.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}-page-${index}.${extension}`);
    const buffer = extension === "jpg"
      ? await surface.encode("jpeg", imageQuality(job.quality))
      : await surface.encode("png");
    await fs.writeFile(outputPath, buffer);
    outputs.push(outputPath);
    item.progress = Math.round((index / document.numPages) * 100);
  }
  document.cleanup?.();
  await loadingTask.destroy?.();
  return outputs;
}

async function convertDocxWithLibreOffice(item, job) {
  const soffice = await locateLibreOffice();
  if (!soffice) {
    throw new Error("DOCX to PDF needs LibreOffice. Install LibreOffice or choose TXT/MD output.");
  }
  const tempOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "magic-box-office-"));
  try {
    await execFileAsync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", tempOutputDir, item.tempPath], {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024
    });
    const generated = path.join(tempOutputDir, `${path.basename(item.tempPath, path.extname(item.tempPath))}.pdf`);
    const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}.pdf`);
    await fs.copyFile(generated, outputPath);
    return [outputPath];
  } finally {
    await fs.rm(tempOutputDir, { recursive: true, force: true });
  }
}

async function convertDocument(item, job) {
  if (['split','pages'].includes(job.operation)) {
    const source = await PDFDocument.load(await fs.readFile(item.tempPath));
    const indices = pageIndices(job.pages,source.getPageCount());
    const groups = job.operation === 'split' ? indices.map(index => [index]) : [indices];
    const outputs = [];
    for (const group of groups) {
      if (job.cancelRequested) throw new Error('Conversion cancelled.');
      const pdf = await PDFDocument.create();
      const pages = await pdf.copyPages(source,group);
      pages.forEach(page => { if (job.rotation) page.setRotation(degrees((page.getRotation().angle + job.rotation) % 360)); pdf.addPage(page); });
      const outputPath = await uniqueOutputPath(job.outputDir,`${cleanStem(item.name)}-${job.operation === 'split' ? `page-${group[0]+1}` : 'pages'}.pdf`);
      await fs.writeFile(outputPath,await pdf.save()); outputs.push(outputPath);
    }
    return outputs;
  }
  if (["txt", "md"].includes(item.targetFormat)) {
    const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}.${item.targetFormat}`);
    await fs.writeFile(outputPath, await documentText(item), "utf8");
    return [outputPath];
  }
  if (["png", "jpg"].includes(item.targetFormat)) {
    if (item.sourceFormat !== "pdf") throw new Error("PNG/JPG document export currently supports PDF input.");
    return renderPdfPages(item, job);
  }
  if (item.targetFormat === "pdf") {
    if (OFFICE_INPUTS.includes(item.sourceFormat)) return convertDocxWithLibreOffice(item, job);
    const pdf = await PDFDocument.create();
    await appendDocumentToPdf(pdf, item);
    const outputPath = await uniqueOutputPath(job.outputDir, `${cleanStem(item.name)}.pdf`);
    await fs.writeFile(outputPath, await pdf.save({ useObjectStreams: true }));
    return [outputPath];
  }
  throw new Error(`Document output .${item.targetFormat} is not supported.`);
}

async function mergeDocuments(job) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < job.items.length; index += 1) {
    const item = job.items[index];
    if (job.cancelRequested) throw new Error('Conversion cancelled.');
    item.status = "converting";
    await appendDocumentToPdf(pdf, item);
    item.progress = 95;
    job.progress = Math.round(((index + 1) / job.items.length) * 92);
  }
  const outputPath = await uniqueOutputPath(job.outputDir, "merged-document.pdf");
  await fs.writeFile(outputPath, await pdf.save({ useObjectStreams: true }));
  const relative = { name: path.basename(outputPath), path: outputPath };
  job.items.forEach((item) => { item.outputs = [relative]; item.status = 'completed'; item.progress = 100; });
  return [relative];
}

async function copyOriginal(item, job) {
  if (!job.keepOriginal) return null;
  const originalsDir = path.join(job.outputDir, "Originals");
  await fs.mkdir(originalsDir, { recursive: true });
  const outputPath = await uniqueOutputPath(originalsDir, cleanFileName(item.name));
  await fs.copyFile(item.tempPath, outputPath);
  return { name: path.basename(outputPath), path: outputPath, original: true };
}

async function removeTempFiles(job) {
  await Promise.all([...job.items.map(item => item.tempPath), ...(job.scratchFiles || [])].map(file => fs.rm(file, { force:true }).catch(() => undefined)));
  await Promise.all((job.partialOutputs || []).map(file => fs.rm(file,{ force:true,recursive:true }).catch(() => undefined)));
}

async function runJob(job) {
  job.status = "running";
  try {
    await fs.mkdir(job.outputDir, { recursive: true });
    if (job.category === "document" && job.mergePdf) {
      job.outputs = await mergeDocuments(job);
      for (const item of job.items) { const original = await copyOriginal(item,job); if (original) job.outputs.push(original); }
    } else if (['merge','mix','mux'].includes(job.operation)) {
      job.outputs = await combineMedia(job);
      for (const item of job.items) { const original = await copyOriginal(item,job); if (original) job.outputs.push(original); }
    } else {
      for (let index = 0; index < job.items.length; index += 1) {
        if (job.cancelRequested) throw new Error("Conversion cancelled.");
        const item = job.items[index];
        item.status = "converting";
        item.progress = Math.max(item.progress, 2);
        try {
          let paths;
          if (job.category === "picture") paths = await convertPicture(item, job);
          else if (job.category === "document") paths = await convertDocument(item, job);
          else paths = await convertMedia(item, job);
          if (job.cancelRequested) {
            await Promise.all(paths.map(file => fs.rm(file,{force:true}).catch(() => undefined)));
            throw new Error('Conversion cancelled.');
          }
          const outputs = paths.map((outputPath) => ({ name: path.basename(outputPath), path: outputPath }));
          const original = await copyOriginal(item, job);
          if (original) outputs.push(original);
          item.outputs = outputs;
          item.status = "completed";
          item.progress = 100;
          job.outputs.push(...outputs);
        } catch (error) {
          item.status = job.cancelRequested ? "cancelled" : "failed";
          item.error = error.message;
          if (job.cancelRequested) throw error;
        }
        job.progress = Math.round(((index + 1) / job.items.length) * 100);
      }
    }
    const failures = job.items.filter((item) => item.status === "failed");
    job.status = failures.length === job.items.length ? "failed" : "completed";
    job.error = failures.length ? `${failures.length} of ${job.items.length} file(s) could not be converted.` : null;
    job.progress = 100;
  } catch (error) {
    job.status = job.cancelRequested ? "cancelled" : "failed";
    job.error = error.message;
    job.items.filter(item => item.status !== 'completed').forEach(item => { item.status = job.status; item.error = error.message; });
  } finally {
    job.completedAt = Date.now();
    job.process = null;
    await removeTempFiles(job);
    if (job.status === "completed" && job.outputs.length && job.assistantTicket) {
      job.assistantTicket.complete({
        producerEventId: `format-factory:${job.id}`,
        files: job.outputs.map((output) => output.path)
      });
    }
  }
}

function parseTargets(rawTargets, files, fallbackFormat) {
  let values = [];
  if (typeof rawTargets === "string" && rawTargets.trim()) {
    try {
      values = JSON.parse(rawTargets);
    } catch {
      throw new Error("Output formats could not be read.");
    }
  }
  if (!Array.isArray(values)) values = [];
  return files.map((file, index) => String(values[index] || fallbackFormat || "").toLowerCase().replace(/^\./, ""));
}

function validateFiles(category, files, targets, options) {
  const formats = categoryFormats[category];
  if (!formats) throw new Error("Choose Picture, Document, Video, or Audio.");
  if (!files.length) throw new Error("Choose at least one file to convert.");
  files.forEach((file, index) => {
    const input = extensionOf(file.originalname);
    const output = targets[index];
    if (!formats.inputs.has(input) && !(options.operation === 'mux' && categoryFormats.audio.inputs.has(input))) throw new Error(`${file.originalname} is not a supported ${category} file.`);
    const outputs = options.operation === 'extract' ? categoryFormats.audio.outputs : options.operation === 'frames' ? new Set(['png','jpg']) : formats.outputs;
    if (!outputs.has(output)) throw new Error(`.${output || "?"} is not a supported ${category} output.`);
    if (category === 'document') {
      if (['split','pages'].includes(options.operation) && (input !== 'pdf' || output !== 'pdf')) throw new Error('页面操作需要 PDF 输入和输出。');
      if (['png','jpg'].includes(output) && input !== 'pdf') throw new Error('文档转图片需要 PDF 输入。');
      if (['txt','md'].includes(output) && !['pdf','docx','txt','md'].includes(input)) throw new Error('此文件不支持提取文本。');
    }
  });
  if (['merge','mix','mux'].includes(options.operation) && (files.length < 2 || new Set(targets).size !== 1)) throw new Error('合并至少需要两个文件，且输出格式必须相同。');
  if (options.operation === 'mux' && (files.length !== 2 || files.filter(file => categoryFormats.audio.inputs.has(extensionOf(file.originalname))).length !== 1)) throw new Error('混流需要一个视频文件和一个音频文件。');
  if (category === 'video' && ['merge','mux','split'].includes(options.operation) && targets.some(target => ['gif','3gp','m3u8'].includes(target))) throw new Error('合并、混流和分割请选择 MP4、MKV、MOV 等视频格式。');
}

export function createFormatFactoryManager({ defaultDownloadDir, assistantIntegration = null }) {
  const router = express.Router();
  const jobs = new Map();
  let processing = Promise.resolve();
  const uploadDir = path.join(os.tmpdir(), "magic-box-format-factory");
  fsSync.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_request, file, callback) => callback(null, `${Date.now()}-${randomUUID()}-${cleanFileName(decodeUploadName(file.originalname))}`)
    }),
    limits: { fileSize: maxFileBytes, files: maxFiles }
  });

  router.get("/capabilities", async (_request, response) => {
    const [sharp, libreOffice] = await Promise.all([loadSharp().catch(() => null), locateLibreOffice()]);
    response.json({
      localOnly: true,
      maxFiles,
      tools: FACTORY_TOOLS.map(tool => tool.id),
      sharp: { available: Boolean(sharp), label: sharp ? "Sharp ready" : "Sharp missing" },
      ffmpeg: { available: Boolean(ffmpegPath && fsSync.existsSync(ffmpegPath)), label: ffmpegPath ? "FFmpeg ready" : "FFmpeg missing" },
      pdf: { available: true, label: "PDF tools ready" },
      libreOffice: { available: Boolean(libreOffice), label: libreOffice ? "LibreOffice ready" : "LibreOffice optional" },
      formats: Object.fromEntries(Object.entries(categoryFormats).map(([category, formats]) => [category, {
        inputs: Array.from(formats.inputs),
        outputs: Array.from(formats.outputs)
      }]))
    });
  });

  router.post("/jobs", upload.array("files", maxFiles), async (request, response) => {
    const files = Array.isArray(request.files) ? request.files : [];
    files.forEach(file => { file.originalname = decodeUploadName(file.originalname); });
    try {
      pruneJobs(jobs);
      if (Array.from(jobs.values()).filter(job => !['completed','failed','cancelled'].includes(job.status)).length >= maxJobs) throw new Error('待处理任务已满，请等待当前任务完成。');
      const category = String(request.body?.category || "").toLowerCase();
      const fallbackFormat = String(request.body?.outputFormat || "").toLowerCase().replace(/^\./, "");
      const targets = parseTargets(request.body?.targets, files, fallbackFormat);
      const options = parseFactoryOptions(request.body || {},category);
      if (category === 'document' && request.body?.mergePdf === 'true') options.operation = 'merge';
      validateFiles(category, files, targets, options);
      if (category === 'document' && files.some((file,index) => OFFICE_INPUTS.includes(extensionOf(file.originalname)) && targets[index] === 'pdf') && !await locateLibreOffice()) throw new Error('Office 转 PDF 需要安装 LibreOffice；DOCX 可直接转 TXT/MD。');
      if (category === "video" || category === "audio") {
        if (!ffmpegPath || !fsSync.existsSync(ffmpegPath)) throw new Error("Bundled FFmpeg is not available.");
      }
      const outputDir = normalizeOutputDir(request.body?.outputDir, defaultDownloadDir);
      const jobId = randomUUID();
      const job = {
        id: jobId,
        category,
        status: "queued",
        progress: 0,
        createdAt: Date.now(),
        outputDir,
        quality: normalizeQuality(request.body?.quality),
        ...options,
        keepOriginal: request.body?.keepOriginal === "true",
        keepMetadata: request.body?.keepMetadata !== "false",
        mergePdf: category === "document" && options.operation === 'merge',
        cancelRequested: false,
        error: null,
        outputs: [],
        process: null,
        scratchFiles: [],
        partialOutputs: [],
        assistantTicket: assistantIntegration?.capture("format-factory", {
          outputRootPath: outputDir,
          producerJobId: jobId
        }) || null,
        items: files.map((file, index) => ({
          id: randomUUID(),
          name: file.originalname,
          size: file.size,
          sourceFormat: extensionOf(file.originalname),
          targetFormat: targets[index],
          tempPath: file.path,
          status: "queued",
          progress: 0,
          error: null,
          outputs: []
        }))
      };
      if (job.mergePdf && job.items.some((item) => item.targetFormat !== "pdf")) {
        throw new Error("Merged document output must use PDF for every file.");
      }
      if (job.mergePdf && job.items.some(item => OFFICE_INPUTS.includes(item.sourceFormat))) throw new Error('请先将 Office 文件转成 PDF，再进行合并以保留排版。');
      jobs.set(job.id, job);
      job.finished = processing.then(() => runJob(job));
      processing = job.finished.catch(() => undefined);
      response.status(202).json(jobSnapshot(job));
    } catch (error) {
      await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined)));
      response.status(400).json({ error: error.message });
    }
  });

  router.get("/jobs/:jobId", (request, response) => {
    pruneJobs(jobs);
    const job = jobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Format Factory job was not found." });
      return;
    }
    response.json(jobSnapshot(job));
  });

  router.get('/jobs', (_request,response) => {
    pruneJobs(jobs);
    response.json({ jobs: Array.from(jobs.values()).sort((a,b) => b.createdAt-a.createdAt).map(jobSnapshot) });
  });

  router.delete('/jobs/:jobId',(request,response) => {
    const job = jobs.get(request.params.jobId);
    if (!job) return response.status(404).json({error:'任务记录不存在。'});
    if (!['completed','failed','cancelled'].includes(job.status)) return response.status(409).json({error:'请先停止正在处理的任务。'});
    jobs.delete(job.id);
    response.json({removed:true});
  });

  router.post("/jobs/:jobId/cancel", (request, response) => {
    const job = jobs.get(String(request.params.jobId || ""));
    if (!job) {
      response.status(404).json({ error: "Format Factory job was not found." });
      return;
    }
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      job.cancelRequested = true;
      job.process?.kill("SIGKILL");
    }
    response.json(jobSnapshot(job));
  });

  router.use((error, _request, response, _next) => {
    response.status(400).json({ error: error.message || "Format Factory could not accept those files." });
  });

  return {
    router,
    jobs,
    async close() {
      for (const job of jobs.values()) {
        if (!["completed", "failed", "cancelled"].includes(job.status)) {
          job.cancelRequested = true;
          job.process?.kill("SIGKILL");
        }
      }
      await Promise.all(Array.from(jobs.values()).map(job => job.finished));
    }
  };
}
