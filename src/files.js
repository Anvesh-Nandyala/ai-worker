import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readDocument } from './document-reader.js';
import { extension, RICH_DOCUMENT_EXTENSIONS, SPREADSHEET_EXTENSIONS, MAX_DOCUMENT_BYTES, validateDocumentHeader, assertTextWrite } from './document-formats.js';

export class Workspace {
  constructor(root, { allowAllFiles = false } = {}) {
    this.root = path.resolve(root);
    this.allowAllFiles = allowAllFiles;
    this.home = os.homedir();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
  }

  async resolve(relative = '.', { createParents = false } = {}) {
    if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0')) {
      throw new Error('Invalid workspace path');
    }
    if (this.allowAllFiles) {
      const expanded = relative === '~' ? this.home : relative.startsWith('~/') ? path.join(this.home, relative.slice(2)) : relative;
      const target = path.resolve(this.root, expanded);
      if (createParents) await fs.mkdir(path.dirname(target), { recursive: true });
      return target;
    }
    if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\')) {
      throw new Error('Use a relative workspace path with forward slashes');
    }
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error('Path must stay inside the workspace');
    }
    let current = this.root;
    const segments = rel.split(path.sep).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in workspace tools');
        if (i < segments.length - 1 && !stat.isDirectory()) throw new Error('Parent is not a directory');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (createParents && i < segments.length - 1) await fs.mkdir(current);
      }
    }
    return target;
  }

  async list(relative = '.') {
    const directory = await this.resolve(relative);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return Promise.all(entries.slice(0, 150).map(async entry => {
      let directoryEntry = entry.isDirectory();
      if (entry.isSymbolicLink() && this.allowAllFiles) {
        try { directoryEntry = (await fs.stat(path.join(directory, entry.name))).isDirectory(); } catch {}
      }
      return {
        name: entry.name,
        path: this.allowAllFiles ? path.join(directory, entry.name) : path.posix.join(relative, entry.name),
        type: entry.isSymbolicLink() && !this.allowAllFiles ? 'blocked_symlink' : directoryEntry ? 'directory' : 'file',
        symlink: entry.isSymbolicLink()
      };
    }));
  }

  async read(relative, { signal } = {}) {
    const filename = await this.resolve(relative);
    if (RICH_DOCUMENT_EXTENSIONS.has(extension(filename))) return { path: relative, ...await readDocument(filename, {}, signal) };
    if (/\.(ppt|png|jpe?g|gif|zip|exe)$/i.test(relative)) throw new Error('This format is not supported by the content reader. Legacy .ppt files can be opened with file_open; convert .ppt to .pptx to extract slide text.');
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error('Path is not a file');
    if (stat.size > 512 * 1024) throw new Error('File exceeds the 512 KB text-reading limit');
    const bytes = await fs.readFile(filename, { signal });
    if (bytes.includes(0)) throw new Error('Binary files are not supported; use a text, Markdown, JSON or CSV file');
    const text = bytes.toString('utf8');
    return { path: relative, content: text.slice(0, 32000), truncated: text.length > 32000 };
  }

  async spreadsheet(relative, { sheet, range, signal } = {}) {
    const filename = await this.resolve(relative);
    if (!SPREADSHEET_EXTENSIONS.has(extension(filename))) throw new Error('Use an Excel .xlsx/.xls, OpenDocument .ods, CSV or TSV file');
    return { path: relative, ...await readDocument(filename, { mode: 'spreadsheet', sheet, range }, signal) };
  }

  async search(query, startPath = '.', { signal } = {}) {
    if (!query || typeof query !== 'string') throw new Error('Provide a search query');
    const matches = [];
    let visited = 0;
    let skippedDirectories = 0;
    let parsedDocuments = 0;
    let documentContentLimited = false;
    const walk = async (directory, depth) => {
      signal?.throwIfAborted();
      if (depth > 5 || visited >= 300 || matches.length >= 30) return;
      let entries;
      try { entries = await this.list(directory); }
      catch (error) {
        if (depth === 0 || !['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error;
        skippedDirectories++;
        return;
      }
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (++visited > 300 || matches.length >= 30) break;
        if (entry.type === 'blocked_symlink') continue;
        if (entry.type === 'directory') {
          if (entry.symlink) continue; // Avoid recursive symlink cycles; direct paths still work.
          await walk(entry.path, depth + 1);
          continue;
        }
        const nameMatch = entry.name.toLowerCase().includes(query.toLowerCase());
        if (RICH_DOCUMENT_EXTENSIONS.has(extension(entry.path))) {
          if (parsedDocuments >= 12) {
            documentContentLimited = true;
            if (nameMatch) matches.push({ path: entry.path, snippet: 'Filename match; narrow the search directory to inspect document content.' });
            continue;
          }
          parsedDocuments++;
        }
        try {
          const file = await this.read(entry.path, { signal });
          const index = file.content.toLowerCase().indexOf(query.toLowerCase());
          if (nameMatch || index >= 0) matches.push({
            path: entry.path,
            snippet: index >= 0 ? file.content.slice(Math.max(0, index - 80), index + 240) : '',
            contentTruncated: file.truncated
          });
        } catch {
          signal?.throwIfAborted();
          if (nameMatch) matches.push({ path: entry.path, snippet: 'Filename match; file could not be read as text.' });
        }
      }
    };
    await walk(startPath, 0);
    return { matches, visited, skippedDirectories, parsedDocuments, documentContentLimited, bounded: visited >= 300 || matches.length >= 30 || documentContentLimited };
  }

  async write(relative, content, overwrite = false) {
    assertTextWrite(relative);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) throw new Error('Write content must be text under 128 KB');
    const filename = await this.resolve(relative, { createParents: true });
    await fs.writeFile(filename, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
    return { path: relative, bytes: Buffer.byteLength(content) };
  }

  async importDocument(filename, bytes) {
    if (typeof filename !== 'string' || !filename || filename !== path.basename(filename) || filename.includes('\\') || filename.includes('\0')) throw new Error('Use a simple document filename');
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Upload a document no larger than 16 MB');
    const ext = extension(filename);
    if (!RICH_DOCUMENT_EXTENSIONS.has(ext) && !['.pdf', '.ppt'].includes(ext)) throw new Error('This binary upload format is not supported');
    validateDocumentHeader(ext, bytes.subarray(0, 1024));
    const destination = path.posix.join('imports', filename);
    const resolved = await this.resolve(destination, { createParents: true });
    await fs.writeFile(resolved, bytes, { flag: 'wx' });
    return { path: destination, bytes: bytes.length, format: ext.slice(1) };
  }

  async move(source, destination) {
    const from = await this.resolve(source);
    const to = await this.resolve(destination, { createParents: true });
    if (!(await fs.stat(from)).isFile()) throw new Error('Only individual files can be moved');
    try {
      await fs.lstat(to);
      throw new Error('Destination already exists; choose another filename');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { await fs.link(from, to); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    }
    await fs.unlink(from);
    return { source, destination };
  }
}
