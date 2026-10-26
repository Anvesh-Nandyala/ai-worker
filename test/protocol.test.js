import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { startOllamaFixture } from './helpers/ollama-server.js';

test('live controller preserves model content, reports tool failures and verifies before finishing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-protocol-'));
  let turn = 0;
  const signedContents = [];
  const provider = { generate: async contents => {
    if (turn > 0) assert.ok(contents.some(item => item === signedContents[turn - 1]), 'Exact model content including thought signature must be replayed');
    if (turn === 1) assert.equal(contents.at(-1).parts[0].functionResponse.response.ok, false);
    const calls = [
      { name: 'file_read', args: { path: 'does-not-exist.md' } },
      { name: 'file_read', args: { path: 'notes/project-brief.md' } },
      { name: 'verify', args: { kind: 'file_contains', target: 'notes/project-brief.md', expected: 'Project Orbit' } },
      { name: 'finish', args: { summary: 'Verified the project brief exists and identifies Project Orbit.', evidence: ['E1'] } }
    ];
    const call = { ...calls[turn], id: 'call-' + turn };
    const content = { role: 'model', parts: [{ functionCall: call, thoughtSignature: 'signature-' + turn }] };
    signedContents.push(content);
    turn++;
    return { candidates: [{ content }], functionCalls: [call] };
  } };
  const app = await createApp({ dataDirectory: directory, apiKey: 'test-not-real', providerFactory: () => provider });
  try {
    await app.listen(0);
    const run = app.manager.create({ provider: 'gemini', task: 'Find and verify the Orbit brief', startURL: app.manager.baseURL + '/demo' });
    const deadline = Date.now() + 30000;
    while (!['completed', 'failed', 'stopped'].includes(run.status) && Date.now() < deadline) await delay(50);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(turn, 4);
    assert.ok(run.events.some(event => event.type === 'tool_error'));
    assert.equal(run.evidence[0].passed, true);
    await run.persistChain;
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Ollama controller completes a verified task through native HTTP tools without a Gemini key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-ollama-'));
  const ollama = await startOllamaFixture();
  const app = await createApp({ dataDirectory: directory, apiKey: '', defaultProvider: 'ollama', ollamaModel: 'test-model', ollamaBaseURL: ollama.baseURL });
  try {
    await app.listen(0);
    const status = await (await fetch(app.manager.baseURL + '/api/ollama/status')).json();
    assert.equal(status.ready, true);
    const run = app.manager.create({ provider: 'ollama', task: 'Read and verify the project brief' });
    const deadline = Date.now() + 30000;
    while (!['completed', 'failed', 'stopped', 'blocked'].includes(run.status) && Date.now() < deadline) await delay(50);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.view().model, 'test-model');
    assert.equal(run.evidence[0].passed, true);
    assert.equal(ollama.requests.filter(item => item.path === '/api/chat').length, 4);
  } finally {
    await app.close();
    await ollama.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const repeatPlain of [false, true]) {
  test(`Ollama gets one completion reminder and ${repeatPlain ? 'stops without invented evidence if it still returns text' : 'can recover to real verification'}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-ollama-reminder-'));
    const ollama = await startOllamaFixture({ plainBeforeVerify: true, repeatPlain });
    const app = await createApp({ dataDirectory: directory, apiKey: '', defaultProvider: 'ollama', ollamaModel: 'test-model', ollamaBaseURL: ollama.baseURL });
    try {
      await app.listen(0);
      const run = app.manager.create({ provider: 'ollama', task: 'Read and verify the project brief' });
      const deadline = Date.now() + 30000;
      while (app.manager.active === run && Date.now() < deadline) await delay(50);
      assert.equal(run.events.filter(event => event.title === 'Requesting verified completion').length, 1);
      assert.equal(run.status, repeatPlain ? 'blocked' : 'completed', run.error);
      if (repeatPlain) assert.equal(run.evidence.length, 0);
      else assert.equal(run.evidence[0].passed, true);
    } finally {
      await app.close();
      await ollama.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
