import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Workspace } from '../src/files.js';
import { webURL } from '../src/browser.js';
import { Run, RunManager } from '../src/agent.js';
import { validateTool } from '../src/tools.js';
import { GeminiProvider } from '../src/providers.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-core-'));
  const workspace = new Workspace(path.join(root, 'workspace'));
  await workspace.init();
  const manager = new RunManager({ workspace, runsDirectory: path.join(root, 'runs'), config: { maxTurns: 5, maxToolCalls: 30, maxMinutes: 1 } });
  await manager.init();
  const run = new Run(manager, { task: 'Test outcome verification', provider: 'demo' });
  await fs.mkdir(run.directory, { recursive: true });
  return { root, workspace, manager, run, cleanup: async () => { await run.persistChain; await fs.rm(root, { recursive: true, force: true }); } };
}

test('workspace blocks traversal, absolute paths, symlinks and accidental replacement', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workspace.read('../secret.txt'), /inside/);
    await assert.rejects(f.workspace.read('/etc/passwd'), /relative/);
    await fs.symlink(os.tmpdir(), path.join(f.workspace.root, 'escape'));
    await assert.rejects(f.workspace.write('escape/no.txt', 'bad'), /Symbolic/);
    await f.workspace.write('notes/a.md', 'Original');
    await assert.rejects(f.workspace.write('notes/a.md', 'Changed'), { code: 'EEXIST' });
    await f.workspace.write('notes/b.md', 'Destination');
    await assert.rejects(f.workspace.move('notes/a.md', 'notes/b.md'), /already exists/);
    assert.equal((await f.workspace.read('notes/a.md')).content, 'Original');
    const matches = await f.workspace.search('Original');
    assert.equal(matches.matches[0].path, 'notes/a.md');
  } finally { await f.cleanup(); }
});

test('tools reject unsupported actions and URLs', () => {
  assert.throws(() => validateTool('shell', { command: 'anything' }), /Unknown/);
  assert.throws(() => validateTool('browser_fill', { role: 'textbox', name: 'Title', value: 3 }), /Invalid/);
  assert.throws(() => validateTool('browser_press', { key: 'Control+R' }), /choice/);
  assert.throws(() => webURL('file:///etc/passwd'), /HTTP/);
  assert.throws(() => webURL('https://user:password@example.com'), /credentials/);
});

test('writes remain paused until approval; declined writes do not happen', async () => {
  const f = await fixture();
  try {
    const writing = f.run.execute('file_write', { path: 'result.md', content: 'Approved content', overwrite: false });
    while (!f.run.pending) await delay(5);
    await assert.rejects(f.workspace.read('result.md'), { code: 'ENOENT' });
    assert.equal(f.run.status, 'awaiting_approval');
    f.run.answer(f.run.pending.token, false);
    assert.equal((await writing).ok, false);
    await assert.rejects(f.workspace.read('result.md'), { code: 'ENOENT' });
    const accepted = f.run.execute('file_write', { path: 'result.md', content: 'Approved content', overwrite: false });
    while (!f.run.pending) await delay(5);
    f.run.answer(f.run.pending.token, true);
    assert.equal((await accepted).path, 'result.md');
    assert.equal((await f.workspace.read('result.md')).content, 'Approved content');
  } finally { await f.cleanup(); }
});

test('completion requires passed current evidence; later mutations invalidate checks', async () => {
  const f = await fixture();
  try {
    await f.workspace.write('result.md', 'The requested result');
    assert.equal((await f.run.execute('finish', { summary: 'Done', evidence: [] })).ok, false);
    const failed = await f.run.execute('verify', { kind: 'file_contains', target: 'result.md', expected: 'wrong' });
    assert.equal(failed.passed, false);
    assert.equal((await f.run.execute('finish', { summary: 'Done', evidence: [failed.id] })).ok, false);
    const passed = await f.run.execute('verify', { kind: 'file_contains', target: 'result.md', expected: 'requested result' });
    f.run.fileRevision++;
    assert.equal((await f.run.execute('finish', { summary: 'Done', evidence: [passed.id] })).ok, false);
    const current = await f.run.execute('verify', { kind: 'file_contains', target: 'result.md', expected: 'requested result' });
    assert.equal((await f.run.execute('finish', { summary: 'Verified file', evidence: [current.id] })).completed, true);
  } finally { await f.cleanup(); }
});

test('clarification preserves user answer and stop interrupts a pending question', async () => {
  const f = await fixture();
  try {
    const question = f.run.execute('ask_user', { question: 'Which project?', options: ['Orbit', 'Relay'] });
    while (!f.run.pending) await delay(5);
    f.run.answer(f.run.pending.token, 'Orbit');
    assert.equal((await question).answer, 'Orbit');
    const waiting = f.run.execute('ask_user', { question: 'Anything else?', options: [] });
    while (!f.run.pending) await delay(5);
    f.run.abort.abort(new Error('Stopped by user'));
    await assert.rejects(waiting, /Stopped/);
  } finally { await f.cleanup(); }
});

test('finish rechecks evidence when a file changes outside the agent', async () => {
  const f = await fixture();
  try {
    await f.workspace.write('result.md', 'Expected outcome');
    const evidence = await f.run.execute('verify', { kind: 'file_contains', target: 'result.md', expected: 'Expected outcome' });
    await f.workspace.write('result.md', 'Changed outside the agent', true);
    const result = await f.run.execute('finish', { summary: 'Done', evidence: [evidence.id] });
    assert.equal(result.ok, false);
    assert.notEqual(f.run.status, 'completed');
    assert.match(result.error, /no longer satisfies/);
  } finally { await f.cleanup(); }
});

test('external browser interactions cannot execute without approval', async () => {
  const f = await fixture();
  let clicks = 0;
  f.run.computer = {
    page: { url: () => 'https://example.com/form', isClosed: () => false },
    target: async () => ({ click: async () => { clicks++; } }),
    observe: async () => ({ url: 'https://example.com/form', structure: 'Saved' })
  };
  try {
    const clicking = f.run.execute('browser_click', { role: 'button', name: 'Save' });
    while (!f.run.pending) await delay(5);
    assert.equal(clicks, 0);
    f.run.answer(f.run.pending.token, false);
    assert.equal((await clicking).ok, false);
    assert.equal(clicks, 0);
    const accepted = f.run.execute('browser_click', { role: 'button', name: 'Save' });
    while (!f.run.pending) await delay(5);
    f.run.answer(f.run.pending.token, true);
    assert.equal((await accepted).ok, true);
    assert.equal(clicks, 1);
  } finally { await f.cleanup(); }
});

test('Gemini retries a transient 503, and does not retry exhausted quota', async () => {
  let calls = 0;
  const retries = [];
  const provider = new GeminiProvider({ apiKey: 'test-not-real', model: 'test', onRetry: item => retries.push(item) });
  provider.client = { models: { generateContent: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('busy'), { status: 503 });
    return { text: 'recovered' };
  } } };
  assert.equal((await provider.generate([], {}, new AbortController().signal)).text, 'recovered');
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  calls = 0;
  provider.client.models.generateContent = async () => { calls++; throw Object.assign(new Error('quota'), { status: 429 }); };
  await assert.rejects(provider.generate([], {}, new AbortController().signal), /quota/);
  assert.equal(calls, 1);
});
