# Relay — a local AI worker

A runnable prototype that accepts a natural-language goal, observes a browser and a scoped file workspace, chooses tools with Gemini, executes them, feeds the results back, and checks the outcome before reporting completion.

This is a source-code project you run on your own computer. It is not a hosted service. No account is required for the dashboard. A Gemini API key is required for arbitrary AI-driven tasks.

## Start here

Install Node.js **22.9 or newer**. Then open a terminal inside this folder:

```bash
npm install
npm run setup:browser
npm start
```

Open **http://127.0.0.1:3000**.

The app creates `data/workspace/` and adds a few sample text files. With no API key, it selects **Scripted demo · no key**. Choose either sample card and start it:

- **Work in a browser** operates a real Playwright browser against the included practice app, saves a task, and checks the saved list.
- **Work with files** reads the brief, prepares a simple scripted summary, pauses for approval, writes the file, and checks its content.

These two no-key scenarios are deterministic integration demos, **not autonomous AI**. Editing the task requires switching to Gemini mode. They let you test the complete execution, approval, logging and evidence path without buying credits.

## Enable real AI execution

Create a key at https://aistudio.google.com/apikey. Copy `.env.example` to `.env`:

macOS / Linux:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```text
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
PORT=3000
HEADLESS=true
```

Restart `npm start`. Select **Gemini · live AI** in the dashboard. Choose a task and, if it involves a website, enter its starting URL. To watch the separate browser window directly, set `HEADLESS=false` and restart. The dashboard also shows the latest browser screenshot and accessibility snapshot.

Model availability and free-tier quota depend on your Google project. You may change `GEMINI_MODEL` to another currently available model with function calling. Quota exhaustion is surfaced rather than retried in a loop. Transient 500/502/503/504 failures receive up to three attempts with increasing delays and jitter.

Keep `.env` private. The server never sends the key to the frontend. Live mode sends observed page content, relevant tool results, and requested workspace file content to Gemini. Use the sample material while experimenting.

## Try different tasks

Use the practice website at http://127.0.0.1:3000/demo with Gemini:

> Find the cheapest Office resource in the catalog and tell me its name and price. Verify the result from the displayed catalog.

> Read the Project notes section and tell me the release goal and project owner.

> Create a task named Test browser observations with Low priority. Refresh the saved task list and verify the task exists.

For workspace files:

> Find the meeting notes, identify the open question, and ask me for the missing decision. Then write a decision note to notes/decision.md and verify its contents.

> Search the workspace for Project Orbit, read the relevant brief, and save a concise summary to summaries/orbit.md. Verify the saved summary.

You can also enter another website's URL or a local development app. External browser interactions pause for review. The browser starts with a fresh profile; existing personal browser sessions are not imported. Logins, bot defenses, complex custom controls, and unsupported document formats may require user intervention or additional tools.

Add your own UTF-8 files through **Files → Add text file**, or copy them into `data/workspace/`. Uploads go under `imports/`. The worker does not automatically gain access to your whole computer.

## How execution works

1. The dashboard posts the task to the local Node server.
2. The server opens a browser and collects its URL, title, accessible page structure, and workspace listing.
3. Gemini receives the goal, tool declarations, observations, and task rules.
4. Gemini returns native function calls. The backend validates names and arguments and executes only registered tools.
5. Tool results, including failures, are appended to conversation history. Full model content is preserved so Gemini thought signatures survive subsequent turns.
6. The loop repeats. Relevant facts can be stored through `remember`. Missing information can be requested through `ask_user`.
7. File mutations and browser interactions outside the included practice page pause for user review. There is no automatic approval by the model.
8. The agent calls `verify` against actual browser or file state, then `finish` with passed evidence IDs.
9. The dashboard shows the result and offers a JSON report containing actions, results and checks.

This uses one agent with reusable tools; there are no invoice-specific actions or hardcoded steps in live mode.

## Capabilities and boundaries

| Area | Implemented |
| --- | --- |
| Browser | Navigate, observe, exact-role click/fill, native select, supported key presses, scroll, switch tabs, screenshot |
| Files | List, bounded text search, read, create/replace text files, move individual files |
| State | Task history, plan, discovered facts, tool results, usage counters |
| Recovery | Tool errors returned to the agent; bounded transient API retries; step and time limits |
| Human input | Clarification question, approval/decline, stop |
| Verification | Browser text/URL/field checks and file existence/content checks |
| Evidence | Verification records, latest screenshot, local JSON run report |

The file boundary is enforced in code: relative paths only, no directory traversal, and no symlinks. Files over 512 KB are rejected by the reader; model-visible text is capped at 32,000 characters. Search is bounded to 300 files and 30 results. Writes are limited to 128 KB. Only one worker run is active at a time.

Verification checks validate the supplied condition. The model chooses the condition for arbitrary tasks, so a passed condition is not a universal proof that every part of a broad user goal was satisfied. Inspect evidence for important work. New browser/file mutations invalidate prior evidence in that scope. Failed or stale evidence cannot be used to finish. Before finishing, the backend rechecks every cited condition against current state, including changes made outside the agent loop.

This prototype does **not** currently operate native desktop apps, execute shell commands, parse binary documents or OCR PDFs, process arbitrary spreadsheets, send messages through dedicated connectors, manage downloads, or replay existing browser sessions. Those are tool extensions, not capabilities implied by the word “general.” Webpages can be observed through their accessibility structure; inaccessible canvas widgets and cross-frame controls may need dedicated support. A paused run is not resumed after a server restart; its history is retained and marked stopped.

The server binds only to `127.0.0.1`, validates Host/Origin, and rejects cross-site requests. It is a local single-user prototype, not a multi-user hosted application. The agent's browser is prevented from accessing the worker's own control dashboard/API. This is defense in depth rather than an OS-level sandbox.

## Source map

```text
server.js                 Local HTTP server, API routes, sample workspace
src/agent.js              Agent loop, task state, approvals, verification
src/tools.js              Tool schemas, validation, agent instructions
src/browser.js            Playwright browser and observations
src/files.js              Scoped workspace operations
src/providers.js          Gemini client, retries, demo definitions
public/index.html         Dashboard
public/app.js             Dashboard interactions and polling
public/style.css          Dashboard styling
public/demo.*             Included practice company application
test/                     Core and controller protocol tests
scripts/smoke.js          Real-browser integration check
data/                     Created locally at runtime, excluded from source
```

To learn the project, start with `src/browser.js`, then `src/files.js`, `src/tools.js`, and finally `src/agent.js`. The frontend uses plain JavaScript so no React build pipeline is needed.

## Check the project

```bash
npm test
npm run test:e2e
```

Install the Playwright browser before running tests. Tests use temporary workspaces and a fake model for protocol assertions; they do not spend Gemini credits. The browser smoke check drives the dashboard, executes both no-key scenarios, approves a file write, checks the saved output, checks path/origin protections, and checks the narrow-screen layout.

Live Gemini behavior still depends on model responses, account access, quota, and network availability. No live model request is made by the test suite.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Live Gemini credential |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model ID |
| `PORT` | `3000` | Local server port |
| `HEADLESS` | `true` | Set false to show the controlled browser window |
| `MAX_MODEL_TURNS` | `20` | Per-run model decision limit, capped at 40 |
| `MAX_TOOL_CALLS` | `45` | Tool-call budget, capped at 100 |
| `MAX_RUN_MINUTES` | `10` | Time limit including approval pauses, capped at 30 |
| `DATA_DIR` | `./data` | Optional location for workspace and history |
| `BROWSER_EXECUTABLE_PATH` | empty | Optional compatible Chromium executable; normal installs do not need this |

If the Chromium download fails, check your network/proxy access or use an installed compatible Chromium executable through `BROWSER_EXECUTABLE_PATH`. The screenshot is captured after actions, not a continuous video feed. Stopping a task cancels pending questions and prevents subsequent tool calls; an already-issued operation may have completed and should be inspected before retrying.

## References

- Gemini function calling: https://ai.google.dev/gemini-api/docs/generate-content/function-calling
- Gemini JavaScript SDK: https://googleapis.github.io/js-genai/release_docs/
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Playwright library: https://playwright.dev/docs/library
- Playwright accessibility snapshots: https://playwright.dev/docs/aria-snapshots

