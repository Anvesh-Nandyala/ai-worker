import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/files.js';
import { pdfFixture } from './helpers/pdf.js';

test('PDF text reading preserves source bytes, page boundaries and search/preview integration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-pdf-read-'));
  const workspace = new Workspace(directory);
  await workspace.init();
  try {
    const bytes = pdfFixture([['Company: Cedar', 'Amount due: INR 18450.75'], ['Due date: 2026-11-19']]);
    await workspace.importDocument('invoice.pdf', bytes);
    const result = await workspace.read('imports/invoice.pdf');
    assert.equal(result.pages, 2);
    assert.equal(result.truncated, false);
    assert.match(result.content, /Page 1[\s\S]*18450\.75[\s\S]*Page 2[\s\S]*2026-11-19/);
    assert.deepEqual(await fs.readFile(path.join(directory, 'imports/invoice.pdf')), bytes);
    assert.equal((await workspace.search('Cedar')).matches[0].path, 'imports/invoice.pdf');
    await assert.rejects(workspace.write('imports/invoice.pdf', 'bad', true), /only writes text/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('PDF reader reports empty pages, rejects unreadable PDFs and bounds output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-pdf-limits-'));
  const workspace = new Workspace(directory);
  await workspace.init();
  try {
    await workspace.importDocument('empty.pdf', pdfFixture([[]]));
    await assert.rejects(workspace.read('imports/empty.pdf'), /OCR is not available/);
    await workspace.importDocument('mixed.pdf', pdfFixture([['Some text'], []]));
    assert.match((await workspace.read('imports/mixed.pdf')).warnings[0], /page\(s\) 2/);
    await workspace.importDocument('many.pdf', pdfFixture(Array.from({ length: 51 }, (_, i) => ['Page content ' + (i + 1)])));
    const many = await workspace.read('imports/many.pdf');
    assert.equal(many.pagesRead, 50);
    assert.equal(many.truncated, true);
    assert.equal(many.content.includes('Page content 51'), false);
    await workspace.importDocument('long.pdf', pdfFixture(Array.from({ length: 30 }, () => Array.from({ length: 30 }, () => 'Long content '.repeat(5)))));
    const long = await workspace.read('imports/long.pdf');
    assert.ok(long.content.length <= 32000);
    assert.equal(long.truncated, true);
    await workspace.importDocument('broken.pdf', Buffer.from('%PDF-1.4\ninvalid'));
    await assert.rejects(workspace.read('imports/broken.pdf'), /Could not read document/);
    const abort = new AbortController();
    abort.abort(new Error('PDF cancelled'));
    await assert.rejects(workspace.read('imports/many.pdf', { signal: abort.signal }), /cancelled/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
