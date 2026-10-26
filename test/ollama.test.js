import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/ollama.js';
import { declarations } from '../src/tools.js';

const config = { systemInstruction: 'Use the tools to complete the task.', tools: [{ functionDeclarations: declarations }], maxOutputTokens: 4096 };
const initial = [{ role: 'user', parts: [{ text: 'Read the brief.' }] }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('Ollama maps tools and replays native assistant messages and tool results', async t => {
  const requests = [];
  const native = { role: 'assistant', content: '', thinking: 'test metadata', tool_calls: [{ function: { index: 0, name: 'file_read', arguments: { path: 'notes/project-brief.md' } } }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith('/api/show')) return json({ capabilities: ['completion', 'tools'] });
    return json({ message: native, done: true });
  });
  const provider = new OllamaProvider({ model: 'test-model' });
  const first = await provider.generate(initial, config, new AbortController().signal);
  assert.equal(first.functionCalls[0].name, 'file_read');
  assert.deepEqual(first.functionCalls[0].args, { path: 'notes/project-brief.md' });
  assert.ok(first.functionCalls[0].id);
  const history = [...initial, first.candidates[0].content, { role: 'user', parts: [{ functionResponse: { id: first.functionCalls[0].id, name: 'file_read', response: { content: 'Project Orbit' } } }] }];
  await provider.generate(history, config, new AbortController().signal);
  assert.equal(requests.filter(item => item.url.endsWith('/api/show')).length, 1);
  const last = requests.at(-1).body;
  assert.deepEqual(last.messages[2], native);
  assert.deepEqual(last.messages[3], { role: 'tool', tool_name: 'file_read', content: '{"content":"Project Orbit"}' });
  assert.deepEqual(last.tools[0].function.parameters, declarations[0].parametersJsonSchema);
  assert.equal(last.stream, false);
  assert.equal(last.think, false);
  assert.equal(last.options.num_ctx, 16384);
  assert.equal(last.options.num_predict, 4096);
});

test('Ollama rejects malformed tool arguments instead of executing them', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/api/show') ? json({ capabilities: ['tools'] }) : json({ message: { role: 'assistant', tool_calls: [{ function: { name: 'file_read', arguments: '{broken' } }] } }));
  await assert.rejects(new OllamaProvider().generate(initial, config, new AbortController().signal), /invalid JSON arguments/);
});

test('Ollama accepts a parameterless tool call with omitted arguments', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/api/show') ? json({ capabilities: ['tools'] }) : json({ message: { role: 'assistant', tool_calls: [{ function: { name: 'browser_observe' } }] } }));
  const response = await new OllamaProvider().generate(initial, config, new AbortController().signal);
  assert.deepEqual(response.functionCalls[0].args, {});
});

test('local Ollama mode rejects remote endpoints and cloud models', () => {
  assert.throws(() => new OllamaProvider({ baseURL: 'https://example.com' }), /local HTTP/);
  assert.throws(() => new OllamaProvider({ baseURL: 'http://localhost:11434/api' }), /local HTTP/);
  assert.throws(() => new OllamaProvider({ model: 'some-model:cloud' }), /downloaded local/);
});

test('Ollama explains missing models, missing tool support and connection failures', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => json({ error: 'not found' }, 404));
  await assert.rejects(new OllamaProvider().check(), /ollama pull qwen3.5:4b/);
  mock.mock.mockImplementation(async () => json({ capabilities: ['completion'] }));
  await assert.rejects(new OllamaProvider().check(), /does not report tool support/);
  mock.mock.mockImplementation(async () => json({ capabilities: ['tools'], remote_host: 'https://ollama.com' }));
  await assert.rejects(new OllamaProvider().check(), /uses the cloud/);
  mock.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(new OllamaProvider().check(), /ollama serve/);
  mock.mock.mockImplementation(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(new OllamaProvider().check(), /OLLAMA_TIMEOUT_MS/);
});

test('stopping an Ollama task aborts the in-flight local request', async t => {
  const controller = new AbortController();
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const pending = new OllamaProvider().generate(initial, config, controller.signal);
  await waiting;
  controller.abort(new Error('Stopped by user'));
  await assert.rejects(pending, /Stopped by user/);
});
