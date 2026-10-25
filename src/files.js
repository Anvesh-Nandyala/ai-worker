import fs from 'node:fs/promises';
import path from 'node:path';

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
  }

  async resolve(relative = '.', { createParents = false } = {}) {
    if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\0')) {
      throw new Error('Invalid workspace path');
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
    return entries.slice(0, 150).map(entry => ({
      name: entry.name,
      path: path.posix.join(relative, entry.name),
      type: entry.isSymbolicLink() ? 'blocked_symlink' : entry.isDirectory() ? 'directory' : 'file'
    }));
  }

  async read(relative) {
    if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|zip|exe)$/i.test(relative)) throw new Error('This file format needs a document adapter; the current reader supports UTF-8 text');
    const filename = await this.resolve(relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error('Path is not a file');
    if (stat.size > 512 * 1024) throw new Error('File exceeds the 512 KB text-reading limit');
    const bytes = await fs.readFile(filename);
    if (bytes.includes(0)) throw new Error('Binary files are not supported; use a text, Markdown, JSON or CSV file');
    const text = bytes.toString('utf8');
    return { path: relative, content: text.slice(0, 32000), truncated: text.length > 32000 };
  }

  async search(query) {
    if (!query || typeof query !== 'string') throw new Error('Provide a search query');
    const matches = [];
    let visited = 0;
    const walk = async (directory, depth) => {
      if (depth > 5 || visited >= 300 || matches.length >= 30) return;
      for (const entry of await this.list(directory)) {
        if (++visited > 300 || matches.length >= 30) break;
        if (entry.type === 'blocked_symlink') continue;
        if (entry.type === 'directory') {
          await walk(entry.path, depth + 1);
          continue;
        }
        const nameMatch = entry.name.toLowerCase().includes(query.toLowerCase());
        try {
          const file = await this.read(entry.path);
          const index = file.content.toLowerCase().indexOf(query.toLowerCase());
          if (nameMatch || index >= 0) matches.push({
            path: entry.path,
            snippet: index >= 0 ? file.content.slice(Math.max(0, index - 80), index + 240) : '',
            contentTruncated: file.truncated
          });
        } catch {
          if (nameMatch) matches.push({ path: entry.path, snippet: 'Filename match; file could not be read as text.' });
        }
      }
    };
    await walk('.', 0);
    return { matches, visited, bounded: visited >= 300 || matches.length >= 30 };
  }

  async write(relative, content, overwrite = false) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) throw new Error('Write content must be text under 128 KB');
    const filename = await this.resolve(relative, { createParents: true });
    await fs.writeFile(filename, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
    return { path: relative, bytes: Buffer.byteLength(content) };
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
    await fs.link(from, to);
    await fs.unlink(from);
    return { source, destination };
  }
}
