import fs from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 10 * 1024 * 1024;
const MAX_DOCUMENT_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024;

function normalize(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[\t\f\v]+/g, " ").replace(/ {3,}/g, "  ").replace(/\n{4,}/g, "\n\n\n").trim();
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function preflightDocx(buffer) {
  let offset = 0;
  let count = 0;
  let expanded = 0;
  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) { offset += 1; continue; }
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    count += 1;
    expanded += uncompressed;
    if (count > 10_000 || uncompressed > MAX_ZIP_ENTRY_UNCOMPRESSED || expanded > MAX_DOCUMENT_UNCOMPRESSED || (uncompressed > 1024 * 1024 && uncompressed / Math.max(1, compressed) > 100)) {
      fail("document_archive_unsafe", "The DOCX archive exceeded safe expansion limits.");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!count) fail("document_type_mismatch", "The DOCX container is invalid.");
}

async function extract() {
  const stats = await fs.stat(workerData.filePath);
  if (!stats.isFile() || stats.size > MAX_EXTRACT_BYTES) fail("extraction_limit_exceeded", "Documents larger than 50 MiB are not indexed.");
  const extension = path.extname(workerData.filePath).toLowerCase();
  const buffer = await fs.readFile(workerData.filePath);
  let sections;
  if ([".txt", ".md", ".markdown"].includes(extension)) {
    sections = [{ page: null, text: normalize(buffer.toString("utf8")) }];
  } else if (extension === ".docx") {
    preflightDocx(buffer);
    const result = await mammoth.extractRawText({ buffer });
    sections = [{ page: null, text: normalize(result.value) }];
  } else if (extension === ".pdf") {
    const document = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
    sections = [];
    try {
      if (document.numPages > 5_000) fail("extraction_limit_exceeded", "The PDF page limit was exceeded.");
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = normalize(content.items.map((item) => item.str || "").join(" "));
        if (text) sections.push({ page: pageNumber, text });
      }
    } finally { await document.destroy(); }
  } else {
    fail("unsupported_document", "This document type is not supported for content indexing.");
  }
  const total = sections.reduce((sum, section) => sum + Buffer.byteLength(section.text, "utf8"), 0);
  if (total > MAX_EXTRACTED_TEXT) fail("extraction_limit_exceeded", "Extracted text exceeded the 10 MiB safety limit.");
  return sections;
}

extract().then((sections) => parentPort.postMessage({ ok: true, sections }), (error) => parentPort.postMessage({ ok: false, code: error.code || "document_extraction_failed", message: String(error.message || "Document extraction failed.").slice(0, 512) }));
