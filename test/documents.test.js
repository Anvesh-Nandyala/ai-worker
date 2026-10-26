import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zipSync, strToU8 } from 'fflate';
import { Workspace } from '../src/files.js';
import { FileViewer } from '../src/file-viewer.js';
import { MAX_DOCUMENT_BYTES } from '../src/document-formats.js';
import { workbookFixture, docxFixture, slidesFixture, openDocumentFixture } from './helpers/documents.js';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-documents-'));
  const workspace = new Workspace(directory);
  await workspace.init();
  return { directory, workspace, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('Excel reader returns sheets, saved formula values and exact cell ranges without changing files', async () => {
  const f = await fixture();
  try {
    const bytes = workbookFixture();
    await fs.writeFile(path.join(f.directory, 'costs.xlsx'), bytes);
    const before = createHash('sha256').update(bytes).digest('hex');
    const read = await f.workspace.spreadsheet('costs.xlsx', { sheet: 'Costs', range: 'A1:B5' });
    assert.deepEqual(read.sheets, ['Costs', 'Notes']);
    assert.deepEqual(read.rows[1], ['Notebook', 80]);
    assert.equal(read.rows[3][1], 1030);
    assert.equal(read.formulas.B4, 'SUM(B2:B3)');
    assert.equal(read.rows[4][1], null);
    assert.match(read.calculation, /not recalculated/);
    assert.equal(read.warnings.some(message => message.includes('B5')), true);
    assert.equal((await f.workspace.spreadsheet('costs.xlsx', { sheet: 'Notes', range: 'A1:B1' })).rows[0][1], 'Anvesh');
    const preview = await f.workspace.read('costs.xlsx');
    assert.match(preview.content, /Notebook\t80/);
    assert.match(preview.content, /Sheet: Notes/);
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(f.directory, 'costs.xlsx'))).digest('hex'), before);
    await assert.rejects(f.workspace.spreadsheet('costs.xlsx', { sheet: 'Unknown' }), /not found/);
    await assert.rejects(f.workspace.spreadsheet('costs.xlsx', { range: 'A0:ZZ9999999' }), /Excel range/);
    await assert.rejects(f.workspace.write('costs.xlsx', 'corrupt replacement', true), /read-only/);
  } finally { await f.cleanup(); }
});

test('legacy XLS, ODS, CSV and TSV ranges are readable', async () => {
  const f = await fixture();
  try {
    for (const [ext, type] of [['xls', 'biff8'], ['ods', 'ods']]) {
      await fs.writeFile(path.join(f.directory, 'costs.' + ext), workbookFixture(type));
      const result = await f.workspace.spreadsheet('costs.' + ext, { range: 'A1:B3' });
      assert.equal(result.rows[1][0], 'Notebook');
      assert.equal(result.rows[2][1], 950);
    }
    for (const [ext, content] of [['csv', 'Name,Amount\nNotebook,80\n'], ['tsv', 'Name\tAmount\nNotebook\t80\n']]) {
      await f.workspace.write('costs.' + ext, content);
      assert.equal((await f.workspace.spreadsheet('costs.' + ext)).rows[1][0], 'Notebook');
    }
  } finally { await f.cleanup(); }
});

test('Word, PowerPoint and OpenDocument text is extracted in source order', async () => {
  const f = await fixture();
  try {
    for (const [name, bytes] of [['brief.docx', docxFixture()], ['slides.pptx', slidesFixture()], ['notes.odt', openDocumentFixture()], ['slides.odp', openDocumentFixture()]]) {
      await fs.writeFile(path.join(f.directory, name), bytes);
      const result = await f.workspace.read(name);
      assert.match(result.content, /Project Cedar/);
      assert.equal(result.truncated, false);
      assert.deepEqual(await fs.readFile(path.join(f.directory, name)), bytes);
    }
    const doc = await f.workspace.read('brief.docx');
    assert.match(doc.content, /Owner: Anvesh/);
    assert.match(doc.content, /Read & summarize/);
    const slides = await f.workspace.read('slides.pptx');
    assert.ok(slides.content.indexOf('First slide') < slides.content.indexOf('Second slide'));
    assert.match(slides.content, /Second slide & decisions/);
    await fs.writeFile(path.join(f.directory, 'reordered.pptx'), slidesFixture(true));
    const reordered = await f.workspace.read('reordered.pptx');
    assert.ok(reordered.content.indexOf('Second slide') < reordered.content.indexOf('First slide'));
    assert.ok((await f.workspace.search('Project Cedar')).matches.some(match => match.path === 'brief.docx'));
  } finally { await f.cleanup(); }
});

test('large ranges are paged, oversized documents and expanded archives are bounded, and parsing can stop', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'many.xlsx'), workbookFixture('xlsx', true));
    const result = await f.workspace.spreadsheet('many.xlsx', { range: 'A1:B301' });
    assert.equal(result.rows.length, 200);
    assert.equal(result.truncated, true);
    assert.equal(result.nextRange, 'A201:B301');
    assert.equal((await f.workspace.spreadsheet('many.xlsx', { range: result.nextRange })).rows[0][0], 'Item 200');
    await fs.writeFile(path.join(f.directory, 'large.docx'), '');
    await fs.truncate(path.join(f.directory, 'large.docx'), MAX_DOCUMENT_BYTES + 1);
    await assert.rejects(f.workspace.read('large.docx'), /16 MB/);
    const archive = Buffer.from(zipSync({ 'word/document.xml': strToU8('tiny') }));
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    archive.writeUInt32LE(33 * 1024 * 1024, central + 24);
    await fs.writeFile(path.join(f.directory, 'expanded.docx'), archive);
    await assert.rejects(f.workspace.read('expanded.docx'), /expanded-size/);
    const controller = new AbortController();
    const reading = f.workspace.read('many.xlsx', { signal: controller.signal });
    controller.abort(new Error('Stopped by user'));
    await assert.rejects(reading, /Stopped by user/);
  } finally { await f.cleanup(); }
});

test('Office opener and imports validate formats, preserve bytes and reject scope escapes', async () => {
  const f = await fixture();
  try {
    const calls = [];
    const viewer = new FileViewer(f.workspace, { platform: 'darwin', launch: async (...args) => { calls.push(args); } });
    for (const [name, bytes] of [['costs.xlsx', workbookFixture()], ['brief.docx', docxFixture()], ['slides.pptx', slidesFixture()]]) {
      const imported = await f.workspace.importDocument(name, bytes);
      assert.deepEqual(await fs.readFile(path.join(f.directory, imported.path)), bytes);
      await viewer.open(imported.path);
      assert.equal((await viewer.verify(imported.path)).passed, true);
      assert.deepEqual(calls.at(-1)[1], [await fs.realpath(path.join(f.directory, imported.path))]);
      assert.equal(calls.at(-1)[0], '/usr/bin/open');
      await assert.rejects(f.workspace.importDocument(name, bytes), { code: 'EEXIST' });
    }
    await assert.rejects(viewer.open('../outside.xlsx'), /stay inside/);
    await assert.rejects(f.workspace.importDocument('fake.docx', Buffer.from('not a document')), /readable/);
    await assert.rejects(f.workspace.importDocument('app.command', Buffer.from('anything')), /not supported/);
    await assert.rejects(f.workspace.importDocument('../escape.xlsx', workbookFixture()), /simple document filename/);
  } finally { await f.cleanup(); }
});

test('legacy Word DOC and RTF text extraction works on macOS', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'notes.rtf'), '{\\rtf1\\ansi Project Cedar\\par Owner: Anvesh}');
    const result = await f.workspace.read('notes.rtf');
    assert.match(result.content, /Project Cedar/);
    assert.match(result.content, /Owner: Anvesh/);
    await fs.writeFile(path.join(f.directory, 'source.docx'), docxFixture());
    await promisify(execFile)('/usr/bin/textutil', ['-convert', 'doc', '-output', path.join(f.directory, 'legacy.doc'), '--', path.join(f.directory, 'source.docx')]);
    const legacy = await f.workspace.read('legacy.doc');
    assert.match(legacy.content, /Project Cedar/);
    assert.match(legacy.content, /Owner: Anvesh/);
  } finally { await f.cleanup(); }
});
