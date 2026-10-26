import { GoogleGenAI } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';

export class GeminiProvider {
  constructor({ apiKey, model, onRetry }) {
    if (!apiKey) throw new Error('Set GEMINI_API_KEY in .env and restart, or use a scripted demo');
    // Let the SDK parse HTTP errors before our retry loop handles them. In the
    // pinned SDK, setting retryOptions replaces status/body with a generic Error.
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60000 } });
    this.model = model;
    this.onRetry = onRetry;
  }

  async generate(contents, config, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents,
          config: { ...config, abortSignal: signal }
        });
        signal.throwIfAborted();
        return response;
      } catch (error) {
        signal.throwIfAborted();
        const status = Number(error.status);
        if (![500, 502, 503, 504].includes(status) || attempt === 2) {
          if (status === 429) throw new Error('Gemini quota or rate limit reached. Check this project’s limits in AI Studio, wait for reset, or select an available model. ' + error.message);
          if (status === 401 || status === 403) throw new Error('Gemini rejected the API credentials or project access. ' + error.message);
          if (status === 404) throw new Error(`Gemini model "${this.model}" is unavailable to this project. Check GEMINI_MODEL in .env and restart the server. ` + error.message);
          if (status >= 500 && status <= 599) throw new Error(`Gemini service request failed (HTTP ${status}) after ${attempt + 1} attempt(s). Try again shortly. ` + error.message);
          if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('Gemini did not respond before the request timed out. Check your connection and try again.');
          if (error.message === 'fetch failed') throw new Error('Could not connect to Gemini. Check your internet connection, proxy, or firewall and try again.');
          throw error;
        }
        const milliseconds = 2000 * 2 ** attempt + Math.floor(Math.random() * 500);
        this.onRetry?.({ status, attempt: attempt + 1, milliseconds });
        await delay(milliseconds, undefined, { signal });
      }
    }
  }
}

export const PRESETS = {
  invoice: {
    aiOnly: true,
    task: 'Find the latest invoice from Company X in sample-invoices, using the invoice date. Read its invoice number, invoice date, amount, currency and due date. Enter these details and the source file path into the practice app’s invoice register. Avoid duplicates. Refresh the saved records and verify every field in the same saved row against the source, then tell me the result.'
  },
  browser: {
    task: 'Create a task named Review release notes with High priority in the demo workspace. Verify it was saved.',
    title: 'Review release notes'
  },
  files: {
    task: 'Read notes/project-brief.md and create summaries/project-summary.md with a short summary. Verify the saved file.',
    path: 'summaries/project-summary.md'
  }
};
