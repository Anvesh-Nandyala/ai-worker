import { randomUUID } from 'node:crypto';

export class OllamaProvider {
  constructor({ model = 'qwen3.5:4b', baseURL = 'http://127.0.0.1:11434', timeout = 120000, contextSize = 16384 } = {}) {
    const url = new URL(baseURL);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('OLLAMA_BASE_URL must be a local HTTP address, such as http://127.0.0.1:11434');
    }
    if (!model.trim() || model.endsWith(':cloud')) throw new Error('Choose a downloaded local Ollama model, such as qwen3.5:4b');
    this.baseURL = url.origin;
    this.model = model;
    this.timeout = timeout;
    this.contextSize = contextSize;
    this.checked = false;
  }

  async request(endpoint, body, signal, timeout = this.timeout) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(this.baseURL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 404) throw new Error(`Ollama model "${this.model}" is not installed. Run: ollama pull ${this.model}`);
        throw new Error('Ollama request failed: ' + (data.error || `HTTP ${response.status}`));
      }
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Ollama took too long to respond. Try a smaller local model or increase OLLAMA_TIMEOUT_MS.');
      if (error.message === 'fetch failed') throw new Error(`Cannot connect to Ollama at ${this.baseURL}. Start Ollama with: ollama serve`);
      throw error;
    }
  }

  async check(signal) {
    const data = await this.request('/api/show', { model: this.model }, signal, 8000);
    if (data.remote_host || data.remote_model) throw new Error('This Ollama model uses the cloud. Choose a downloaded local model such as qwen3.5:4b.');
    if (!data.capabilities?.includes('tools')) throw new Error(`Ollama model "${this.model}" does not report tool support. Use a tool-capable model, such as qwen3.5:4b, and an up-to-date Ollama installation.`);
    this.checked = true;
    return { ready: true, model: this.model, baseURL: this.baseURL };
  }

  async generate(contents, config, signal) {
    if (!this.checked) await this.check(signal);
    const messages = [{ role: 'system', content: config.systemInstruction }];
    for (const content of contents) {
      if (content.role === 'model') {
        if (!content.ollamaMessage) throw new Error('Missing native Ollama message in task history');
        messages.push(content.ollamaMessage);
      } else {
        const text = (content.parts || []).filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
        if (text) messages.push({ role: 'user', content: text });
        for (const part of content.parts || []) {
          if (part.functionResponse) messages.push({ role: 'tool', tool_name: part.functionResponse.name, content: JSON.stringify(part.functionResponse.response) });
        }
      }
    }
    const tools = (config.tools || []).flatMap(group => group.functionDeclarations || []).map(tool => ({
      type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parametersJsonSchema }
    }));
    const data = await this.request('/api/chat', {
      model: this.model, messages, tools, stream: false, think: false,
      options: { num_ctx: this.contextSize, num_predict: config.maxOutputTokens || 4096 },
      keep_alive: '10m'
    }, signal);
    const message = data.message;
    if (!message || message.role !== 'assistant') throw new Error('Ollama returned no usable assistant message');
    const calls = (message.tool_calls || []).map(call => {
      const name = call.function?.name;
      let args = call.function?.arguments ?? {};
      try { if (typeof args === 'string') args = JSON.parse(args); }
      catch { throw new Error('Ollama returned invalid JSON arguments for tool ' + name); }
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Ollama returned an invalid tool call');
      return { id: call.id || randomUUID(), name, args };
    });
    const parts = calls.map(call => ({ functionCall: call }));
    if (message.content) parts.unshift({ text: message.content });
    // Keep native tool calls and optional thinking fields intact on later turns.
    return { candidates: [{ content: { role: 'model', parts, ollamaMessage: message } }], functionCalls: calls, text: message.content || '' };
  }
}
