import { chromium } from 'playwright';

export function webURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials');
  }
  return url.href;
}

export class ComputerBrowser {
  constructor({ headless = true } = {}) {
    this.headless = headless;
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: false });
    this.page = await this.context.newPage();
    this.context.on('page', page => {
      this.page = page;
      page.setDefaultTimeout(8000);
      page.on('dialog', dialog => dialog.dismiss());
    });
    this.page.setDefaultTimeout(8000);
    this.page.on('dialog', dialog => dialog.dismiss());
    return this;
  }

  async navigate(url) {
    await this.page.goto(webURL(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    return this.observe();
  }

  async observe() {
    if (!this.page || this.page.isClosed()) throw new Error('No open browser tab');
    const structure = await this.page.locator('body').ariaSnapshot({ timeout: 8000 });
    return {
      url: this.page.url(),
      title: await this.page.title(),
      structure: structure.slice(0, 20000),
      truncated: structure.length > 20000,
      tabs: this.context.pages().map((page, index) => ({ index, url: page.url(), active: page === this.page }))
    };
  }

  async target(role, name) {
    if (typeof role !== 'string' || typeof name !== 'string') throw new Error('Role and name must be strings');
    const locator = this.page.getByRole(role, { name, exact: true });
    const count = await locator.count();
    if (count !== 1) throw new Error(`Expected one ${role} named "${name}", found ${count}. Observe and disambiguate.`);
    return locator;
  }

  async checkTableRow(name, expectedJSON) {
    let fields;
    try { fields = JSON.parse(expectedJSON); } catch { throw new Error('Expected must be a JSON object mapping table column headings to exact cell text'); }
    if (!fields || Array.isArray(fields) || typeof fields !== 'object' || !Object.keys(fields).length || Object.keys(fields).length > 12 || Object.entries(fields).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim() || value.length > 1000)) throw new Error('Specify between 1 and 12 column headings with nonempty text values');
    const table = await this.target('table', name);
    if (!await table.isVisible()) throw new Error('The requested table is not visible; open its section first');
    const rows = table.getByRole('row');
    if (await rows.count() > 501) throw new Error('Table exceeds 500 rows; filter it before verifying');
    const headers = await table.getByRole('columnheader').allTextContents();
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    const columns = Object.keys(fields).map(key => {
      const matches = headers.map((value, index) => normalize(value) === normalize(key) ? index : -1).filter(index => index >= 0);
      if (matches.length !== 1) throw new Error('Expected one column headed ' + key + '; inspect the table');
      return matches[0];
    });
    const values = Object.values(fields).map(normalize);
    const matches = [];
    for (const row of await rows.all()) {
      if (!await row.isVisible()) continue;
      const cells = await row.getByRole('cell').allTextContents();
      if (columns.every((column, index) => normalize(cells[column] || '') === values[index])) matches.push(Object.fromEntries(Object.keys(fields).map((key, index) => [key, cells[columns[index]]])));
    }
    return { passed: matches.length === 1, actual: JSON.stringify({ matchingRows: matches.length, rows: matches.slice(0, 3) }) };
  }

  async close() {
    await this.browser?.close();
  }
}
