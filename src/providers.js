import { GoogleGenAI } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';

export class GeminiProvider {
  constructor({ apiKey, model, onRetry }) {
    if (!apiKey) throw new Error('Set GEMINI_API_KEY in .env and restart, or use a scripted demo');
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } } });
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
  browser: {
    task: 'Create a task named Review release notes with High priority in the demo workspace. Verify it was saved.',
    title: 'Review release notes'
  },
  files: {
    task: 'Read notes/project-brief.md and create summaries/project-summary.md with a short summary. Verify the saved file.',
    path: 'summaries/project-summary.md'
  }
};
