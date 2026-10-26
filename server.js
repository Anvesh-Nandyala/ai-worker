import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Workspace } from './src/files.js';
import { RunManager } from './src/agent.js';
import { PRESETS } from './src/providers.js';
import { OllamaProvider } from './src/ollama.js';
import { MAX_DOCUMENT_BYTES } from './src/document-formats.js';
import { invoiceRecord, sameInvoice } from './src/demo-invoices.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/demo': ['demo.html', 'text/html'],
  '/demo/demo.js': ['demo.js', 'text/javascript'],
  '/demo/demo.css': ['demo.css', 'text/css']
};

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function body(request, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body exceeds the allowed size');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function createApp(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory || process.env.DATA_DIR || path.join(root, 'data'));
  const fileAccess = options.fileAccess ?? process.env.FILE_ACCESS ?? 'workspace';
  if (!['workspace', 'all'].includes(fileAccess)) throw new Error('FILE_ACCESS must be workspace or all');
  const workspace = new Workspace(path.join(dataDirectory, 'workspace'), { allowAllFiles: fileAccess === 'all' });
  await workspace.init();
  // Seed only bundled practice inputs; never replace the user's files.
  const samples = path.join(root, 'fixtures', 'invoices');
  for (const filename of await fs.readdir(samples)) {
    const destination = await workspace.resolve('sample-invoices/' + filename, { createParents: true });
    try { await fs.copyFile(path.join(samples, filename), destination, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const [filename, content] of Object.entries({
    'notes/project-brief.md': '# Project Orbit\n\nProject Orbit is a student-built collaboration tool for small engineering teams. Its first release brings tasks, project notes, and a searchable resource catalog into one workspace.\n\nThe first milestone is a usable local prototype with clear activity history and reliable saving. The team will validate it with three classmates before adding account sharing.\n\n## Next steps\n- Review release notes\n- Test the task form\n- Collect feedback\n',
    'notes/meeting-notes.md': '# Planning meeting\n\nOwner: Anvesh\nDecision: focus on browser tools and scoped file tools first.\nOpen question: should task notifications be daily or weekly?\n',
    'resources/catalog.csv': 'name,category,price\nNotebook,Office,80\nDesk lamp,Office,950\nKeyboard,Electronics,1800\n'
  })) {
    try { await workspace.write(filename, content, false); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const config = {
    apiKey: options.apiKey ?? process.env.GEMINI_API_KEY ?? '',
    model: options.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    ollamaModel: options.ollamaModel || process.env.OLLAMA_MODEL || 'qwen3.5:4b',
    ollamaBaseURL: options.ollamaBaseURL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaTimeout: Math.max(1000, Math.min(300000, Number(process.env.OLLAMA_TIMEOUT_MS) || 120000)),
    ollamaContextSize: Math.max(4096, Math.min(131072, Number(process.env.OLLAMA_CONTEXT_SIZE) || 16384)),
    headless: options.headless ?? process.env.HEADLESS !== 'false',
    maxTurns: Math.max(3, Math.min(40, Number(process.env.MAX_MODEL_TURNS) || 32)),
    maxToolCalls: Math.max(5, Math.min(100, Number(process.env.MAX_TOOL_CALLS) || 45)),
    maxMinutes: Math.max(1, Math.min(30, Number(process.env.MAX_RUN_MINUTES) || 10))
  };
  config.defaultProvider = options.defaultProvider ?? process.env.AI_PROVIDER ?? (config.apiKey ? 'gemini' : 'demo');
  if (!['gemini', 'ollama', 'demo'].includes(config.defaultProvider)) throw new Error('AI_PROVIDER must be ollama, gemini or demo');
  new OllamaProvider({ model: config.ollamaModel, baseURL: config.ollamaBaseURL });
  const manager = new RunManager({ workspace, runsDirectory: path.join(dataDirectory, 'runs'), config, providerFactory: options.providerFactory });
  await manager.init();
  let demo = { tasks: [{ id: 'welcome', title: 'Explore the practice workspace', priority: 'Medium' }] };
  const demoPath = path.join(dataDirectory, 'demo.json');
  try { demo = JSON.parse(await fs.readFile(demoPath, 'utf8')); } catch {}
  demo.invoices ||= [];
  let saveDemo = Promise.resolve();
  const updateDemo = change => {
    const operation = saveDemo.then(async () => {
      const next = structuredClone(demo);
      const result = change(next);
      await fs.writeFile(demoPath + '.tmp', JSON.stringify(next, null, 2));
      await fs.rename(demoPath + '.tmp', demoPath);
      demo = next;
      return result;
    });
    saveDemo = operation.catch(() => {});
    return operation;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      const hosts = ['127.0.0.1:' + address.port, 'localhost:' + address.port];
      if (!hosts.includes(request.headers.host)) return json(response, 403, { error: 'Use the local dashboard address' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: 'Cross-site requests are not allowed' });
      if (request.headers.origin && !hosts.map(host => 'http://' + host).includes(request.headers.origin)) return json(response, 403, { error: 'Cross-origin requests are not allowed' });
      const url = new URL(request.url, manager.baseURL);
      const method = request.method;
      if (method === 'GET' && staticFiles[url.pathname]) {
        const [filename, type] = staticFiles[url.pathname];
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
        return response.end(await fs.readFile(path.join(root, 'public', filename)));
      }
      if (method === 'GET' && url.pathname === '/api/config') return json(response, 200, {
        hasApiKey: Boolean(config.apiKey), model: config.model, maxTurns: config.maxTurns,
        workspace: workspace.root, fileAccess, homeDirectory: workspace.allowAllFiles ? workspace.home : undefined,
        defaultProvider: config.defaultProvider, ollamaModel: config.ollamaModel,
        demoURL: manager.baseURL + '/demo', presets: PRESETS
      });
      if (method === 'GET' && url.pathname === '/api/ollama/status') {
        try { return json(response, 200, await new OllamaProvider({ model: config.ollamaModel, baseURL: config.ollamaBaseURL }).check()); }
        catch (error) { return json(response, 200, { ready: false, model: config.ollamaModel, error: error.message }); }
      }
      if (method === 'GET' && url.pathname === '/api/runs') return json(response, 200, { runs: manager.list(), active: manager.active?.id });
      if (method === 'POST' && url.pathname === '/api/runs') {
        const run = manager.create(await body(request));
        return json(response, 201, run.view());
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(respond|stop|screen|report))?$/);
      if (runMatch) {
        const run = manager.runs.get(runMatch[1]);
        if (!run) return json(response, 404, { error: 'Run not found' });
        const action = runMatch[2];
        if (method === 'GET' && !action) return json(response, 200, run.view());
        if (method === 'GET' && action === 'report') {
          response.setHeader('Content-Disposition', `attachment; filename="relay-run-${runMatch[1]}.json"`);
          return json(response, 200, run.view());
        }
        if (method === 'GET' && action === 'screen') {
          try {
            const image = await fs.readFile(path.join(run.directory, 'screen.png'));
            response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            return response.end(image);
          } catch { return json(response, 404, { error: 'No screenshot available yet' }); }
        }
        if (method === 'POST' && action === 'respond') {
          if (!run.answer) throw new Error('This run has ended');
          const input = await body(request);
          run.answer(input.token, input.answer);
          return json(response, 200, { accepted: true });
        }
        if (method === 'POST' && action === 'stop') {
          run.abort?.abort(new Error('Stopped by user'));
          return json(response, 200, { stopped: true });
        }
      }
      if (method === 'GET' && url.pathname === '/api/workspace') {
        const requested = url.searchParams.get('path') || '.';
        const folder = workspace.allowAllFiles ? await workspace.resolve(requested) : requested;
        return json(response, 200, { entries: await workspace.list(folder), path: folder, parent: workspace.allowAllFiles ? path.dirname(folder) : path.posix.dirname(folder) });
      }
      if (method === 'GET' && url.pathname === '/api/workspace/file') return json(response, 200, await workspace.read(url.searchParams.get('path') || ''));
      if (method === 'POST' && url.pathname === '/api/workspace/upload') {
        const input = await body(request, Math.ceil(MAX_DOCUMENT_BYTES * 4 / 3) + 4096);
        if (typeof input.filename !== 'string' || !input.filename || input.filename !== path.basename(input.filename) || input.filename.includes('\\')) throw new Error('Use a simple filename');
        if (input.encoding === 'base64') {
          if (typeof input.data !== 'string' || input.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Upload valid base64 document data');
          const bytes = Buffer.from(input.data, 'base64');
          if (bytes.toString('base64') !== input.data) throw new Error('Upload valid base64 document data');
          return json(response, 201, await workspace.importDocument(input.filename, bytes));
        }
        if (typeof input.content !== 'string' || input.content.includes('\0')) throw new Error('Upload a UTF-8 text file');
        return json(response, 201, await workspace.write('imports/' + input.filename, input.content, false));
      }
      if (method === 'GET' && url.pathname === '/api/demo/tasks') return json(response, 200, demo);
      if (method === 'POST' && url.pathname === '/api/demo/tasks') {
        const input = await body(request);
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 180 || !['Low', 'Medium', 'High'].includes(input.priority)) throw new Error('Enter a title and valid priority');
        const task = await updateDemo(next => {
          if (next.tasks.some(task => task.title === input.title.trim())) throw Object.assign(new Error('A task with this title already exists'), { status: 409 });
          const task = { id: randomUUID(), title: input.title.trim(), priority: input.priority };
          next.tasks.push(task);
          return task;
        });
        return json(response, 201, task);
      }
      if (method === 'GET' && url.pathname === '/api/demo/invoices') return json(response, 200, { invoices: demo.invoices });
      if (method === 'POST' && url.pathname === '/api/demo/invoices') {
        const record = invoiceRecord(await body(request));
        const saved = await updateDemo(next => {
          if (next.invoices.some(item => sameInvoice(item, record))) throw Object.assign(new Error('This company and invoice number already exist. Check the saved record before retrying.'), { status: 409 });
          const saved = { id: randomUUID(), ...record, createdAt: new Date().toISOString() };
          next.invoices.push(saved);
          return saved;
        });
        return json(response, 201, saved);
      }
      return json(response, 404, { error: 'Route not found' });
    } catch (error) {
      if (!response.headersSent) json(response, error.status === 409 ? 409 : 400, { error: error.message });
      else response.end();
    }
  });
  const close = async () => {
    const active = manager.active;
    active?.abort.abort(new Error('Server shutting down'));
    await active?.computer?.close().catch(() => {});
    await active?.persist();
    server.closeIdleConnections?.();
    await new Promise(resolve => server.close(resolve));
  };
  const listen = async (port = Number(process.env.PORT) || 3000) => {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    manager.baseURL = 'http://127.0.0.1:' + server.address().port;
    return manager.baseURL;
  };
  return { server, manager, workspace, listen, close, dataDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  const address = await app.listen();
  console.log(`\nRelay AI Worker → ${address}\nWorkspace → ${app.workspace.root}\nFile access → ${app.workspace.allowAllFiles ? 'all files allowed by your OS account' : 'workspace only'}\nGemini → ${app.manager.config.apiKey ? app.manager.config.model : 'no key configured; scripted demos are available'}\n`);
  console.log(`Default mode → ${app.manager.config.defaultProvider}\nOllama → ${app.manager.config.ollamaModel} at ${app.manager.config.ollamaBaseURL}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
