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

  async close() {
    await this.browser?.close();
  }
}
