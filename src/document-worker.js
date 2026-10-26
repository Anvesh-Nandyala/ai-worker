import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { extension, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_TEXT, SPREADSHEET_EXTENSIONS, validateDocumentHeader } from './document-formats.js';

const MAX_EXPANDED = 32 * 1024 * 1024;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false, processEntities: true });

function checkZip(bytes) {
  let total = 0;
  let count = 0;
  unzipSync(bytes, { filter: entry => {
    if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw new Error('Invalid document archive size');
    total += entry.originalSize;
    if (++count > 4000 || total > MAX_EXPANDED) throw new Error('Document archive exceeds the 32 MB expanded-size or 4000-entry limit');
    return false;
  } });
}

function safeXML(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Documents with XML entity declarations are not supported');
  return parser.parse(xml);
}

function plain(nodes) {
  let result = '';
  for (const node of nodes || []) for (const [name, children] of Object.entries(node)) {
    if (name === '#text') result += String(children);
    else if (['a:br', 'text:line-break'].includes(name)) result += '\n';
    else if (name === 'text:tab') result += '\t';
    else if (name === 'text:s') result += ' '.repeat(Math.min(100, Number(node[':@']?.['@_text:c']) || 1));
    else if (Array.isArray(children)) result += plain(children);
  }
  return result;
}

function paragraphs(nodes) {
  const output = [];
  for (const node of nodes || []) for (const [name, children] of Object.entries(node)) {
    if (['a:p', 'text:p', 'text:h'].includes(name)) output.push(plain(children).trim());
    else if (Array.isArray(children)) output.push(...paragraphs(children));
  }
  return output;
}

function attributesOf(nodes, tag) {
  const results = [];
  for (const node of nodes || []) for (const [name, children] of Object.entries(node)) {
    if (name === tag) results.push(node[':@'] || {});
    else if (Array.isArray(children)) results.push(...attributesOf(children, tag));
  }
  return results;
}

function slideOrder(parts) {
  if (parts['ppt/presentation.xml'] && parts['ppt/_rels/presentation.xml.rels']) {
    const ids = attributesOf(safeXML(strFromU8(parts['ppt/presentation.xml'])), 'p:sldId');
    const relationships = attributesOf(safeXML(strFromU8(parts['ppt/_rels/presentation.xml.rels'])), 'Relationship');
    const targets = new Map(relationships.filter(item => item['@_TargetMode'] !== 'External').map(item => [item['@_Id'], item['@_Target']]));
    return ids.map(id => {
      const target = targets.get(id['@_r:id']);
      if (typeof target !== 'string') throw new Error('A slide relationship is missing');
      const name = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('ppt', target));
      if (!/^ppt\/slides\/[^/]+\.xml$/.test(name) || !parts[name]) throw new Error('A presentation slide is missing from the file');
      return name;
    });
  }
  return Object.keys(parts).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
}

function readRange(book, requestedSheet, requestedRange, budget = 2000) {
  const sheet = requestedSheet || book.SheetNames[0];
  if (!book.SheetNames.includes(sheet)) throw new Error(`Sheet "${sheet}" was not found. Available sheets: ${book.SheetNames.join(', ')}`);
  const source = book.Sheets[sheet];
  if (!source?.['!ref']) return { sheet, range: '', rows: [], formulas: {}, truncated: false };
  const extent = XLSX.utils.decode_range(source['!ref']);
  if (requestedRange && !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/i.test(requestedRange)) throw new Error('Use an Excel range such as A1:D20');
  const selected = requestedRange ? XLSX.utils.decode_range(requestedRange.toUpperCase()) : extent;
  if (selected.s.r > selected.e.r || selected.s.c > selected.e.c || selected.e.r > 1048575 || selected.e.c > 16383) throw new Error('Spreadsheet range is outside Excel limits');
  const endColumn = Math.min(selected.e.c, selected.s.c + 49);
  const cellTextLimit = Math.min(1000, Math.floor(20000 / (2 * (endColumn - selected.s.c + 1))));
  const rowLimit = Math.min(200, Math.floor(budget / (endColumn - selected.s.c + 1)));
  const endRow = Math.min(selected.e.r, selected.s.r + rowLimit - 1);
  const rows = [];
  const formulas = {};
  const warnings = [];
  const truncatedCells = [];
  let textSize = 0;
  let limited = false;
  for (let row = selected.s.r; row <= endRow; row++) {
    const values = [];
    const rowFormulas = {};
    const rowWarnings = [];
    const rowTruncated = [];
    let rowSize = 0;
    for (let column = selected.s.c; column <= endColumn; column++) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = source[address];
      let value = cell?.v ?? null;
      if (cell?.t === 'e' && cell.v !== undefined) value = cell.w || `Excel error ${cell.v}`;
      if (cell?.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) value = XLSX.utils.format_cell(cell);
      if (typeof value === 'string') { if (value.length > cellTextLimit) rowTruncated.push(address); value = value.slice(0, cellTextLimit); }
      if (cell?.f) {
        rowFormulas[address] = cell.f.slice(0, cellTextLimit);
        if (cell.f.length > cellTextLimit) rowTruncated.push(address);
        if (cell.v === undefined) rowWarnings.push(`Formula ${address} has no saved result; it has not been recalculated.`);
      }
      values.push(value);
      rowSize += JSON.stringify(value).length + (rowFormulas[address]?.length || 0);
    }
    if (textSize + rowSize > 24000 && rows.length) { limited = true; break; }
    textSize += rowSize;
    Object.assign(formulas, rowFormulas);
    warnings.push(...rowWarnings);
    truncatedCells.push(...rowTruncated);
    rows.push(values);
  }
  const actualEnd = { r: selected.s.r + rows.length - 1, c: endColumn };
  const truncated = limited || truncatedCells.length > 0 || actualEnd.r < selected.e.r || endColumn < selected.e.c;
  return {
    sheet, range: XLSX.utils.encode_range({ s: selected.s, e: actualEnd }), rows, formulas,
    usedRange: source['!ref'], truncated,
    nextRange: actualEnd.r < selected.e.r ? XLSX.utils.encode_range({ s: { r: actualEnd.r + 1, c: selected.s.c }, e: { r: selected.e.r, c: endColumn } }) : undefined,
    nextColumnRange: endColumn < selected.e.c ? XLSX.utils.encode_range({ s: { r: selected.s.r, c: endColumn + 1 }, e: selected.e }) : undefined,
    truncatedCells: [...new Set(truncatedCells)].slice(0, 100), warnings: warnings.slice(0, 10)
  };
}

async function parseFile() {
  const bytes = await fs.readFile(workerData.filename);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Documents must be no larger than 16 MB');
  const ext = extension(workerData.filename);
  validateDocumentHeader(ext, bytes.subarray(0, 1024));
  if (ext === '.pdf') return (await import('./pdf-reader.js')).readPDF(bytes);
  const zipped = ['.xlsx', '.ods', '.docx', '.odt', '.pptx', '.odp'].includes(ext);
  let parts;
  let parserBytes = bytes;
  if (zipped) {
    checkZip(bytes);
    parts = unzipSync(bytes, { filter: entry => /\.(xml|rels)$/i.test(entry.name) || entry.name === 'mimetype' });
    for (const part of Object.values(parts)) if (/<!DOCTYPE|<!ENTITY/i.test(strFromU8(part))) throw new Error('Documents with XML entity declarations are not supported');
    // Readers need XML/relationships, not embedded programs or media. A bounded,
    // uncompressed in-memory archive avoids a second uncontrolled inflation.
    parserBytes = Buffer.from(zipSync(parts, { level: 0 }));
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    const book = XLSX.read(parserBytes, { type: 'buffer', cellFormula: true, cellHTML: false, cellNF: true, bookVBA: false });
    const sheets = book.SheetNames.slice(0, 100);
    const calculation = 'Formulas are not recalculated. Cell values are the saved/cached workbook values; dates use the workbook display format.';
    if (workerData.mode === 'spreadsheet') return { format: ext.slice(1), sheets, ...readRange(book, workerData.sheet, workerData.range), calculation };
    const tables = book.SheetNames.slice(0, 5).map(name => readRange(book, name, undefined, 500));
    const content = tables.map(table => `Sheet: ${table.sheet}\nRange: ${table.range || '(empty)'}\n` + table.rows.map(row => row.map(value => value === null ? '' : String(value)).join('\t')).join('\n') + (Object.keys(table.formulas).length ? '\nFormulas: ' + JSON.stringify(table.formulas) : '')).join('\n\n');
    return { format: ext.slice(1), content: content.slice(0, MAX_DOCUMENT_TEXT), sheets, truncated: content.length > MAX_DOCUMENT_TEXT || book.SheetNames.length > 5 || tables.some(table => table.truncated), calculation };
  }
  let content;
  let warnings = [];
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer: parserBytes });
    content = result.value;
    warnings = result.messages.slice(0, 10).map(message => message.message.slice(0, 500));
  } else if (ext === '.pptx') {
    const names = slideOrder(parts);
    if (!names.length) throw new Error('No slides were found in this PowerPoint file');
    if (!parts['ppt/presentation.xml']) warnings.push('Slide order was inferred from filenames because presentation metadata is missing.');
    content = names.map((name, index) => `Slide ${index + 1}\n` + paragraphs(safeXML(strFromU8(parts[name]))).join('\n')).join('\n\n');
  } else {
    if (!parts['content.xml']) throw new Error('This OpenDocument file has no content.xml');
    content = paragraphs(safeXML(strFromU8(parts['content.xml']))).join('\n');
  }
  return { format: ext.slice(1), content: content.slice(0, MAX_DOCUMENT_TEXT), truncated: content.length > MAX_DOCUMENT_TEXT, warnings };
}

try { parentPort.postMessage({ result: await parseFile() }); }
catch (error) { parentPort.postMessage({ error: 'Could not read document: ' + error.message }); }
