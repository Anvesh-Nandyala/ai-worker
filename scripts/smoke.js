import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-e2e-'));
const app = await createApp({ dataDirectory: directory, apiKey: '' });
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

  const badOrigin = await fetch(base + '/api/runs', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const escaped = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent('../demo.json'));
  assert.equal(escaped.status, 400);
  console.log('PASS: cross-origin request and workspace traversal rejected');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /AI worker/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  console.log('PASS: narrow-screen layout has no horizontal overflow');
  assert.deepEqual(errors, []);
  console.log('PASS: no browser JavaScript errors');
} finally {
  await browser?.close();
  await app.close();
  await fs.rm(directory, { recursive: true, force: true });
}
