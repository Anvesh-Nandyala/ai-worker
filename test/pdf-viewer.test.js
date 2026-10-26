import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/files.js';
import { PDFViewer } from '../src/pdf-viewer.js';
import { Run, RunManager } from '../src/agent.js';

const pdf = '%PDF-1.4\n% Test fixture for file validation; the opener is mocked.\n%%EOF\n';

async function fixture({ all = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-pdf-'));
  const workspace = new Workspace(path.join(directory, 'workspace'), { allowAllFiles: all });
  await workspace.init();
  const calls = [];
  const viewer = new PDFViewer(workspace, { platform: 'darwin', launch: async (...args) => { calls.push(args); } });
  return { directory, workspace, viewer, calls, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('PDF opener passes one literal absolute filename to the fixed macOS opener', async () => {
  const f = await fixture();
  try {
    const filename = 'a space $(do-not-execute); note.PDF';
    await fs.writeFile(path.join(f.workspace.root, filename), pdf);
    assert.equal((await f.viewer.verify(filename)).passed, false);
    const result = await f.viewer.open(filename, new AbortController().signal);
    assert.equal(result.opened, true);
    assert.equal(f.calls[0][0], '/usr/bin/open');
    assert.deepEqual(f.calls[0][1], [path.join(f.workspace.root, filename)]);
    assert.equal(f.calls[0][2].shell, undefined);
    const checked = await f.viewer.verify(filename);
    assert.equal(checked.passed, true);
    assert.match(checked.actual, /Viewer visibility is not verified/);
    await fs.appendFile(path.join(f.workspace.root, filename), '% changed');
    assert.equal((await f.viewer.verify(filename)).passed, false);
  } finally { await f.cleanup(); }
});

test('PDF opener rejects unsupported files and respects workspace boundaries', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'outside.pdf'), pdf);
    await assert.rejects(f.viewer.open('../outside.pdf'), /stay inside/);
    await assert.rejects(f.viewer.open(path.join(f.directory, 'outside.pdf')), /relative workspace/);
    await fs.symlink(path.join(f.directory, 'outside.pdf'), path.join(f.workspace.root, 'link.pdf'));
    await assert.rejects(f.viewer.open('link.pdf'), /Symbolic/);
    await fs.writeFile(path.join(f.workspace.root, 'bad.pdf'), 'Not a PDF');
    await assert.rejects(f.viewer.open('bad.pdf'), /PDF header/);
    await fs.writeFile(path.join(f.workspace.root, 'script.js'), pdf);
    await assert.rejects(f.viewer.open('script.js'), /local .pdf file/);
    await assert.rejects(f.viewer.open('missing.pdf'), { code: 'ENOENT' });
    await fs.mkdir(path.join(f.workspace.root, 'folder.pdf'));
    await assert.rejects(f.viewer.open('folder.pdf'), /not a regular file/);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('all-files mode can open an external PDF and verify through a symlink', async () => {
  const f = await fixture({ all: true });
  try {
    const external = path.join(f.directory, 'external.pdf');
    await fs.writeFile(external, pdf);
    await fs.symlink(external, path.join(f.workspace.root, 'linked.pdf'));
    await f.viewer.open('linked.pdf');
    assert.equal(f.calls[0][1][0], await fs.realpath(external));
    assert.equal((await f.viewer.verify(external)).passed, true);
    await fs.writeFile(path.join(f.directory, 'other.command'), pdf);
    await fs.symlink(path.join(f.directory, 'other.command'), path.join(f.workspace.root, 'disguised.pdf'));
    await assert.rejects(f.viewer.open('disguised.pdf'), /resolve to a supported document file/);
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('failed, cancelled and unsupported-platform openings produce no successful receipt', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspace.root, 'test.pdf'), pdf);
    f.viewer.launch = async () => { throw new Error('No associated application'); };
    await assert.rejects(f.viewer.open('test.pdf'), /No associated application/);
    assert.equal((await f.viewer.verify('test.pdf')).passed, false);
    f.viewer.platform = 'linux';
    await assert.rejects(f.viewer.open('test.pdf'), /supported on macOS/);
    const stopped = new AbortController();
    stopped.abort(new Error('Stopped by user'));
    await assert.rejects(f.viewer.open('test.pdf', stopped.signal), /Stopped by user/);
  } finally { await f.cleanup(); }
});

test('agent uses file_opened evidence and refuses completion after the PDF changes', async () => {
  const f = await fixture();
  const manager = new RunManager({ workspace: f.workspace, runsDirectory: path.join(f.directory, 'runs'), config: { maxTurns: 8, maxToolCalls: 30 } });
  await manager.init();
  const run = new Run(manager, { provider: 'ollama', task: 'Open the PDF' });
  run.fileViewer = f.viewer;
  try {
    await fs.writeFile(path.join(f.workspace.root, 'test.pdf'), pdf);
    const args = { kind: 'file_opened', target: 'test.pdf', expected: '' };
    assert.equal((await run.execute('verify', args)).passed, false);
    assert.equal((await run.execute('file_open_pdf', { path: 'test.pdf' })).opened, true);
    assert.equal(run.pending, undefined);
    const evidence = await run.execute('verify', args);
    assert.equal(evidence.passed, true);
    await fs.appendFile(path.join(f.workspace.root, 'test.pdf'), '% changed');
    assert.equal((await run.execute('finish', { summary: 'PDF opening accepted by macOS', evidence: [evidence.id] })).ok, false);
    await run.execute('file_open_pdf', { path: 'test.pdf' });
    const current = await run.execute('verify', args);
    assert.equal((await run.execute('finish', { summary: 'macOS accepted opening the PDF', evidence: [current.id] })).completed, true);
  } finally {
    await run.persistChain;
    await f.cleanup();
  }
});
