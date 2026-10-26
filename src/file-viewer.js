import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { OPEN_DOCUMENT_EXTENSIONS, extension, validateDocumentHeader } from './document-formats.js';

export class FileViewer {
  constructor(workspace, { platform = process.platform, launch = promisify(execFile), allowedExtensions = OPEN_DOCUMENT_EXTENSIONS } = {}) {
    this.workspace = workspace;
    this.platform = platform;
    this.launch = launch;
    this.receipts = new Map();
    this.allowedExtensions = allowedExtensions;
  }

  async inspect(requestedPath, signal) {
    signal?.throwIfAborted();
    const resolved = await this.workspace.resolve(requestedPath);
    if (!this.allowedExtensions.has(extension(resolved))) throw new Error(this.allowedExtensions.size === 1 ? 'Choose a local .pdf file for the PDF viewer' : 'This file type is not supported by the document opener');
    const filename = await fs.realpath(resolved);
    if (!this.allowedExtensions.has(extension(filename))) throw new Error('The document path must resolve to a supported document file, such as a .pdf file');
    const relative = path.relative(this.workspace.root, filename);
    if (!this.workspace.allowAllFiles && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error('Document must stay inside the workspace');
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error('Document path is not a regular file');
    const file = await fs.open(filename, 'r');
    let fingerprint;
    try {
      const header = Buffer.alloc(1024);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      validateDocumentHeader(extension(filename), header.subarray(0, bytesRead));
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
      fingerprint = hash.digest('hex');
    } finally { await file.close(); }
    return { filename, fingerprint };
  }

  async open(requestedPath, signal) {
    signal?.throwIfAborted();
    if (this.platform !== 'darwin') throw new Error('Opening files in their default apps is currently supported on macOS');
    const file = await this.inspect(requestedPath, signal);
    signal?.throwIfAborted();
    try {
      // A fixed executable and a single absolute filename; no shell or model-supplied command.
      await this.launch('/usr/bin/open', [file.filename], { signal, timeout: 10000, maxBuffer: 64 * 1024 });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error('macOS could not open the document in its default app: ' + (error.stderr?.trim() || error.message));
    }
    signal?.throwIfAborted();
    const receipt = { ...file, requestedAt: new Date().toISOString() };
    this.receipts.set(file.filename, receipt);
    return {
      path: file.filename, format: extension(file.filename).slice(1), opened: true, requestedAt: receipt.requestedAt,
      confirmation: 'macOS accepted the request to open this document in its default app. App visibility and document contents are not observed by the opener.'
    };
  }

  async verify(requestedPath, signal) {
    let file;
    try { file = await this.inspect(requestedPath, signal); }
    catch (error) { signal?.throwIfAborted(); return { passed: false, actual: error.message }; }
    const receipt = this.receipts.get(file.filename);
    if (!receipt) return { passed: false, actual: 'This run has no accepted opening request for this file.' };
    if (receipt.fingerprint !== file.fingerprint) return { passed: false, actual: 'The document has changed since the opening request. Open the current file again.' };
    return { passed: true, actual: `macOS accepted the opening request for ${file.filename} at ${receipt.requestedAt}. The document is unchanged. Viewer visibility is not verified.` };
  }
}
