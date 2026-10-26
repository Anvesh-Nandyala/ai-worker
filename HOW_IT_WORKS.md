# Understand the AI worker

This folder contains **Relay**, a small application you run on your computer.
You give it a task in plain language. It can use a separate browser and local
documents to carry out that task, then check the result. File access can be
limited to its workspace or enabled for all locations your OS account allows.

Start with [START_HERE.md](START_HERE.md) to run it. This guide explains what
happens after you press **Start task**.

The goal is a complete task across tools. The **Process an invoice · AI
workflow** sample finds an invoice, reads its PDF text, enters the extracted
fields in a website, refreshes the saved list, and verifies those fields in one
record. [PROJECT_GOAL.md](PROJECT_GOAL.md) walks through this example.

## The four parts

| Part | Its job | Where it lives |
| --- | --- | --- |
| Dashboard | Lets you enter tasks, watch progress, answer questions, and approve actions. | `public/index.html`, `public/app.js`, `public/style.css` |
| Local server | Connects the dashboard to the worker and stores files and task history. | `server.js` |
| AI model | Local Ollama or cloud Gemini chooses the next action from the available tools. | `src/ollama.js` or `src/providers.js` |
| Tools | Perform browser actions and file operations requested by the worker. | `src/browser.js`, `src/files.js`, `src/tools.js` |

**The model chooses an action; your application's code performs it.**
For example, the model can request “read this file.” The server checks that
request, reads the file using the file tool, and returns the text to the model.

## A task from beginning to end

Suppose you enter:

> Read notes/project-brief.md, write a three-bullet summary to summaries/brief.md,
> and verify the saved summary.

1. **You submit the task.** The dashboard sends it to the local server.
2. **The worker gathers information.** It opens a fresh browser and lists the
   workspace files. A file's contents are read only when a tool requests them.
3. **The model chooses tools.** It receives the task, observations, and allowed
   actions. It can record a plan and request `file_read` for the brief.
4. **The server performs the action.** It validates the request, reads the file,
   and returns its text to the model.
5. **The model uses the result.** It prepares a summary and requests `file_write`
   with the destination and proposed text.
6. **You review the change.** The dashboard shows the proposed file content.
   The worker waits for you to approve or decline before writing.
7. **The worker checks the saved file.** A `verify` request reads the actual
   saved state and records whether the expected content is present.
8. **The worker finishes.** It must cite passed checks. The server checks those
   conditions again before accepting completion.

The repeating part is:

```text
Observe → choose an action → run a tool → inspect the result → repeat
```

`src/agent.js` coordinates this loop. If a tool fails, its error goes back to
the model so it can choose another action. If information is missing, the worker
can ask you a question. Runs also have action, model-turn, and time limits.

A passed check confirms the condition that was tested. For example, checking
that a file contains a sentence does not establish that every statement in a
summary is accurate. You can inspect the output and evidence in the dashboard.

## Demo mode versus live AI

**Ollama · local AI** runs a downloaded tool-capable model on your computer.
It chooses steps dynamically, uses the same tools as Gemini, and needs no API
key. Set `AI_PROVIDER=ollama` and `OLLAMA_MODEL=qwen3.5:4b` in `.env` after
installing Ollama and downloading the model. The app checks the local service
and tool support. Local mode does not fall back to Gemini or a cloud model.
It uses your Mac's memory and processing power, so speed and reliability depend
on the model and hardware. See [START_HERE.md](START_HERE.md) for setup.

| | Scripted demo · no key | Gemini · live AI |
| --- | --- | --- |
| Needs a Gemini API key? | No | Yes |
| Who chooses the steps? | Fixed code in `runDemo()` in `src/agent.js` | Gemini, using observations and tool results |
| Which tasks work? | The two sample tasks only | Your own tasks, within the available tools |
| Uses real tools? | Yes: browser actions, file operations, approvals, and checks | Yes: the same tool system |
| Sends task content to Gemini? | No | Yes |

The browser demo creates **Review release notes** with **High** priority in the
included practice app, or checks it if it already exists. The file demo copies
the brief's first two non-heading paragraphs into a summary file. The no-key
file demo does not use AI to compose a new summary.

## What the browser worker sees

The worker opens its own Chromium browser through **Playwright**, a browser
automation library. It does not use your existing browser's logged-in sessions.

The selected model receives a text description of the page: its URL, title, visible text,
accessible controls, and open tabs. A control might be described as
`button "Add task"` or `textbox "Task title"`. The browser tool uses those names
to find and operate the controls.

The dashboard's **Computer view** shows you the latest screenshot. In this
implementation, screenshot images are not sent to either model. The image updates
after captures; it is not a continuous video stream.

Browser clicks, typing, option selection, and supported key presses outside the
included practice page pause for approval. Navigation, observation, and scrolling
do not use that approval prompt. File writes and moves require approval when
they change something; an identical file write can return unchanged.

## Where your files go

Starting the server creates this structure by default:

```text
data/
├── workspace/                 Files available to the worker
│   ├── notes/                 Sample project brief and meeting notes
│   ├── resources/             Sample catalog.csv
│   ├── sample-invoices/       Fictional invoices for the full AI workflow
│   ├── imports/               Created when you add files through the dashboard
│   └── summaries/             Created when a task saves a summary here
├── runs/
│   └── <run-id>/
│       ├── run.json           Task history, results, memory, and checks
│       └── screen.png         Latest captured browser screenshot
└── demo.json                  Saved practice tasks and invoice records
```

The **Files** tab starts at `data/workspace/`.
For example, `notes/project-brief.md` means
`data/workspace/notes/project-brief.md`. Add supported text and Office files through
**Files → Add file**, or copy them into this folder. Dashboard uploads go
into `imports/`.

With `FILE_ACCESS=workspace` (the default), file tools reject paths outside this
workspace and symbolic links. With `FILE_ACCESS=all`, the worker can also use
absolute paths such as `/Users/yourname/Documents/brief.md`, `~/Documents/brief.md`,
and parent paths. The Files tab adds a folder-path input and navigation buttons.
The worker's `file_search` tool accepts a starting `path` so it can search another
folder without scanning the entire computer. The host's OS permissions still
apply, and file writes and moves still require approval. Restart the server
after changing this setting in `.env`.

Both modes support text, PDF text layers, and read-only Office extraction. Word documents can
provide plain text; Excel workbooks provide sheet names, cell ranges, saved
values and formula text. PowerPoint and OpenDocument text can also be extracted.
Formulas are not recalculated and macros are not executed by the reader. See
[FILE_FORMATS.md](FILE_FORMATS.md) for the format matrix and limits.

On macOS, `file_open` can hand supported documents to their default apps, and
`file_open_pdf` remains available for PDFs. Ask the agent to open the file by its
path; the browser's web-only
navigation is not involved. `verify` with `file_opened` confirms the OS accepted
the request and that the document's contents are unchanged. It does not check whether
the viewer window is visible or extract the document's text.

Task memory is a collection of facts for that run. It does not train the model.
History stays on disk, but restarting the server stops unfinished runs; it does
not resume them. Only one task can run at a time.

## The remaining project files

| File | Purpose |
| --- | --- |
| `public/demo.html`, `demo.js`, `demo.css` | The practice website: tasks, project notes, and a resource catalog. |
| `package.json` | Required libraries and commands such as `npm start` and `npm test`. |
| `.env.example` | An example configuration to copy to `.env` for live AI. |
| `.gitignore` | Keeps credentials, dependencies, and generated data out of Git. |
| `test/core.test.js` | Checks workspace restrictions, approvals, verification, and related behavior. |
| `test/file-access.test.js` | Checks all-files paths, external reads and writes, search, approvals, and navigation APIs. |
| `test/protocol.test.js` | Checks the model/tool conversation using a fake provider. |
| `scripts/smoke.js` | Exercises the dashboard and demos in a real browser. |
| `README.md` | Detailed capabilities, configuration, and technical notes. |
| `START_HERE.md` | Step-by-step setup and your first task. |
| `VALIDATION.md` | Describes the validation performed on the prototype. |

The application runs locally. **In Gemini mode, the task and relevant observed
page/file text are sent to Google's Gemini service.** The API key is read by the
server from `.env`; it is not sent to the dashboard. No live key is bundled.
In **Ollama mode**, that information is sent to the local Ollama service instead.
Browser requests still go to the websites you visit.

The current tool set covers websites, text files, read-only Excel/Word/PowerPoint/
OpenDocument files, and opening supported documents in their default Mac apps.
Controlling native app windows, arbitrary terminal commands, PDF OCR, Office
editing, and workbook recalculation would need additional tools.
