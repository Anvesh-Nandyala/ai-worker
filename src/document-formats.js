import path from 'node:path';

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 32000;
export const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.ods', '.csv', '.tsv']);
export const RICH_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.xlsx', '.xls', '.ods', '.docx', '.doc', '.odt', '.rtf', '.pptx', '.odp']);
export const OPEN_DOCUMENT_EXTENSIONS = new Set(['.pdf', ...SPREADSHEET_EXTENSIONS, '.docx', '.doc', '.odt', '.rtf', '.pptx', '.ppt', '.odp', '.txt', '.md']);
const zipFormats = new Set(['.xlsx', '.ods', '.docx', '.odt', '.pptx', '.odp']);
const oleHeader = Buffer.from('d0cf11e0a1b11ae1', 'hex');

export function extension(filename) { return path.extname(filename).toLowerCase(); }

export function assertTextWrite(filename) {
  if (RICH_DOCUMENT_EXTENSIONS.has(extension(filename)) || ['.pdf', '.ppt'].includes(extension(filename))) throw new Error('file_write only writes text files. Save a summary as .md or .txt; Office documents are read-only.');
}

export function validateDocumentHeader(ext, bytes) {
  if (ext === '.pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The selected file does not have a PDF header');
  } else if (zipFormats.has(ext)) {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new Error(`Not a readable ${ext} document. Encrypted Office files are not supported.`);
  } else if (['.doc', '.xls', '.ppt'].includes(ext)) {
    if (!bytes.subarray(0, 8).equals(oleHeader)) throw new Error(`The selected file does not have a legacy Office ${ext} header`);
  } else if (ext === '.rtf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('{\\rtf'))) throw new Error('The selected file does not have an RTF header');
  } else if (bytes.includes(0) && !bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) && !bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    throw new Error('The selected text document contains binary data');
  }
}
