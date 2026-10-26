const $ = selector => document.querySelector(selector);
let config;
let currentRun;
let selectedScenario = 'browser';
let lastEventCount = -1;
let lastPendingToken;
let lastImageVersion;
let folder = '.';
let parentFolder = '.';
let fileLoadVersion = 0;
let pollBusy = false;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 5000);
}

function switchView(name) {
  $('#worker-view').classList.toggle('hidden', name !== 'worker');
  $('#files-view').classList.toggle('hidden', name !== 'files');
  $('#nav-worker').classList.toggle('active', name === 'worker');
  $('#nav-files').classList.toggle('active', name === 'files');
  $('#view-title').textContent = name === 'worker' ? 'AI worker' : 'Files';
  if (name === 'files') loadFiles().catch(error => toast(error.message));
}

function choosePreset(scenario) {
  selectedScenario = scenario;
  if (config.presets[scenario].aiOnly && $('#provider').value === 'demo') {
    $('#provider').value = config.defaultProvider === 'gemini' ? 'gemini' : 'ollama';
    updateMode();
  }
  $('#task').value = config.presets[scenario].task;
  $('#start-url').value = scenario === 'invoice' ? config.demoURL + '#invoices' : scenario === 'browser' || $('#provider').value === 'demo' ? config.demoURL : '';
  switchView('worker');
  $('#task').focus();
}

function updateMode() {
  const provider = $('#provider').value;
  const demo = provider === 'demo';
  $('#mode-note').textContent = demo ? 'Scripted scenario · choose one of the two samples' : provider === 'ollama' ? 'Local Ollama · no API key or cloud quota' : 'Live Gemini · external actions pause for review';
  $('#model-label').textContent = provider === 'ollama' ? 'Local · ' + config.ollamaModel : demo ? 'Scripted demo' : config.model;
  if (provider === 'ollama') checkOllama().catch(error => toast(error.message));
  if (demo && !Object.values(config.presets).some(preset => !preset.aiOnly && preset.task === $('#task').value)) choosePreset(config.presets[selectedScenario]?.aiOnly ? 'browser' : selectedScenario);
}

async function checkOllama() {
  $('#ollama-state').textContent = 'Checking local Ollama…';
  const status = await api('/api/ollama/status');
  $('#ollama-state').textContent = status.ready ? 'Ollama ready · ' + status.model + ' · runs locally on your computer' : status.error;
  if ($('#provider').value === 'ollama') $('#mode-note').textContent = status.ready ? 'Local Ollama ready · ' + status.model : 'Ollama needs setup · open Setup';
  return status;
}

function resetRun() {
  currentRun = undefined;
  lastEventCount = -1;
  lastPendingToken = undefined;
  lastImageVersion = undefined;
  $('#activity').replaceChildren(node('p', 'empty-state muted', 'Start a task to see its activity.'));
  $('#pending-panel').classList.add('hidden');
  $('#outcome').classList.add('hidden');
  $('#download-report').classList.add('hidden');
  $('#stop-run').classList.add('hidden');
  $('#start-run').disabled = false;
  $('#run-status').textContent = 'Ready';
  $('#run-status').className = 'pill';
  $('#tool-count').textContent = '0 actions';
  $('#run-meta').textContent = 'Each action leaves a trail.';
  $('#plan').replaceChildren(node('li', 'muted', 'Waiting for a task.'));
  $('#memory').replaceChildren(node('div', 'muted small', 'Relevant facts stay with this run.'));
  $('#observed-url').textContent = 'No page open';
  $('#structure-view').textContent = 'Page observations will appear here.';
  $('#browser-image').classList.add('hidden');
  $('#screen-empty').classList.remove('hidden');
  $('#browser-state').textContent = 'Idle';
}

function renderEvents(events) {
  if (lastEventCount === events.length) return;
  const container = $('#activity');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  if (lastEventCount < 0) container.replaceChildren();
  for (const event of events.slice(Math.max(0, lastEventCount))) {
    const row = node('div', 'event event-' + event.type);
    const icons = { action: '↗', observation: '◉', status: '◈', thinking: '·', approval: '◇', question: '?', user: '✓', tool_error: '!', retry: '↻', error: '!', blocked: '!' };
    row.append(node('span', 'event-icon', icons[event.type] || '·'));
    const content = node('div', 'event-content');
    const heading = node('div', 'event-heading');
    heading.append(node('strong', '', event.title), node('time', '', new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    content.append(heading);
    if (event.data !== undefined) {
      const details = node('details');
      details.append(node('summary', '', event.type === 'action' ? 'Arguments' : 'Details'));
      details.append(node('pre', '', JSON.stringify(event.data, null, 2)));
      content.append(details);
    }
    row.append(content);
    container.append(row);
  }
  lastEventCount = events.length;
  if (nearBottom || lastEventCount < 5) container.scrollTop = container.scrollHeight;
}

function renderPending(run) {
  const panel = $('#pending-panel');
  if (!run.pending) {
    panel.classList.add('hidden');
    lastPendingToken = undefined;
    return;
  }
  if (lastPendingToken === run.pending.token) return;
  lastPendingToken = run.pending.token;
  panel.replaceChildren();
  panel.classList.remove('hidden');
  panel.append(node('span', 'eyebrow', run.pending.kind === 'approval' ? 'YOUR REVIEW IS NEEDED' : 'A QUESTION FOR YOU'));
  panel.append(node('h2', '', run.pending.question));
  if (Object.keys(run.pending.details || {}).length) panel.append(node('pre', 'review-details', JSON.stringify(run.pending.details, null, 2)));
  const respond = async answer => {
    for (const button of panel.querySelectorAll('button')) button.disabled = true;
    try {
      await api(`/api/runs/${run.id}/respond`, { method: 'POST', body: JSON.stringify({ token: run.pending.token, answer }) });
      lastPendingToken = undefined;
      panel.classList.add('hidden');
      await poll();
    } catch (error) {
      toast(error.message);
      for (const button of panel.querySelectorAll('button')) button.disabled = false;
    }
  };
  const actions = node('div', 'review-actions');
  if (run.pending.kind === 'approval') {
    const decline = node('button', 'button secondary', 'Decline');
    decline.onclick = () => respond(false);
    const approve = node('button', 'button primary', 'Approve action');
    approve.onclick = () => respond(true);
    actions.append(decline, approve);
  } else {
    const input = node('input');
    input.placeholder = 'Your answer…';
    input.setAttribute('aria-label', 'Your answer');
    const submit = node('button', 'button primary', 'Send answer');
    submit.onclick = () => { if (input.value.trim()) respond(input.value.trim()); };
    input.onkeydown = event => { if (event.key === 'Enter') submit.click(); };
    actions.append(input, submit);
    for (const option of run.pending.options || []) {
      const button = node('button', 'button secondary', option);
      button.onclick = () => respond(option);
      actions.append(button);
    }
  }
  panel.append(actions);
}

function renderRun(run) {
  const active = ['queued', 'running', 'awaiting_input', 'awaiting_approval'].includes(run.status);
  $('#start-run').disabled = active;
  $('#stop-run').classList.toggle('hidden', !active);
  $('#run-status').textContent = run.status.replaceAll('_', ' ');
  $('#run-status').className = 'pill status-' + run.status;
  $('#run-meta').textContent = (run.provider === 'demo' ? 'Scripted demo' : run.model) + ' · ' + run.turns + '/' + run.maxTurns + ' model turns';
  $('#tool-count').textContent = run.toolCalls + ' tool calls';
  $('#download-report').href = `/api/runs/${run.id}/report`;
  $('#download-report').classList.remove('hidden');
  $('#browser-state').textContent = active ? 'Active session' : 'Last observation';
  if (run.observation) {
    $('#observed-url').textContent = run.observation.url;
    $('#structure-view').textContent = run.observation.structure;
  }
  if (run.screenshotVersion && run.screenshotVersion !== lastImageVersion) {
    $('#browser-image').src = `/api/runs/${run.id}/screen?v=${run.screenshotVersion}`;
    $('#browser-image').classList.remove('hidden');
    $('#screen-empty').classList.add('hidden');
    lastImageVersion = run.screenshotVersion;
  }
  $('#plan').replaceChildren(...(run.plan.length ? run.plan.map(step => node('li', '', step)) : [node('li', 'muted', 'The worker will create a plan.')]));
  $('#memory').replaceChildren();
  for (const [key, value] of Object.entries(run.memory)) {
    const item = node('div');
    item.append(node('dt', '', key.replaceAll('_', ' ')), node('dd', '', value));
    $('#memory').append(item);
  }
  if (!Object.keys(run.memory).length) $('#memory').append(node('div', 'small muted', 'No facts recorded yet.'));
  renderEvents(run.events);
  renderPending(run);
  const outcome = $('#outcome');
  outcome.classList.toggle('hidden', active);
  if (!active) {
    outcome.className = 'card outcome ' + (run.status === 'completed' ? 'success' : 'incomplete');
    outcome.replaceChildren(node('span', 'eyebrow', run.status === 'completed' ? 'COMPLETED WITH CHECKED EVIDENCE' : 'RUN ' + run.status.toUpperCase()));
    outcome.append(node('h2', '', run.status === 'completed' ? 'The work is ready.' : 'The task needs attention.'));
    outcome.append(node('p', '', run.error || run.summary || 'No completion summary available.'));
    for (const note of run.notes || []) outcome.append(node('p', 'small muted', note));
    for (const item of run.evidence || []) {
      const evidence = node('details', 'evidence-item');
      evidence.append(node('summary', '', `${item.passed ? '✓' : '!'} ${item.id} · ${item.kind.replaceAll('_', ' ')} ${item.target}`));
      evidence.append(node('pre', '', JSON.stringify(item, null, 2)));
      outcome.append(evidence);
    }
  }
}

async function selectRun(id) {
  resetRun();
  currentRun = id;
  const run = await api('/api/runs/' + id);
  $('#task').value = run.task;
  $('#start-url').value = run.startURL;
  $('#provider').value = run.provider;
  updateMode();
  renderRun(run);
  switchView('worker');
}

async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const data = await api('/api/runs');
    const history = $('#history');
    history.replaceChildren();
    if (!data.runs.length) history.append(node('p', 'muted small', 'Your runs will appear here.'));
    for (const run of data.runs) {
      const button = node('button', 'history-item' + (run.id === currentRun ? ' selected' : ''));
      button.append(node('span', 'history-dot status-' + run.status), node('span', '', run.task));
      button.title = run.task;
      button.onclick = () => selectRun(run.id).catch(error => toast(error.message));
      history.append(button);
    }
    if (currentRun) renderRun(await api('/api/runs/' + currentRun));
    else $('#start-run').disabled = Boolean(data.active);
  } catch (error) {
    $('#connection').textContent = 'Disconnected';
    $('#connection').classList.add('offline');
  } finally { pollBusy = false; }
}

async function loadFiles(requested = folder) {
  const version = ++fileLoadVersion;
  const inputAtStart = $('#folder-path').value;
  const data = await api('/api/workspace?path=' + encodeURIComponent(requested));
  if (version !== fileLoadVersion) return;
  folder = data.path;
  parentFolder = data.parent;
  $('#folder-label').textContent = config.fileAccess === 'all' ? 'Folder: ' + folder : 'Workspace / ' + (folder === '.' ? '' : folder);
  if ($('#folder-path').value === inputAtStart) $('#folder-path').value = folder;
  $('#parent-folder').classList.toggle('hidden', parentFolder === folder);
  const list = $('#file-list');
  list.replaceChildren();
  for (const file of data.entries) {
    const button = node('button', 'file-row');
    button.append(node('span', 'file-icon', file.type === 'directory' ? '▰' : '▤'), node('span', '', file.name), node('span', 'muted', file.type === 'directory' ? 'Open folder →' : 'Read file ↗'));
    button.onclick = async () => {
      try {
        if (file.type === 'directory') await loadFiles(file.path);
        else {
          const data = await api('/api/workspace/file?path=' + encodeURIComponent(file.path));
          $('#file-title').textContent = data.path;
          $('#file-content').textContent = (data.calculation ? data.calculation + '\n\n' : '') + (data.warnings?.length ? data.warnings.join('\n') + '\n\n' : '') + data.content + (data.truncated ? '\n\n[Preview truncated. Supply a smaller document or request a smaller spreadsheet range.]' : '');
          $('#file-dialog').showModal();
        }
      } catch (error) { toast(error.message); }
    };
    list.append(button);
  }
}

async function init() {
  config = await api('/api/config');
  $('#connection').textContent = 'Local runtime connected';
  $('#model-label').textContent = config.model;
  $('#provider').value = config.defaultProvider || (config.hasApiKey ? 'gemini' : 'demo');
  const allFiles = config.fileAccess === 'all';
  $('#workspace-path').textContent = (allFiles ? 'All files enabled · Default workspace: ' : '') + config.workspace;
  $('#folder-form').classList.toggle('hidden', !allFiles);
  $('#file-access-note').textContent = allFiles ? 'File access: all locations allowed by your OS account. File changes and external browser interactions pause for review.' : 'Files stay inside the workspace folder. External browser interactions and file changes pause for your review.';
  $('#setup-state').textContent = config.hasApiKey ? 'Optional Gemini connection: API key configured · ' + config.model : 'Optional Gemini connection: no API key configured. Ollama and scripted demos do not need one.';
  $('#provider').onchange = updateMode;
  $('#example-browser').onclick = () => choosePreset('browser');
  $('#example-files').onclick = () => choosePreset('files');
  $('#example-invoice').onclick = () => choosePreset('invoice');
  $('#nav-worker').onclick = () => switchView('worker');
  $('#nav-files').onclick = () => switchView('files');
  $('#new-run').onclick = () => { resetRun(); switchView('worker'); $('#task').value = ''; $('#task').focus(); };
  $('#task-form').onsubmit = async event => {
    event.preventDefault();
    $('#start-run').disabled = true;
    try {
      const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ task: $('#task').value, startURL: $('#start-url').value, provider: $('#provider').value, scenario: selectedScenario }) });
      await selectRun(run.id);
      await poll();
    } catch (error) { toast(error.message); $('#start-run').disabled = false; }
  };
  $('#stop-run').onclick = async () => {
    try { await api(`/api/runs/${currentRun}/stop`, { method: 'POST', body: '{}' }); await poll(); }
    catch (error) { toast(error.message); }
  };
  $('#setup-open').onclick = () => $('#setup-dialog').showModal();
  $('#ollama-check').onclick = () => checkOllama().catch(error => toast(error.message));
  $('#setup-close').onclick = () => $('#setup-dialog').close();
  $('#file-close').onclick = () => $('#file-dialog').close();
  $('#parent-folder').onclick = () => loadFiles(parentFolder).catch(error => toast(error.message));
  $('#folder-form').onsubmit = event => {
    event.preventDefault();
    loadFiles($('#folder-path').value.trim() || '.').catch(error => toast(error.message));
  };
  $('#home-folder').onclick = () => loadFiles(config.homeDirectory).catch(error => toast(error.message));
  $('#workspace-folder').onclick = () => loadFiles('.').catch(error => toast(error.message));
  $('#upload-button').onclick = () => $('#upload-file').click();
  $('#upload-file').onchange = async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const office = /\.(pdf|docx?|xlsx?|ods|odt|rtf|pptx?|odp)$/i.test(file.name);
      let upload;
      if (office) {
        if (file.size > 16 * 1024 * 1024) throw new Error('Upload a document no larger than 16 MB');
        const dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read the selected file'));
          reader.readAsDataURL(file);
        });
        upload = { filename: file.name, encoding: 'base64', data: dataURL.slice(dataURL.indexOf(',') + 1) };
      } else {
        if (file.size > 128 * 1024) throw new Error('Upload a text file under 128 KB');
        upload = { filename: file.name, content: await file.text() };
      }
      await api('/api/workspace/upload', { method: 'POST', body: JSON.stringify(upload) });
      await loadFiles('imports');
      toast('File added to imports/');
    } catch (error) { toast(error.message); }
    event.target.value = '';
  };
  const setTab = structure => {
    $('#show-screen').classList.toggle('selected', !structure);
    $('#show-structure').classList.toggle('selected', structure);
    $('#show-screen').setAttribute('aria-selected', String(!structure));
    $('#show-structure').setAttribute('aria-selected', String(structure));
    $('#screen-view').classList.toggle('hidden', structure);
    $('#structure-view').classList.toggle('hidden', !structure);
  };
  $('#show-screen').onclick = () => setTab(false);
  $('#show-structure').onclick = () => setTab(true);
  updateMode();
  const initial = await api('/api/runs');
  if (initial.active) await selectRun(initial.active);
  await poll();
  setInterval(poll, 1000);
}

init().catch(error => toast(error.message));
