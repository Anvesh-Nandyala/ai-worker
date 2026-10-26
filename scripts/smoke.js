import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import { startOllamaFixture } from '../test/helpers/ollama-server.js';
import { workbookFixture, docxFixture } from '../test/helpers/documents.js';
import { pdfFixture } from '../test/helpers/pdf.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-e2e-'));
const app = await createApp({ dataDirectory: directory, apiKey: '', fileAccess: 'workspace' });
let allFilesApp;
let ollamaApp;
let ollama;
let browser;
const errors = [];

try {
  const base = await app.listen(0);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByText('Local runtime connected').waitFor();
  assert.equal(await page.locator('#provider').inputValue(), 'demo');
  await page.getByRole('button', { name: /Process an invoice/ }).click();
  assert.equal(await page.locator('#provider').inputValue(), 'ollama');
  assert.match(await page.locator('#task').inputValue(), /latest invoice from Company X/);
  assert.equal(await page.locator('#start-url').inputValue(), base + '/demo#invoices');
  await page.locator('#provider').selectOption('demo');
  assert.equal(await page.locator('#provider').inputValue(), 'demo');
  console.log('PASS: invoice sample selects real AI mode; scripted mode stays restricted to its supported samples');
  await page.getByRole('button', { name: /Work in a browser/ }).click();
  await page.getByRole('button', { name: /Start task/ }).click();
  await page.locator('#outcome.success').waitFor({ timeout: 45000 });
  assert.match(await page.locator('#outcome').innerText(), /High priority/);
  assert.equal(await page.locator('#browser-image').isVisible(), true);
  const list = await (await fetch(base + '/api/runs')).json();
  const run = await (await fetch(base + '/api/runs/' + list.runs[0].id)).json();
  assert.equal(run.status, 'completed');
  assert.equal(run.evidence[0].passed, true);
  const tasks = await (await fetch(base + '/api/demo/tasks')).json();
  assert.equal(tasks.tasks.filter(task => task.title === 'Review release notes').length, 1);
  console.log('PASS: dashboard → real browser tools → saved task → verification → evidence screenshot');

  if (process.env.QA_SCREENSHOT) await page.screenshot({ path: process.env.QA_SCREENSHOT, fullPage: true });

  await page.getByRole('button', { name: /Work with files/ }).click();
  await page.getByRole('button', { name: /Start task/ }).click();
  await page.getByRole('button', { name: 'Approve action' }).waitFor({ timeout: 30000 });
  await assert.rejects(app.workspace.read('summaries/project-summary.md'), { code: 'ENOENT' });
  await page.getByRole('button', { name: 'Approve action' }).click();
  await page.locator('#outcome.success').waitFor({ timeout: 30000 });
  const summary = await app.workspace.read('summaries/project-summary.md');
  assert.match(summary.content, /Project Orbit/);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: /summaries.*Open folder/ }).click();
  await page.getByRole('button', { name: /project-summary.md.*Read file/ }).click();
  await page.locator('#file-dialog').waitFor();
  assert.match(await page.locator('#file-content').innerText(), /Project Orbit/);
  await page.getByRole('button', { name: 'Close file' }).click();
  console.log('PASS: workspace read → paused write → user approval → saved file → readback');

  for (const [name, buffer, expected] of [['costs.xlsx', workbookFixture(), 'Notebook'], ['brief.docx', docxFixture(), 'Project Cedar'], ['invoice.pdf', pdfFixture([['Company: Cedar', 'Amount due: INR 300.50']]), '300.50']]) {
    await page.locator('#upload-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await page.getByRole('button', { name: new RegExp(name.replace('.', '\\.') + '.*Read file') }).click();
    await page.locator('#file-dialog').waitFor();
    assert.ok((await page.locator('#file-content').innerText()).includes(expected));
    if (name.endsWith('.xlsx')) assert.match(await page.locator('#file-content').innerText(), /not recalculated/);
    assert.deepEqual(await fs.readFile(path.join(app.workspace.root, 'imports', name)), buffer);
    await page.getByRole('button', { name: 'Close file' }).click();
  }
  console.log('PASS: Excel/Word/PDF binary uploads preserve bytes and show extracted previews');

  const badOrigin = await fetch(base + '/api/runs', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const escaped = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('../demo.json'));
  assert.equal(escaped.status, 400);
  console.log('PASS: cross-origin request and workspace traversal rejected');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /AI worker/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log('PASS: narrow-screen layout has no horizontal overflow');

  await page.goto(base + '/demo#invoices');
  await page.getByRole('textbox', { name: 'Company', exact: true }).waitFor();
  assert.equal(await page.getByRole('table', { name: 'Saved invoices' }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  if (process.env.QA_INVOICE_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.QA_INVOICE_MOBILE_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  if (process.env.QA_INVOICE_SCREENSHOT) await page.screenshot({ path: process.env.QA_INVOICE_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log('PASS: invoice register has labeled controls, an accessible saved table and no mobile overflow');

  allFilesApp = await createApp({ dataDirectory: path.join(directory, 'all-data'), apiKey: '', fileAccess: 'all' });
  const allBase = await allFilesApp.listen(0);
  const external = path.join(directory, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'outside.txt'), 'Readable outside the workspace');
  await page.goto(allBase);
  await page.getByText('Local runtime connected').waitFor();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill(external);
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.getByRole('button', { name: /outside\.txt/ }).click();
  await page.locator('#file-dialog').waitFor();
  assert.match(await page.locator('#file-content').innerText(), /Readable outside the workspace/);
  await page.getByRole('button', { name: 'Close file' }).click();
  await page.getByRole('button', { name: '← Parent folder', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('#folder-path').value === expected, directory);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('#folder-path').value === expected, allFilesApp.workspace.root);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  if (process.env.QA_FILES_SCREENSHOT) await page.screenshot({ path: process.env.QA_FILES_SCREENSHOT, fullPage: true });
  console.log('PASS: all-files browser navigation, external file reading, parent/workspace buttons and mobile layout');

  ollama = await startOllamaFixture();
  ollamaApp = await createApp({ dataDirectory: path.join(directory, 'ollama-data'), apiKey: '', defaultProvider: 'ollama', ollamaBaseURL: ollama.baseURL, ollamaModel: 'test-model' });
  await page.goto(await ollamaApp.listen(0));
  await page.getByText('Local runtime connected').waitFor();
  assert.equal(await page.locator('#provider').inputValue(), 'ollama');
  await page.waitForFunction(() => document.querySelector('#ollama-state').textContent.includes('Ollama ready'));
  await page.locator('#task').fill('Read and verify the project brief');
  await page.getByRole('button', { name: /Start task/ }).click();
  await page.locator('#outcome.success').waitFor({ timeout: 30000 });
  assert.match(await page.locator('#outcome').innerText(), /Project Orbit/);
  console.log('PASS: Ollama mode, readiness check and verified task through the native HTTP adapter (local model fixture)');
  assert.deepEqual(errors, []);
  console.log('PASS: no browser JavaScript errors');
} finally {
  await browser?.close();
  await allFilesApp?.close();
  await ollamaApp?.close();
  await ollama?.close();
  await app.close();
  await fs.rm(directory, { recursive: true, force: true });
}
