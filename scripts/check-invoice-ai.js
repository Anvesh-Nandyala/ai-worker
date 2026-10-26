// Opt-in acceptance check with a real local model. Nothing is scripted into the
// provider: it receives the same task, observations and tools as the dashboard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { PRESETS } from '../src/providers.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-invoice-ai-'));
const app = await createApp({ dataDirectory: directory, apiKey: '', defaultProvider: 'ollama', fileAccess: 'workspace', headless: true });
let run;
try {
  const base = await app.listen(0);
  run = app.manager.create({ provider: 'ollama', task: PRESETS.invoice.task, startURL: base + '/demo#invoices' });
  let seen = 0;
  while (app.manager.active) {
    for (const event of run.events.slice(seen)) {
      if (['action', 'tool_error', 'blocked', 'error'].includes(event.type)) console.log(event.type + ': ' + event.title + ' ' + JSON.stringify(event.data));
    }
    seen = run.events.length;
    if (run.pending) {
      run.abort.abort(new Error('Acceptance check needs user input: ' + run.pending.question));
    }
    await delay(500);
  }
  console.log(JSON.stringify({ status: run.status, turns: run.turns, toolCalls: run.toolCalls, summary: run.summary, error: run.error }));
  assert.equal(run.status, 'completed', run.error || run.summary);
  const { invoices } = await (await fetch(base + '/api/demo/invoices')).json();
  assert.equal(invoices.length, 1);
  const expected = { company: 'Company X', invoiceNumber: 'CX-1042', invoiceDate: '2026-10-20', amount: '18450.75', currency: 'INR', dueDate: '2026-11-19', source: 'sample-invoices/company-x-1042.pdf' };
  for (const [key, value] of Object.entries(expected)) assert.equal(invoices[0][key], value, key);
  const evidence = run.evidence.find(item => item.kind === 'browser_table_row' && item.passed && item.confirmedBy);
  assert.ok(evidence, 'Completion must cite the saved table row');
  const values = JSON.parse(evidence.expected);
  for (const [column, key] of Object.entries({ Company: 'company', 'Invoice number': 'invoiceNumber', 'Invoice date': 'invoiceDate', Amount: 'amount', Currency: 'currency', 'Due date': 'dueDate', 'Source file': 'source' })) assert.equal(values[column], expected[key], column);
  assert.ok(run.events.some(event => event.type === 'action' && event.title === 'file read' && event.data.path === expected.source));
  const fixture = await fs.readFile(new URL('../fixtures/invoices/company-x-1042.pdf', import.meta.url));
  assert.deepEqual(await fs.readFile(path.join(app.workspace.root, expected.source)), fixture);
  console.log('PASS: real Ollama selected the latest Company X invoice, read its PDF, saved all fields and verified the persisted row; source bytes unchanged.');
} finally {
  if (run && process.env.RELAY_LIVE_REPORT) await fs.writeFile(process.env.RELAY_LIVE_REPORT, JSON.stringify(run.view(), null, 2));
  await app.close();
  await fs.rm(directory, { recursive: true, force: true });
}
