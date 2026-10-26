import http from 'node:http';

// A local HTTP fixture, not an AI model. Exercises the real Ollama adapter.
export async function startOllamaFixture({ plainBeforeVerify = false, repeatPlain = false } = {}) {
  const requests = [];
  let reminded = false;
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    requests.push({ path: request.url, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/show') return response.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
    if (request.url !== '/api/chat') { response.statusCode = 404; return response.end('{}'); }
    const previous = body.messages.filter(item => item.role === 'tool');
    if (previous.length === 2 && plainBeforeVerify && (!reminded || repeatPlain)) {
      reminded = true;
      return response.end(JSON.stringify({ message: { role: 'assistant', content: 'I have read the file. I will verify it next.' }, done: true }));
    }
    const calls = [
      { name: 'plan', arguments: { steps: ['Read the brief', 'Verify the project name'] } },
      { name: 'file_read', arguments: { path: 'notes/project-brief.md' } },
      { name: 'verify', arguments: { kind: 'file_contains', target: 'notes/project-brief.md', expected: 'Project Orbit' } },
      { name: 'finish', arguments: { summary: 'Verified Project Orbit in the brief using local Ollama tools.', evidence: [previous.at(-1)?.tool_name === 'verify' ? JSON.parse(previous.at(-1).content).id : 'E1'] } }
    ];
    const call = calls[previous.length];
    response.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: call ? [{ function: call }] : [] }, done: true }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseURL: 'http://127.0.0.1:' + server.address().port, requests,
    close: async () => { server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve)); }
  };
}
