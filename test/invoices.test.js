import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';
import { PRESETS } from '../src/providers.js';
import { ComputerBrowser } from '../src/browser.js';

const record = { company: 'Company X', invoiceNumber: 'CX-1042', invoiceDate: '2026-10-20', amount: '18450.75', currency: 'INR', dueDate: '2026-11-19', source: 'sample-invoices/company-x-1042.pdf' };
const expected = JSON.stringify({ Company: record.company, 'Invoice number': record.invoiceNumber, 'Invoice date': record.invoiceDate, Amount: record.amount, Currency: record.currency, 'Due date': record.dueDate, 'Source file': record.source });

test('invoice register validates, prevents concurrent duplicates and persists across restarts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-invoices-'));
  let app = await createApp({ dataDirectory: directory, apiKey: '', fileAccess: 'workspace' });
  try {
    const base = await app.listen(0);
    const post = input => fetch(base + '/api/demo/invoices', { method: 'POST', body: JSON.stringify(input) });
    for (const invalid of [{ amount: '-1' }, { amount: '0' }, { amount: '12.345' }, { amount: '1e3' }, { currency: '' }, { invoiceNumber: '' }, { dueDate: '2026-02-30' }, { dueDate: '2026-10-19' }]) assert.equal((await post({ ...record, ...invalid })).status, 400);
    const responses = await Promise.all([post(record), post({ ...record, company: ' company x ' })]);
    assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
    const saved = await (await fetch(base + '/api/demo/invoices')).json();
    assert.equal(saved.invoices.length, 1);
    for (const [key, value] of Object.entries(record)) if (key !== 'company') assert.equal(saved.invoices[0][key], value);
    // A disk error cannot create an in-memory success or poison future saves.
    await fs.mkdir(path.join(directory, 'demo.json.tmp'));
    assert.equal((await post({ ...record, invoiceNumber: 'CX-1043' })).status, 400);
    assert.equal((await (await fetch(base + '/api/demo/invoices')).json()).invoices.length, 1);
    await fs.rmdir(path.join(directory, 'demo.json.tmp'));
    assert.equal((await post({ ...record, invoiceNumber: 'CX-1043', amount: '10.5' })).status, 201);
    await app.close();
    app = await createApp({ dataDirectory: directory, apiKey: '', fileAccess: 'workspace' });
    const restarted = await app.listen(0);
    const records = (await (await fetch(restarted + '/api/demo/invoices')).json()).invoices;
    assert.equal(records.length, 2);
    assert.equal(records[1].amount, '10.50');
    assert.equal((await (await fetch(restarted + '/api/demo/tasks')).json()).tasks[0].id, 'welcome');
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('table verification requires all exact values in one visible row and rejects duplicates', async () => {
  const computer = await new ComputerBrowser().start();
  const table = rows => `<table aria-label="Records"><thead><tr><th>ID</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
  try {
    await computer.page.setContent(table('<tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr>'));
    assert.equal((await computer.checkTableRow('Records', '{"ID":"A","Amount":"20"}')).passed, false);
    assert.equal((await computer.checkTableRow('Records', '{"ID":"A","Amount":"10"}')).passed, true);
    await computer.page.setContent(table('<tr><td>A</td><td>10</td></tr><tr><td>A</td><td>10</td></tr>'));
    assert.equal((await computer.checkTableRow('Records', '{"ID":"A","Amount":"10"}')).passed, false);
    await computer.page.setContent(table('<tr hidden><td>A</td><td>10</td></tr>'));
    assert.equal((await computer.checkTableRow('Records', '{"ID":"A","Amount":"10"}')).passed, false);
    await assert.rejects(computer.checkTableRow('Records', '{}'), /between/);
    await assert.rejects(computer.checkTableRow('Records', '{"Missing":"A"}'), /column/);
  } finally { await computer.close(); }
});

test('controller transfers PDF invoice fields through browser tools and verifies after reload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-invoice-agent-'));
  const calls = [
    ['plan', { steps: ['Compare invoice dates and companies', 'Register the latest matching invoice', 'Reload and compare the saved row with the source'] }],
    ['file_read', { path: 'sample-invoices/company-x-1031.txt' }],
    ['file_read', { path: record.source }],
    ['remember', { key: 'invoice', value: JSON.stringify(record) }],
    ...[['Company', record.company], ['Invoice number', record.invoiceNumber], ['Invoice date', record.invoiceDate], ['Amount', record.amount], ['Due date', record.dueDate], ['Source file', record.source]].map(([name, value]) => ['browser_fill', { role: 'textbox', name, value }]),
    ['browser_select', { name: 'Currency', value: record.currency }],
    ['browser_click', { role: 'button', name: 'Save invoice' }],
    ['browser_reload', {}],
    ['verify', { kind: 'file_contains', target: record.source, expected: '18450.75' }],
    ['verify', { kind: 'browser_table_row', target: 'Saved invoices', expected }],
    ['finish', { summary: 'Verified invoice CX-1042, INR 18450.75, due 2026-11-19 in the saved register.', evidence: ['E1', 'E2'] }]
  ];
  let turn = 0;
  const provider = { generate: async contents => {
    if (turn > 0) assert.notEqual(contents.at(-1).parts[0].functionResponse.response.ok, false, JSON.stringify(contents.at(-1)));
    const [name, args] = calls[turn++];
    const call = { name, args, id: 'call-' + turn };
    return { candidates: [{ content: { role: 'model', parts: [{ functionCall: call }] } }], functionCalls: [call] };
  } };
  const app = await createApp({ dataDirectory: directory, apiKey: '', fileAccess: 'workspace', providerFactory: () => provider });
  try {
    const base = await app.listen(0);
    assert.throws(() => app.manager.create({ task: PRESETS.invoice.task, provider: 'demo', scenario: 'invoice' }), /Use Ollama or Gemini/);
    const run = app.manager.create({ task: PRESETS.invoice.task, provider: 'ollama', startURL: base + '/demo#invoices' });
    const deadline = Date.now() + 60000;
    while (app.manager.active && Date.now() < deadline) await delay(50);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.pending, undefined);
    assert.equal(run.evidence.find(item => item.kind === 'browser_table_row').passed, true);
    assert.equal(run.evidence.find(item => item.id === 'E2').confirmedBy, 'E4');
    const saved = (await (await fetch(base + '/api/demo/invoices')).json()).invoices;
    assert.equal(saved.length, 1);
    for (const [key, value] of Object.entries(record)) assert.equal(saved[0][key], value);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
