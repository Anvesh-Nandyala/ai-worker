import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Workspace } from '../src/files.js';
import { Run, RunManager } from '../src/agent.js';
import { validateTool } from '../src/tools.js';
import { createApp } from '../server.js';

test('all-files mode reads and searches outside the workspace and follows explicit symlink paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-files-'));
  try {
    const workspace = new Workspace(path.join(directory, 'workspace'), { allowAllFiles: true });
    await workspace.init();
    const external = path.join(directory, 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'brief.md'), 'External project brief');
    assert.equal((await workspace.read('../external/brief.md')).content, 'External project brief');
    assert.equal((await workspace.read(path.join(external, 'brief.md'))).content, 'External project brief');
    assert.equal(await workspace.resolve('~/Documents'), path.join(os.homedir(), 'Documents'));
    assert.equal(await workspace.resolve('/'), path.parse(workspace.root).root);
    const found = await workspace.search('External', external);
    assert.equal(found.matches[0].path, path.join(external, 'brief.md'));
    await fs.symlink(external, path.join(workspace.root, 'linked'));
    await fs.symlink(external, path.join(external, 'cycle'));
    assert.equal((await workspace.read('linked/brief.md')).content, 'External project brief');
    assert.equal((await workspace.list('.')).find(item => item.name === 'linked').type, 'directory');
    assert.equal((await workspace.search('External', external)).matches.length, 1);
    await assert.rejects(workspace.read('bad\0path'), /Invalid/);
    await assert.rejects(workspace.read(external), /not a file/);
    await assert.rejects(workspace.write(path.join(external, 'brief.md'), 'Overwrite'), { code: 'EEXIST' });
    await workspace.move(path.join(external, 'brief.md'), path.join(directory, 'moved.md'));
    assert.equal((await workspace.read(path.join(directory, 'moved.md'))).content, 'External project brief');
    await assert.rejects(fs.access(path.join(external, 'brief.md')), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('external file changes still wait for approval and show the resolved destination', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-approval-'));
  const workspace = new Workspace(path.join(directory, 'workspace'), { allowAllFiles: true });
  await workspace.init();
  const manager = new RunManager({ workspace, runsDirectory: path.join(directory, 'runs'), config: { maxTurns: 5, maxToolCalls: 30 } });
  await manager.init();
  const run = new Run(manager, { task: 'Save outside workspace', provider: 'demo' });
  try {
    const destination = path.join(directory, 'external', 'summary.md');
    const args = { path: destination, content: 'Approved external content', overwrite: false };
    const declined = run.execute('file_write', args);
    while (!run.pending) await delay(5);
    assert.equal(run.pending.details.resolvedPath, destination);
    await assert.rejects(fs.access(path.dirname(destination)), { code: 'ENOENT' });
    run.answer(run.pending.token, false);
    assert.equal((await declined).ok, false);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    const accepted = run.execute('file_write', args);
    while (!run.pending) await delay(5);
    run.answer(run.pending.token, true);
    assert.equal((await accepted).path, destination);
    const evidence = await run.execute('verify', { kind: 'file_contains', target: destination, expected: args.content });
    assert.equal(evidence.passed, true);
    assert.equal((await run.execute('finish', { summary: 'Saved and checked external file', evidence: [evidence.id] })).completed, true);
  } finally {
    await run.persistChain;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('search accepts an optional directory while rejecting invalid arguments', () => {
  validateTool('file_search', { query: 'project' });
  validateTool('file_search', { query: 'project', path: '~/Documents' });
  assert.throws(() => validateTool('file_search', { query: 'project', path: 42 }), /Invalid/);
});

test('moving across filesystems keeps contents and does not overwrite a destination created during the move', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-move-'));
  const workspace = new Workspace(path.join(directory, 'workspace'), { allowAllFiles: true });
  await workspace.init();
  const source = path.join(directory, 'source.txt');
  const destination = path.join(directory, 'destination.txt');
  try {
    await fs.writeFile(source, 'Move this content');
    const link = t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Different filesystems'), { code: 'EXDEV' }); });
    await workspace.move(source, destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'Move this content');
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
    await fs.writeFile(source, 'Keep this source');
    const collision = path.join(directory, 'collision.txt');
    link.mock.mockImplementation(async () => {
      await fs.writeFile(collision, 'Keep this destination');
      throw Object.assign(new Error('Different filesystems'), { code: 'EXDEV' });
    });
    await assert.rejects(workspace.move(source, collision), { code: 'EEXIST' });
    assert.equal(await fs.readFile(source, 'utf8'), 'Keep this source');
    assert.equal(await fs.readFile(collision, 'utf8'), 'Keep this destination');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('file API exposes enabled mode and navigation for an external directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-files-api-'));
  const app = await createApp({ dataDirectory: path.join(directory, 'data'), apiKey: '', fileAccess: 'all' });
  try {
    await fs.writeFile(path.join(directory, 'outside.txt'), 'External API content');
    const base = await app.listen(0);
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.fileAccess, 'all');
    assert.equal(config.homeDirectory, os.homedir());
    const folder = await (await fetch(base + '/api/workspace?path=' + encodeURIComponent(directory))).json();
    assert.equal(folder.path, directory);
    assert.equal(folder.parent, path.dirname(directory));
    const file = await (await fetch(base + '/api/workspace/file?path=' + encodeURIComponent(path.join(directory, 'outside.txt')))).json();
    assert.equal(file.content, 'External API content');
    assert.equal((await fetch(base + '/api/workspace?path=/', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
