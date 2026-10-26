import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerBrowser, webURL } from './browser.js';
import { GeminiProvider, PRESETS } from './providers.js';
import { OllamaProvider } from './ollama.js';
import { FileViewer } from './file-viewer.js';
import { assertTextWrite } from './document-formats.js';
import { declarations, validateTool, SYSTEM } from './tools.js';

export class Run {
  constructor(manager, options) {
    this.manager = manager;
    this.id = randomUUID();
    this.task = options.task;
    this.startURL = options.startURL || '';
    this.provider = options.provider;
    this.scenario = options.scenario;
    this.maxTurns = Math.min(manager.config.maxTurns, Math.max(3, Number(options.maxTurns) || manager.config.maxTurns));
    this.status = 'queued';
    this.createdAt = new Date().toISOString();
    this.events = [];
    this.memory = Object.create(null);
    this.evidence = [];
    this.plan = [];
    this.notes = [];
    this.browserRevision = 0;
    this.fileRevision = 0;
    this.turns = 0;
    this.toolCalls = 0;
    this.abort = new AbortController();
    this.directory = path.join(manager.runsDirectory, this.id);
    this.persistChain = Promise.resolve();
    this.fileViewer = new FileViewer(manager.workspace);
  }

  view() {
    return {
      id: this.id, task: this.task, startURL: this.startURL, provider: this.provider,
      status: this.status, createdAt: this.createdAt, completedAt: this.completedAt,
      maxTurns: this.maxTurns, turns: this.turns, toolCalls: this.toolCalls,
      events: this.events, memory: this.memory, plan: this.plan, notes: this.notes,
      evidence: this.evidence, pending: this.pending, observation: this.observation,
      screenshotVersion: this.screenshotVersion, summary: this.summary, error: this.error,
      model: this.provider === 'demo' ? 'scripted demo' : this.provider === 'ollama' ? this.manager.config.ollamaModel : this.manager.config.model
    };
  }

  persist() {
    const data = JSON.stringify(this.view(), null, 2);
    this.persistChain = this.persistChain.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, 'run.json.tmp');
      await fs.writeFile(temporary, data);
      await fs.rename(temporary, path.join(this.directory, 'run.json'));
    }).catch(error => console.error('Could not persist run:', error.message));
    return this.persistChain;
  }

  log(type, title, data) {
    this.events.push({ id: this.events.length + 1, at: new Date().toISOString(), type, title, data });
    this.persist();
  }

  check() {
    this.abort.signal.throwIfAborted();
  }

  async capture() {
    try {
      this.check();
      if (!this.computer?.page || this.computer.page.isClosed()) return;
      await this.computer.page.screenshot({ path: path.join(this.directory, 'screen.png'), timeout: 5000 });
      this.screenshotVersion = Date.now();
      await this.persist();
    } catch {}
  }

  async observe() {
    this.observation = await this.computer.observe();
    await this.capture();
    return this.observation;
  }

  async request(kind, question, details = {}, options = []) {
    this.check();
    this.status = kind === 'approval' ? 'awaiting_approval' : 'awaiting_input';
    const token = randomUUID();
    this.pending = { token, kind, question, details, options };
    this.log(kind, question, details);
    try {
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('Run stopped'));
        this.abort.signal.addEventListener('abort', onAbort, { once: true });
        this.pendingResolve = value => {
          this.abort.signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
      });
    } finally {
      this.pending = undefined;
      this.pendingResolve = undefined;
      if (!this.abort.signal.aborted) this.status = 'running';
      this.persist();
    }
  }

  answer(token, answer) {
    if (!this.pending || token !== this.pending.token || !this.pendingResolve) throw new Error('This request is no longer pending');
    if (this.pending.kind === 'approval' && typeof answer !== 'boolean') throw new Error('Approval must be true or false');
    if (this.pending.kind !== 'approval' && (typeof answer !== 'string' || !answer.trim() || answer.length > 4000)) throw new Error('Provide a short text answer');
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    this.log('user', this.pending.kind === 'approval' ? (answer ? 'Action approved' : 'Action declined') : 'User answered', { answer });
    resolve(answer);
  }

  async approve(title, details) {
    const approved = await this.request('approval', title, details);
    this.check();
    if (!approved) throw new Error('User declined this action. Do not repeat it without new instructions.');
  }

  isDemo() {
    try {
      const url = new URL(this.computer.page.url());
      return url.origin === this.manager.baseURL && url.pathname === '/demo';
    } catch { return false; }
  }

  async execute(name, args) {
    this.check();
    if (++this.toolCalls > this.manager.config.maxToolCalls) throw new Error('Tool-call limit reached');
    this.log('action', name.replaceAll('_', ' '), args);
    try {
      validateTool(name, args);
      let output;
      if (name === 'plan') {
        if (!args.steps.length || args.steps.length > 8) throw new Error('Use between 1 and 8 plan steps');
        this.plan = args.steps;
        output = { steps: this.plan };
      } else if (name === 'remember') {
        if (Object.keys(this.memory).length >= 30 && !(args.key in this.memory)) throw new Error('Task memory is full');
        if (args.key.length > 100 || args.value.length > 2000) throw new Error('Keep memory facts short');
        this.memory[args.key] = args.value;
        output = { memory: this.memory };
      } else if (name === 'ask_user') {
        output = { answer: await this.request('question', args.question, {}, args.options) };
      } else if (name === 'file_list') output = { entries: await this.manager.workspace.list(args.path) };
      else if (name === 'file_read') output = await this.manager.workspace.read(args.path, { signal: this.abort.signal });
      else if (name === 'spreadsheet_read') output = await this.manager.workspace.spreadsheet(args.path, { sheet: args.sheet, range: args.range, signal: this.abort.signal });
      else if (name === 'file_search') output = await this.manager.workspace.search(args.query, args.path, { signal: this.abort.signal });
      else if (name === 'file_open' || name === 'file_open_pdf') {
        if (name === 'file_open_pdf') {
          const actual = await this.fileViewer.inspect(args.path, this.abort.signal);
          if (!/\.pdf$/i.test(args.path) || !/\.pdf$/i.test(actual.filename)) throw new Error('file_open_pdf requires a .pdf file; use file_open for other document types');
        }
        output = await this.fileViewer.open(args.path, this.abort.signal);
      }
      else if (name === 'file_write') {
        assertTextWrite(args.path);
        await this.manager.workspace.resolve(args.path);
        if (Buffer.byteLength(args.content) > 128 * 1024) throw new Error('Content exceeds 128 KB');
        let before;
        try { before = await this.manager.workspace.read(args.path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (before && !args.overwrite) throw new Error('File exists. Inspect it and ask to overwrite or choose a new path.');
        if (before?.content === args.content && !before.truncated) output = { path: args.path, unchanged: true };
        else {
          await this.approve(before ? 'Replace this file?' : 'Create this file?', { ...args, resolvedPath: await this.manager.workspace.resolve(args.path), existingContent: before?.content });
          if (before) {
            const current = await this.manager.workspace.read(args.path);
            if (current.content !== before.content || current.truncated) throw new Error('File changed during review; read it again');
          }
          output = await this.manager.workspace.write(args.path, args.content, args.overwrite);
          this.fileRevision++;
        }
      } else if (name === 'file_move') {
        await this.manager.workspace.resolve(args.source);
        await this.manager.workspace.resolve(args.destination);
        await this.approve('Move this file?', { ...args, resolvedSource: await this.manager.workspace.resolve(args.source), resolvedDestination: await this.manager.workspace.resolve(args.destination) });
        output = await this.manager.workspace.move(args.source, args.destination);
        this.fileRevision++;
      } else if (name === 'verify') output = await this.verify(args);
      else if (name === 'finish') output = await this.finish(args);
      else if (name.startsWith('browser_')) {
        if (!this.computer) throw new Error('Browser is unavailable');
        const interaction = ['browser_click', 'browser_fill', 'browser_select', 'browser_press'].includes(name);
        if (interaction && !this.isDemo()) await this.approve('Allow this browser interaction?', { tool: name, url: this.computer.page.url(), ...args });
        this.check();
        if (name === 'browser_observe') output = await this.observe();
        else if (name === 'browser_screenshot') {
          await this.capture();
          output = { captured: Boolean(this.screenshotVersion), image: `/api/runs/${this.id}/screen` };
        } else {
          this.browserRevision++;
          if (name === 'browser_navigate') await this.computer.navigate(args.url);
          else if (name === 'browser_reload') await this.computer.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          else if (name === 'browser_click') await (await this.computer.target(args.role, args.name)).click();
          else if (name === 'browser_fill') {
            if (!['textbox', 'searchbox', 'spinbutton'].includes(args.role)) throw new Error('Fill supports textbox, searchbox or spinbutton');
            await (await this.computer.target(args.role, args.name)).fill(args.value);
          } else if (name === 'browser_select') await (await this.computer.target('combobox', args.name)).selectOption({ label: args.value });
          else if (name === 'browser_press') await this.computer.page.keyboard.press(args.key);
          else if (name === 'browser_scroll') await this.computer.page.mouse.wheel(0, args.direction === 'down' ? 650 : -650);
          else if (name === 'browser_switch_tab') {
            const pages = this.computer.context.pages();
            if (!pages[args.index]) throw new Error('Tab index is not open');
            this.computer.page = pages[args.index];
          }
          output = { ok: true, observation: await this.observe() };
        }
      } else throw new Error('Tool is not implemented');
      this.check();
      if (output.calculation && !this.notes.includes(output.calculation)) this.notes.push(output.calculation);
      this.log('observation', name === 'verify' ? (output.passed ? 'Verification passed' : 'Verification failed') : 'Tool result', output);
      return output;
    } catch (error) {
      this.check();
      const output = { ok: false, error: error.message };
      this.log('tool_error', 'Action failed; agent can recover', { tool: name, ...output });
      return output;
    }
  }

  async verify({ kind, target, expected }) {
    if (!['file_exists', 'file_opened'].includes(kind) && !expected.trim()) throw new Error('Verification requires a meaningful expected value');
    let actual = '';
    let passed = false;
    const scope = kind.startsWith('file_') ? 'file' : 'browser';
    const check = async () => {
      if (kind === 'browser_table_row') {
        const result = await this.computer.checkTableRow(target, expected);
        actual = result.actual;
        passed = result.passed;
        return;
      }
      if (kind === 'file_opened') {
        const result = await this.fileViewer.verify(target, this.abort.signal);
        actual = result.actual;
        passed = result.passed;
        return;
      }
      if (kind === 'browser_text') actual = await this.computer.page.locator('body').innerText();
      if (kind === 'browser_url') actual = this.computer.page.url();
      if (kind === 'browser_field') actual = await (await this.computer.target('textbox', target)).inputValue();
      if (kind === 'file_contains') actual = (await this.manager.workspace.read(target, { signal: this.abort.signal })).content;
      if (kind === 'file_exists') {
        try { actual = (await fs.stat(await this.manager.workspace.resolve(target))).isFile() ? 'exists' : 'not a file'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; actual = 'missing'; }
      }
      passed = kind === 'file_exists' ? actual === 'exists' : kind === 'browser_field' ? actual === expected : actual.includes(expected);
    };
    for (let attempt = 0; attempt < 10; attempt++) {
      this.check();
      await check();
      if (passed || scope === 'file') break;
      await delay(250, undefined, { signal: this.abort.signal });
    }
    const evidence = {
      id: 'E' + (this.evidence.length + 1), kind, target, expected, passed,
      actual: actual.slice(0, 6000), scope,
      revision: scope === 'file' ? this.fileRevision : this.browserRevision,
      at: new Date().toISOString()
    };
    this.evidence.push(evidence);
    return evidence;
  }

  async finish({ summary, evidence }) {
    if (!summary.trim() || !evidence.length) throw new Error('Provide a summary and passed verification evidence');
    for (const id of evidence) {
      const item = this.evidence.find(entry => entry.id === id);
      const revision = item?.scope === 'file' ? this.fileRevision : this.browserRevision;
      if (!item?.passed || item.revision !== revision) throw new Error('Evidence is failed, missing, or stale: ' + id + '. Verify the final state again.');
      const fresh = await this.verify({ kind: item.kind, target: item.target, expected: item.expected });
      if (!fresh.passed) throw new Error('The final state no longer satisfies ' + id + '. Inspect and verify it again.');
      item.confirmedBy = fresh.id;
    }
    this.summary = summary;
    this.status = 'completed';
    this.completedAt = new Date().toISOString();
    await this.capture();
    return { completed: true, summary, evidence };
  }

  async runDemo() {
    const call = async (name, args = {}) => {
      this.check();
      const result = await this.execute(name, args);
      if (result.ok === false) throw new Error(result.error);
      return result;
    };
    if (this.scenario === 'browser') {
      await call('plan', { steps: ['Inspect the demo task list', 'Create the requested task if missing', 'Verify the saved title and priority'] });
      let result = await call('browser_observe');
      if (!result.structure.includes(PRESETS.browser.title)) {
        await call('browser_fill', { role: 'textbox', name: 'Task title', value: PRESETS.browser.title });
        await call('browser_select', { name: 'Priority', value: 'High' });
        await call('browser_click', { role: 'button', name: 'Add task' });
      }
      await call('remember', { key: 'saved_task', value: PRESETS.browser.title + ' / High priority' });
      const evidence = await call('verify', { kind: 'browser_text', target: '', expected: PRESETS.browser.title + ' — High' });
      await call('finish', { summary: 'Verified “Review release notes” is saved with High priority in the demo task list.', evidence: [evidence.id] });
    } else {
      await call('plan', { steps: ['Read the project brief', 'Prepare a short summary', 'Request approval to save it', 'Read back and verify the saved content'] });
      const brief = await call('file_read', { path: 'notes/project-brief.md' });
      const paragraphs = brief.content.split('\n\n').filter(text => text.trim() && !text.startsWith('#'));
      const summary = '# Project summary\n\n' + paragraphs.slice(0, 2).join('\n\n') + '\n';
      let overwrite = false;
      try { await this.manager.workspace.read(PRESETS.files.path); overwrite = true; } catch {}
      await call('file_write', { path: PRESETS.files.path, content: summary, overwrite });
      const evidence = await call('verify', { kind: 'file_contains', target: PRESETS.files.path, expected: summary.trim() });
      await call('finish', { summary: 'Saved and read back summaries/project-summary.md. This no-key scenario uses a scripted extraction of the brief’s first two paragraphs.', evidence: [evidence.id] });
    }
  }

  async start() {
    this.status = 'running';
    await fs.mkdir(this.directory, { recursive: true });
    this.log('status', this.provider === 'demo' ? 'Scripted demo started — no model calls' : this.provider === 'ollama' ? 'Local Ollama worker started' : 'Gemini worker started', { model: this.view().model });
    const timeout = setTimeout(() => this.abort.abort(new Error('Run time limit reached')), this.manager.config.maxMinutes * 60000);
    timeout.unref();
    try {
      this.computer = await new ComputerBrowser({ headless: this.manager.config.headless }).start();
      await this.computer.context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const ours = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === new URL(this.manager.baseURL).port;
        if (ours && !(url.pathname === '/demo' || url.pathname.startsWith('/demo/') || url.pathname.startsWith('/api/demo/'))) return route.abort();
        return route.continue();
      });
      if (this.startURL) await this.computer.navigate(this.startURL);
      else await this.computer.page.setContent('<html><body><h1>Browser ready</h1><p>No starting website supplied. Use browser_navigate when needed.</p></body></html>');
      this.log('observation', 'Initial environment', { browser: await this.observe(), workspace: await this.manager.workspace.list('.') });
      if (this.provider === 'demo') await this.runDemo();
      else {
        const providerOptions = this.provider === 'ollama' ? {
          provider: this.provider, model: this.manager.config.ollamaModel, baseURL: this.manager.config.ollamaBaseURL,
          timeout: this.manager.config.ollamaTimeout, contextSize: this.manager.config.ollamaContextSize
        } : { provider: this.provider, apiKey: this.manager.config.apiKey, model: this.manager.config.model, onRetry: data => this.log('retry', 'Model busy; retrying with backoff', data) };
        const provider = this.manager.providerFactory ? this.manager.providerFactory(providerOptions) : this.provider === 'ollama' ? new OllamaProvider(providerOptions) : new GeminiProvider(providerOptions);
        const contents = [{ role: 'user', parts: [{ text: JSON.stringify({ task: this.task, browser: this.observation, workspace: await this.manager.workspace.list('.') }) }] }];
        let completionReminders = 0;
        while (this.turns < this.maxTurns && this.status !== 'completed') {
          this.check();
          this.turns++;
          this.log('thinking', 'Choosing the next action', { turn: this.turns });
          const response = await provider.generate(contents, {
            systemInstruction: SYSTEM + '\nFile access: ' + JSON.stringify({
              mode: this.manager.workspace.allowAllFiles ? 'all' : 'workspace',
              defaultDirectory: this.manager.workspace.root,
              homeDirectory: this.manager.workspace.allowAllFiles ? this.manager.workspace.home : undefined
            }) + '\nTask memory: ' + JSON.stringify(this.memory),
            tools: [{ functionDeclarations: declarations }],
            maxOutputTokens: 4096
          }, this.abort.signal);
          const content = response.candidates?.[0]?.content;
          if (!content) throw new Error('Model returned no usable content. Check the selected provider’s model and connection.');
          contents.push(content);
          const calls = response.functionCalls || [];
          if (!calls.length) {
            if (this.provider === 'ollama' && completionReminders < 1 && this.turns < this.maxTurns) {
              completionReminders++;
              this.log('status', 'Requesting verified completion', { reason: 'The local model returned text without a tool call.' });
              contents.push({ role: 'user', parts: [{ text: 'Continue using the available tools. A written promise to verify is not a tool call. Check the requested facts or outcome with verify against actual state, then call finish with current passed evidence IDs. If the tools cannot complete this task, state the specific limitation. Do not invent evidence or claim unverified completion.' }] });
              continue;
            }
            this.status = 'blocked';
            this.summary = response.text || 'The model stopped without verified completion.';
            this.log('blocked', 'Stopped without verified completion', { message: this.summary });
            break;
          }
          const parts = [];
          for (const call of calls) {
            this.check();
            const output = await this.execute(call.name, call.args || {});
            parts.push({ functionResponse: { id: call.id, name: call.name, response: output } });
            if (this.status === 'completed') break;
          }
          contents.push({ role: 'user', parts });
        }
        if (this.status === 'running') throw new Error('Model-turn limit reached before verified completion');
      }
    } catch (error) {
      this.status = this.abort.signal.aborted ? 'stopped' : 'failed';
      this.error = this.abort.signal.aborted ? (this.abort.signal.reason?.message || 'Stopped by user') : error.message;
      this.log('error', this.status === 'stopped' ? 'Run stopped' : 'Run failed', { error: this.error });
    } finally {
      clearTimeout(timeout);
      this.pending = undefined;
      await this.computer?.close().catch(() => {});
      this.completedAt ||= new Date().toISOString();
      await this.persist();
      this.manager.active = undefined;
    }
  }
}

export class RunManager {
  constructor({ workspace, runsDirectory, config, providerFactory }) {
    this.workspace = workspace;
    this.runsDirectory = runsDirectory;
    this.config = config;
    this.providerFactory = providerFactory;
    this.runs = new Map();
  }

  async init() {
    await fs.mkdir(this.runsDirectory, { recursive: true });
    for (const entry of (await fs.readdir(this.runsDirectory)).slice(-100)) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.runsDirectory, entry, 'run.json'), 'utf8'));
        if (!['completed', 'failed', 'stopped', 'blocked'].includes(data.status)) {
          data.status = 'stopped'; data.error = 'Server restarted; start a new run to continue.'; data.pending = undefined;
        }
        this.runs.set(data.id, { view: () => data, directory: path.join(this.runsDirectory, entry) });
      } catch {}
    }
  }

  create(options) {
    if (this.active) throw new Error('A worker is already active. Stop or finish it before starting another.');
    if (typeof options.task !== 'string' || !options.task.trim() || options.task.length > 12000) throw new Error('Enter a task under 12,000 characters');
    if (!['gemini', 'ollama', 'demo'].includes(options.provider)) throw new Error('Choose Ollama, Gemini or scripted demo');
    if (options.startURL) webURL(options.startURL);
    if (options.provider === 'gemini' && !this.config.apiKey) throw new Error('Set GEMINI_API_KEY in .env and restart, or choose a scripted demo');
    if (options.provider === 'demo') {
      if (!PRESETS[options.scenario] || PRESETS[options.scenario].aiOnly || options.task !== PRESETS[options.scenario].task) throw new Error('Scripted demo supports the browser and file samples. Use Ollama or Gemini for the invoice workflow or your own task.');
      options.startURL = this.baseURL + '/demo';
    }
    const run = new Run(this, { ...options, task: options.task.trim() });
    this.runs.set(run.id, run);
    this.active = run;
    run.start().catch(error => {
      run.status = 'failed'; run.error = error.message;
      run.persist(); this.active = undefined;
    });
    return run;
  }

  list() {
    return Array.from(this.runs.values()).map(run => {
      const item = run.view();
      return { id: item.id, task: item.task, status: item.status, createdAt: item.createdAt, provider: item.provider };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
}
