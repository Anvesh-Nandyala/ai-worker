import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { Run } from '../src/agent.js';
import { FileViewer } from '../src/file-viewer.js';
import { workbookFixture, docxFixture } from './helpers/documents.js';

test('Office uploads preserve bytes and file API returns readable workbook and Word previews', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-office-api-'));
  const app = await createApp({ dataDirectory: directory, apiKey: '', fileAccess: 'workspace' });
  try {
    const base = await app.listen(0);
    for (const [filename, bytes, expected] of [['costs.xlsx', workbookFixture(), 'Notebook'], ['brief.docx', docxFixture(), 'Project Cedar']]) {
      const upload = { filename, encoding: 'base64', data: bytes.toString('base64') };
      const response = await fetch(base + '/api/workspace/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upload) });
      assert.equal(response.status, 201);
      const saved = await response.json();
      assert.deepEqual(await fs.readFile(path.join(app.workspace.root, saved.path)), bytes);
      const read = await (await fetch(base + '/api/workspace/file?path=' + encodeURIComponent(saved.path))).json();
      assert.ok(read.content.includes(expected));
      assert.equal((await fetch(base + '/api/workspace/upload', { method: 'POST', body: JSON.stringify(upload) })).status, 400);
    }
    for (const input of [
      { filename: '../escape.docx', encoding: 'base64', data: docxFixture().toString('base64') },
      { filename: 'bad.docx', encoding: 'base64', data: '**not-base64**' },
      { filename: 'fake.xlsx', encoding: 'base64', data: Buffer.from('not a workbook').toString('base64') },
      { filename: 'corrupt.docx', content: 'not a document' }
    ]) assert.equal((await fetch(base + '/api/workspace/upload', { method: 'POST', body: JSON.stringify(input) })).status, 400);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('agent reads sheet ranges, verifies document text, opens Office files and blocks binary text writes before approval', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-office-agent-'));
  const app = await createApp({ dataDirectory: directory, apiKey: '' });
  const run = new Run(app.manager, { provider: 'ollama', task: 'Read and open documents' });
  run.fileViewer = new FileViewer(app.workspace, { platform: 'darwin', launch: async () => {} });
  try {
    await fs.writeFile(path.join(app.workspace.root, 'costs.xlsx'), workbookFixture());
    const data = await run.execute('spreadsheet_read', { path: 'costs.xlsx', sheet: 'Costs', range: 'A1:B4' });
    assert.equal(data.rows[3][1], 1030);
    assert.match(run.view().notes[0], /not recalculated/);
    assert.equal((await run.execute('verify', { kind: 'file_contains', target: 'costs.xlsx', expected: 'Notebook\t80' })).passed, true);
    assert.equal((await run.execute('file_open', { path: 'costs.xlsx' })).opened, true);
    const opened = await run.execute('verify', { kind: 'file_opened', target: 'costs.xlsx', expected: '' });
    assert.equal(opened.passed, true);
    const denied = await run.execute('file_write', { path: 'costs.xlsx', content: 'bad replacement', overwrite: true });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /read-only/);
    assert.equal(run.pending, undefined);
  } finally {
    await run.persistChain;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
