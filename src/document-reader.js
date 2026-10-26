import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { extension, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_TEXT, validateDocumentHeader } from './document-formats.js';

const execute = promisify(execFile);

async function readLegacyDocument(filename, signal) {
  if (process.platform !== 'darwin') throw new Error('Reading legacy .doc and .rtf files currently requires macOS. Convert this file to .docx on other platforms.');
  const file = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    validateDocumentHeader(extension(filename), header.subarray(0, bytesRead));
  } finally { await file.close(); }
  let text;
  let limited = false;
  try {
    const result = await execute('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '-encoding', 'UTF-8', '-noload', '-nostore', '--', filename], { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    text = result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.stdout) { text = error.stdout; limited = true; }
    else throw new Error('Could not read the document: ' + (error.stderr?.trim() || error.message));
  }
  return { format: extension(filename).slice(1), content: text.slice(0, MAX_DOCUMENT_TEXT), truncated: limited || text.length > MAX_DOCUMENT_TEXT };
}

export async function readDocument(filename, options = {}, signal) {
  signal?.throwIfAborted();
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('Path is not a file');
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('Documents must be no larger than 16 MB');
  if (['.doc', '.rtf'].includes(extension(filename))) return readLegacyDocument(filename, signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-worker.js', import.meta.url), {
      workerData: { filename, ...options }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 }
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => finish(signal.reason || new Error('Document reading stopped'));
    const timeout = setTimeout(() => finish(new Error('Document parsing exceeded 20 seconds. Try a smaller file.')), 20000);
    timeout.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(new Error('Document parser failed: ' + error.message)));
    worker.once('exit', () => { if (!settled) finish(new Error('Document parser ended without a result')); });
  });
}
