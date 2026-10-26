# Start using Relay

Relay is a local app where you enter a goal and watch a worker use a browser or
text files to carry it out. You can try two fixed examples without an API key.
Your own AI-driven tasks can use local Ollama without an API key, or cloud
Gemini with a Google API key.

For a plain-language explanation of the entire folder, read
[HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## 1. Start the app

Install Node.js 22.13 or newer, then open a terminal inside the `ai-worker` folder.
You can check your installed version with `node --version`.

Run these commands one at a time:

```bash
npm install
npm run setup:browser
npm start
```

| Command | What it does |
| --- | --- |
| `npm install` | Downloads the libraries this project needs. |
| `npm run setup:browser` | Downloads Chromium, the browser the worker controls. |
| `npm start` | Starts the local server and prepares sample workspace files. |

Leave the terminal running. Open **http://127.0.0.1:3000** in your browser.
Press **Ctrl+C** in the terminal when you want to stop the server.

## 2. Try the browser example

1. Select **Scripted demo · no key** under **Execution mode**.
2. Choose **Work in a browser**.
3. Click **Start task**.

Watch **Activity** for the actions and **Computer view** for browser screenshots.
The worker creates **Review release notes** with **High** priority in the
practice website and checks that it is saved. If it already exists, it checks
the existing task.

## 3. Try the file example

1. Choose **Work with files**, then click **Start task**.
2. Review the proposed summary in the approval panel.
3. Click **Approve action** to let the worker save it.
4. Open **Files → summaries → project-summary.md** to read the output.

The file is stored at `data/workspace/summaries/project-summary.md`. The no-key
example extracts two paragraphs from the sample brief using fixed code. Both
demos use real tools, but neither uses AI to decide the steps.

## 4. Enable local AI without an API key

Install [Ollama](https://ollama.com/download). On this Mac, Homebrew can install
and start it, then download a tool-capable model:

```bash
brew install ollama
brew services start ollama
ollama pull qwen3.5:4b
```

Copy `.env.example` to `.env` if `.env` does not exist yet. Keep any existing
settings and add or update these lines:

```text
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

Stop your existing Relay server with **Ctrl+C**, run `npm start` once, and
refresh the dashboard. Select **Ollama · local AI**. Open **Setup → Check Ollama
connection** to confirm the downloaded model supports tools.

Try: **“Read notes/project-brief.md, tell me the project name, and verify it.”**

For the complete business-task example, choose **Process an invoice · AI
workflow**, then **Start task**. The worker compares sample invoices, reads the
latest Company X PDF, enters its details into the practice app, and verifies
the saved row. This is driven by the model, using the same file/browser tools
available to your own tasks. See [PROJECT_GOAL.md](PROJECT_GOAL.md).

Ollama processes model requests locally without Gemini quota. Downloads and
external browser visits still need the internet. A downloaded model uses RAM
while running and can be slower than a cloud model. File changes still pause
for approval. The no-key scripted demos remain separate from real local AI.

## 5. Enable cloud AI with Gemini

1. Create a Gemini API key at https://aistudio.google.com/apikey.
2. Stop the server with **Ctrl+C**.
3. Copy `.env.example` to a new file named `.env` in the project root.

On macOS or Linux:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Open `.env` in your text editor and set `GEMINI_API_KEY=your_actual_key`.
   Leave the other settings as they are to start. Model access depends on your
   Google project; change `GEMINI_MODEL` if its default is unavailable.
5. Run `npm start` again and refresh the dashboard.
6. Select **Gemini · live AI**, enter a task, and click **Start task**.

Try: **“Search the workspace for the project brief, read it, save a three-bullet summary to summaries/brief.md, and verify the file.”**

Gemini now chooses the tools based on your goal and their results. File changes
pause for approval. Browser clicks, typing, option selection, and supported key
presses outside the practice page also pause for approval.

Keep `.env` private. In live mode, your task and relevant observed page/file text
are sent to Gemini.

## Work with files in other folders

Set `FILE_ACCESS=all` in `.env`, then restart the server and refresh the dashboard.
The worker can now use files anywhere your OS account allows. In **Files**, enter
`~/Documents`, `~/Downloads`, or a full folder path and click **Open folder**.
Use **Home**, **Workspace**, and **Parent folder** to navigate.

For example, ask: **“Search ~/Documents for my project brief and summarize the
matching text file. Do not change files.”** File changes still require approval.
Supported formats and file-size limits still apply; see [FILE_FORMATS.md](FILE_FORMATS.md). Set `FILE_ACCESS=workspace` to
restrict access to `data/workspace/` again.

## Ask the agent to open a PDF on this Mac

In Ollama or Gemini mode, enter:

> Open ~/Downloads/anvesh.pdf in my default PDF viewer and verify the opening request.

The agent calls `file_open_pdf`, so a local file does not need a public web URL.
The tool accepts existing PDFs allowed by the file access setting and opens them
through macOS. The worker can confirm the handoff was accepted; it cannot inspect
the viewer window or read PDF text through this tool. Restart the server after
updating the code so the model receives the new tool.

## If you get stuck

| What you see | What to do |
| --- | --- |
| `node` or `npm` is not found | Install Node.js, then reopen the terminal. |
| The browser executable is missing | Run `npm run setup:browser` in this folder. |
| The dashboard will not load | Check that `npm start` is still running and use the address printed in its terminal. |
| A task waits for approval or input | Find the highlighted panel in the dashboard and approve, decline, or answer. |
| Your edited task is rejected in demo mode | Choose one of the two unchanged samples, or choose Ollama/Gemini for your own task. |
| Cannot connect to Ollama | Start the Ollama app, run `brew services start ollama` on this Mac, or run `ollama serve`. |
| The Ollama model is not installed | Run `ollama pull qwen3.5:4b`, or download the model named by `OLLAMA_MODEL`. |
| The local model does not support tools | Choose a tool-capable model and update Ollama. Use Setup to check the connection. |
| Ollama takes too long | Try a smaller tool-capable model, reduce `OLLAMA_CONTEXT_SIZE`, or increase `OLLAMA_TIMEOUT_MS` (maximum 300000). Restart after changing `.env`. |
| Gemini reports credentials, quota, or model errors | Check `.env` and your Google project access/quota, then restart the server after configuration changes. |
| Gemini reports HTTP 503/high demand or HTTP 504 | The app retries temporary service errors up to three times. If they continue, try later or choose another available function-calling model in `GEMINI_MODEL`, then restart. The no-key demos remain available. |

## Learn the code

Read these files in order:

1. `src/browser.js`: opening and observing a browser.
2. `src/files.js`: reading and writing with workspace or all-files access.
3. `src/tools.js`: describing available actions to the model.
4. `src/providers.js`: sending requests to Gemini and retrying temporary failures.
   `src/ollama.js` provides the local model equivalent and translates tool calls.
5. `src/agent.js`: the action–observation loop, task memory, approval and verification.
6. `server.js`: connecting the dashboard to the worker.
7. `public/app.js`: task input, activity updates, and user responses.

See `README.md` for configuration, limitations, architecture and tests. No live Gemini key is bundled in this project.

## Read Excel and Word files

Use **Files → Add file** to upload a workbook or document, or provide its path
in all-files mode. Ask, for example: **“Read ~/Downloads/budget.xlsx and summarize
the Costs worksheet”** or **“Summarize ~/Documents/brief.docx and verify the
project name.”** The agent can also open supported documents in their default
Mac apps. Office support is read-only and workbook formulas use saved results,
not fresh recalculation. See [FILE_FORMATS.md](FILE_FORMATS.md) for all supported
types and limits. Restart the server after updating the code.
