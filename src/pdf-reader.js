import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_DOCUMENT_TEXT } from './document-formats.js';

// Called inside the bounded document worker. Only bytes and bundled resources
// are supplied: no document URLs, scripts, attachments or external links run.
export async function readPDF(bytes) {
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  const loading = getDocument({
    data: new Uint8Array(bytes), useWorkerFetch: false, useWasm: false,
    cMapUrl: path.join(packageRoot, 'cmaps') + path.sep,
    standardFontDataUrl: path.join(packageRoot, 'standard_fonts') + path.sep,
    stopAtErrors: true, enableXfa: false, verbosity: 0
  });
  try {
    const document = await loading.promise;
    let content = '';
    let pagesRead = 0;
    let truncated = false;
    let anyText = false;
    const emptyPages = [];
    for (let number = 1; number <= Math.min(document.numPages, 50); number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      let pageText = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            const available = MAX_DOCUMENT_TEXT - content.length - pageText.length - 30;
            if (text.length > available) {
              pageText += text.slice(0, Math.max(0, available));
              truncated = true;
              break;
            }
            pageText += text;
          }
          if (truncated) { await reader.cancel(new Error('PDF text limit reached')); break; }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      pagesRead++;
      if (pageText.trim()) anyText = true;
      else emptyPages.push(number);
      content += `Page ${number}\n${pageText.trim()}\n\n`;
      if (truncated) break;
    }
    if (!anyText) throw new Error('No readable PDF text was found. This may be a scanned/image-only PDF; OCR is not available. Supply a text-based document or the missing details.');
    const warnings = [];
    if (emptyPages.length) warnings.push('No text found on page(s) ' + emptyPages.join(', ') + '; images are not read and OCR is unavailable.');
    truncated ||= pagesRead < document.numPages;
    if (truncated) warnings.push('PDF preview is limited to 50 pages and 32,000 characters. Do not assume unread pages were checked.');
    return { format: 'pdf', content: content.slice(0, MAX_DOCUMENT_TEXT).trim(), pages: document.numPages, pagesRead, truncated, warnings };
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('Password-protected PDFs are not supported. Supply an unlocked copy.');
    throw error;
  } finally { await loading.destroy(); }
}
