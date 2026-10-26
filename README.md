# Relay — a local AI worker

A runnable prototype that accepts a natural-language goal, observes a browser and local files, chooses tools with local Ollama or cloud Gemini, executes them, feeds the results back, and checks the outcome before reporting completion.

**Project goal:** complete a workflow across tools, from finding information to
checking a saved result. Choose **Process an invoice · AI workflow** to have the
model find the latest Company X invoice, read its PDF, register its details in
the practice website, and verify all fields after refreshing. See
[PROJECT_GOAL.md](PROJECT_GOAL.md) for the complete example and remaining scope.

This is a source-code project you run on your own computer. It is not a hosted service. No account is required for the dashboard. Your own AI-driven tasks can use a downloaded Ollama model without an API key, or Gemini with a Google API key.

**New to this folder?** Read [HOW_IT_WORKS.md](HOW_IT_WORKS.md) for a plain-language
walkthrough of the parts and a complete example. Follow [START_HERE.md](START_HERE.md)
to install it and try your first task.

## Start here

Install Node.js **22.13 or newer**. Then open a terminal inside this folder:

```bash
npm install
npm run setup:browser
npm start
```

Open **http://127.0.0.1:3000**.

The app creates `data/workspace/` and adds a few sample text files. With no API key, it selects **Scripted demo · no key**. Choose either sample card and start it:

- **Work in a browser** operates a real Playwright browser against the included practice app, saves a task, and checks the saved list.
- **Work with files** reads the brief, prepares a simple scripted summary, pauses for approval, writes the file, and checks its content.

These two scripted scenarios are deterministic integration demos, **not autonomous AI**. Editing the task requires switching to Ollama or Gemini mode. The invoice sample requires AI mode and chooses its actions dynamically. The scripted samples test the execution, approval, logging and evidence path without running a model.

## Run AI locally with Ollama

Install [Ollama](https://ollama.com/download). On macOS with Homebrew, you can use:

```bash
brew install ollama
brew services start ollama
ollama pull qwen3.5:4b
```

The model needs roughly 3–4 GB of disk space, plus working memory when loaded.
Use a model that supports tools. Larger models and context windows need more
memory; model quality and speed depend on the model and your hardware.

Copy `.env.example` to `.env` if you do not already have `.env`, then set:

```text
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_TIMEOUT_MS=120000
OLLAMA_CONTEXT_SIZE=16384
```

Stop an existing Relay server with Ctrl+C before running `npm start` again.
Refresh the dashboard and choose **Ollama · local AI**. Setup includes a
**Check Ollama connection** button that checks the server, installed model, and
tool support without generating a completion.

Ollama mode sends tasks and tool results to the local Ollama service; it does
not call Gemini or require a Google API key. Local inference has no cloud
request quota. Browser visits still contact the websites you ask it to use.
Only local HTTP Ollama endpoints are accepted, and cloud-tagged or reported
remote models are rejected. There is no automatic fallback to a cloud provider.
The same file/browser tools, approvals, task limits, and verification apply.
The adapter preserves native Ollama assistant/tool-call messages between turns.

## Enable cloud AI with Gemini

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

Restart `npm start`. Select **Gemini · live AI** in the dashboard, or set `AI_PROVIDER=gemini` to make it the default. Choose a task and, if it involves a website, enter its starting URL. To watch the separate browser window directly, set `HEADLESS=false` and restart. The dashboard also shows the latest browser screenshot and accessibility snapshot.

Model availability and free-tier quota depend on your Google project. You may change `GEMINI_MODEL` to another currently available model with function calling. Quota exhaustion is surfaced rather than retried in a loop. Transient 500/502/503/504 failures receive up to three attempts with increasing delays and jitter.

Keep `.env` private. The server never sends the key to the frontend. Gemini mode sends observed page content, relevant tool results, and requested workspace file content to Google. Ollama mode sends that content to your local model. Use the sample material while experimenting.

## Try different tasks

Use the practice website at http://127.0.0.1:3000/demo with Ollama or Gemini:

> Find the cheapest Office resource in the catalog and tell me its name and price. Verify the result from the displayed catalog.

> Read the Project notes section and tell me the release goal and project owner.

> Create a task named Test browser observations with Low priority. Refresh the saved task list and verify the task exists.

For workspace files:

> Find the meeting notes, identify the open question, and ask me for the missing decision. Then write a decision note to notes/decision.md and verify its contents.

> Search the workspace for Project Orbit, read the relevant brief, and save a concise summary to summaries/orbit.md. Verify the saved summary.

You can also enter another website's URL or a local development app. External browser interactions pause for review. The browser starts with a fresh profile; existing personal browser sessions are not imported. Logins, bot defenses, complex custom controls, and unsupported document formats may require user intervention or additional tools.

Add text, Excel, Word, PowerPoint, OpenDocument, or PDF files through **Files → Add file**, or use existing file paths in all-files mode. Uploads go under `imports/` in the default workspace. See [FILE_FORMATS.md](FILE_FORMATS.md) for the complete format matrix, limits, and examples.

To access other folders, set `FILE_ACCESS=all` in `.env` and restart the server.
The Files tab then provides a folder-path input, Home, Workspace, and Parent
folder navigation. Enter `~/Documents`, `~/Downloads`, or an absolute path.
The live worker can read, write, move, and verify files at those paths. For example:

> Search ~/Documents for Project Orbit, read the matching text brief, and tell me the release goal. Do not change any files.

All-files mode permits access wherever your OS account allows; it does not grant
additional macOS permissions. File changes still pause for approval and show the
resolved destination. Read file content goes to the selected model: local Ollama
or cloud Gemini.
Set `FILE_ACCESS=workspace` to restore access limited to the default workspace.

## How execution works

1. The dashboard posts the task to the local Node server.
2. The server opens a browser and collects its URL, title, accessible page structure, and workspace listing.
3. The selected model receives the goal, tool declarations, observations, and task rules.
4. The model returns native function calls. The backend validates names and arguments and executes only registered tools.
5. Tool results, including failures, are appended to conversation history. Native model messages are preserved; Gemini thought signatures and Ollama tool-call metadata survive subsequent turns.
6. The loop repeats. Relevant facts can be stored through `remember`. Missing information can be requested through `ask_user`.
7. File mutations and browser interactions outside the included practice page pause for user review. There is no automatic approval by the model.
8. The agent calls `verify` against actual browser or file state, then `finish` with passed evidence IDs.
9. The dashboard shows the result and offers a JSON report containing actions, results and checks.

This uses one agent with reusable tools; there are no invoice-specific actions or hardcoded steps in live mode.

## Capabilities and boundaries

| Area | Implemented |
| --- | --- |
| Browser | Navigate, observe, exact-role click/fill, native select, supported key presses, scroll, switch tabs, screenshot |
| Files | List, bounded content search, text/Office reading, approved text writes, move individual files |
| Spreadsheets | Read Excel/XLS/ODS/CSV/TSV sheets, bounded ranges, saved values and formulas |
| Documents | Extract Word, PowerPoint and OpenDocument text; upload and preview documents |
| Default apps (macOS) | Open supported PDFs, Office and text documents; verify macOS accepted the handoff |
| State | Task history, plan, discovered facts, tool results, usage counters |
| Recovery | Tool errors returned to the agent; bounded transient API retries; step and time limits |
| Human input | Clarification question, approval/decline, stop |
| Verification | Browser text/URL/field checks, exact fields in one table row, and file existence/content checks |
| Evidence | Verification records, latest screenshot, local JSON run report |

In the default `FILE_ACCESS=workspace` mode, the file boundary is enforced in code:
relative paths only, no directory traversal, and no symlinks. With `FILE_ACCESS=all`,
absolute paths, `~/` paths, parent paths, and explicit symlink paths are allowed,
subject to OS permissions. Relative paths still start at `data/workspace/`.
Plain-text files over 512 KB and Office files over 16 MB are rejected by their
readers; extracted text is capped at 32,000 characters. Search accepts an optional starting `path` and is bounded to
300 entries, 30 results, and five directory levels. Recursive search skips
directory symlinks and inaccessible subdirectories rather than following cycles
or stopping at the first unreadable child. Writes are limited to 128 KB. Only one
worker run is active at a time. File-format support is the same in either access
mode and includes read-only Excel, Word, PowerPoint and OpenDocument extraction.
PDF text layers can be read with page labels, up to 50 pages and 32,000 characters;
scanned/image-only pages still need OCR, which is unavailable. On macOS, `file_open` can open
supported documents in their default apps; `file_open_pdf` remains a PDF-specific
alias. For example:

> Open ~/Downloads/anvesh.pdf in my default PDF viewer and verify the opening request.

The worker uses a fixed macOS opener with a literal file path and respects the
selected file access mode. `verify` with `kind: file_opened` checks that this run
successfully handed the document to macOS and that its content is unchanged. It
does not establish app visibility or control app windows. File writes and moves
retain their existing review step. Office editing is unsupported; `file_write`
rejects Office/PDF paths before requesting approval.

Verification checks validate the supplied condition. The model chooses the condition for arbitrary tasks, so a passed condition is not a universal proof that every part of a broad user goal was satisfied. Inspect evidence for important work. New browser/file mutations invalidate prior evidence in that scope. Failed or stale evidence cannot be used to finish. Before finishing, the backend rechecks every cited condition against current state, including changes made outside the agent loop.

Beyond opening supported documents in their default macOS apps, this prototype does **not** currently control native desktop apps, execute arbitrary shell commands, edit Office files, recalculate workbooks, OCR PDFs, send messages through dedicated connectors, manage downloads, or replay existing browser sessions. Those are tool extensions, not capabilities implied by the word “general.” Webpages can be observed through their accessibility structure; inaccessible canvas widgets and cross-frame controls may need dedicated support. A paused run is not resumed after a server restart; its history is retained and marked stopped.

The server binds only to `127.0.0.1`, validates Host/Origin, and rejects cross-site requests. It is a local single-user prototype, not a multi-user hosted application. The agent's browser is prevented from accessing the worker's own control dashboard/API. This is defense in depth rather than an OS-level sandbox.

## Source map

```text
server.js                 Local HTTP server, API routes, sample workspace
src/agent.js              Agent loop, task state, approvals, verification
src/tools.js              Tool schemas, validation, agent instructions
src/browser.js            Playwright browser and observations
src/files.js              Workspace and optional all-files operations
src/providers.js          Gemini client, retries, demo definitions
src/ollama.js             Local Ollama client and native tool-call adapter
src/file-viewer.js        macOS document opening and content-hash verification
src/pdf-viewer.js         PDF-only compatibility adapter
src/document-reader.js    Bounded document-reader worker and legacy converter
src/document-worker.js    Excel/Word/PowerPoint/OpenDocument extraction
src/pdf-reader.js         PDF text extraction inside the bounded document worker
src/demo-invoices.js      Practice register validation and duplicate identity
fixtures/invoices/        Fictional invoices seeded without replacing user files
PROJECT_GOAL.md           Product goal, invoice walkthrough and next milestones
FILE_FORMATS.md           File compatibility, examples and limits
public/index.html         Dashboard
public/app.js             Dashboard interactions and polling
public/style.css          Dashboard styling
public/demo.*             Included practice company application
test/                     Core and controller protocol tests
scripts/smoke.js          Real-browser integration check
.env.example              Configuration template; copy to .env for live AI
HOW_IT_WORKS.md            Plain-language explanation of the whole project
START_HERE.md              Guided setup and first tasks
data/                     Created locally at runtime, excluded from source
```

To learn the project, start with `src/browser.js`, then `src/files.js`, `src/tools.js`, and finally `src/agent.js`. The frontend uses plain JavaScript so no React build pipeline is needed.

## Check the project

```bash
npm test
npm run test:e2e
```

Install the Playwright browser before running tests. Tests use temporary workspaces and a fake model for protocol assertions; they do not spend Gemini credits. The browser smoke check drives the dashboard, executes both no-key scenarios, approves a file write, checks the saved output, checks path/origin protections, and checks the narrow-screen layout.

Live Gemini behavior still depends on model responses, account access, quota, and network availability. Ollama behavior depends on the downloaded model, local service, memory, and hardware speed. `npm test` and `npm run test:e2e` use fixtures without live model generation. `npm run test:invoice:ai` is an explicit opt-in acceptance test with the installed local Ollama model and temporary sample data.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | empty | Live Gemini credential |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model ID |
| `AI_PROVIDER` | `gemini` with a key, otherwise `demo` | Initial dashboard mode: `ollama`, `gemini`, or `demo` |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Downloaded local model with tool support |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama HTTP server |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-request timeout, bounded to 1–300 seconds |
| `OLLAMA_CONTEXT_SIZE` | `16384` | Local model context window; larger values need more memory |
| `PORT` | `3000` | Local server port |
| `HEADLESS` | `true` | Set false to show the controlled browser window |
| `MAX_MODEL_TURNS` | `32` | Per-run model decision limit, capped at 40 |
| `MAX_TOOL_CALLS` | `45` | Tool-call budget, capped at 100 |
| `MAX_RUN_MINUTES` | `10` | Time limit including approval pauses, capped at 30 |
| `DATA_DIR` | `./data` | Optional location for workspace and history |
| `FILE_ACCESS` | `workspace` | `all` enables file paths outside the workspace, subject to OS permissions |
| `BROWSER_EXECUTABLE_PATH` | empty | Optional compatible Chromium executable; normal installs do not need this |

If the Chromium download fails, check your network/proxy access or use an installed compatible Chromium executable through `BROWSER_EXECUTABLE_PATH`. The screenshot is captured after actions, not a continuous video feed. Stopping a task cancels pending questions and prevents subsequent tool calls; an already-issued operation may have completed and should be inspected before retrying.

## References

- Gemini function calling: https://ai.google.dev/gemini-api/docs/generate-content/function-calling
- Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
- Ollama local model: https://ollama.com/library/qwen3.5:4b
- Gemini JavaScript SDK: https://googleapis.github.io/js-genai/release_docs/
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Playwright library: https://playwright.dev/docs/library
- Playwright accessibility snapshots: https://playwright.dev/docs/aria-snapshots


Document reader references: [SheetJS](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), [Mammoth](https://github.com/mwilliamson/mammoth.js), [fflate](https://github.com/101arrowz/fflate).
