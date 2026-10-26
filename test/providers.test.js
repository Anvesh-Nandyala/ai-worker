import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/providers.js';

const contents = [{ role: 'user', parts: [{ text: 'Test request' }] }];

// Exercise the real SDK's error parsing. A fake models.generateContent method
// misses the SDK retry wrapper that used to discard the HTTP status and body.
for (const [status, apiStatus, message, expected] of [
  [429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for this project.', /quota or rate limit reached.*Quota exceeded/s],
  [403, 'PERMISSION_DENIED', 'Project access denied.', /credentials or project access.*Project access denied/s],
  [404, 'NOT_FOUND', 'Model not found.', /GEMINI_MODEL.*Model not found/s]
]) {
  test(`SDK preserves HTTP ${status} details and does not retry it`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: status, status: apiStatus, message } }), {
        status, headers: { 'Content-Type': 'application/json' }
      });
    });
    const provider = new GeminiProvider({ apiKey: 'test-not-real', model: 'test-model' });
    await assert.rejects(provider.generate(contents, {}, new AbortController().signal), expected);
    assert.equal(calls, 1);
  });
}

test('SDK preserves a 503 so the provider can retry and recover', async t => {
  let calls = 0;
  const retries = [];
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) {
      return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Model is busy.' } }), { status: 503 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered' }] } }] }), { status: 200 });
  });
  const provider = new GeminiProvider({ apiKey: 'test-not-real', model: 'test-model', onRetry: data => retries.push(data) });
  const response = await provider.generate(contents, {}, new AbortController().signal);
  assert.equal(response.text, 'Recovered');
  assert.equal(calls, 2);
  assert.equal(retries[0].status, 503);
});

test('connection and timeout failures give actionable messages', async t => {
  const provider = new GeminiProvider({ apiKey: 'test-not-real', model: 'test-model' });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(provider.generate(contents, {}, new AbortController().signal), /internet connection, proxy, or firewall/);
  fetchMock.mock.mockImplementation(async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(provider.generate(contents, {}, new AbortController().signal), /timed out/);
});
