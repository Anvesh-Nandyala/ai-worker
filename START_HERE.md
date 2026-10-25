# Run Relay in five minutes

1. Install Node.js 22.9 or newer.
2. Extract this project and open a terminal in the `ai-worker` folder.
3. Run:

```bash
npm install
npm run setup:browser
npm start
```

4. Open **http://127.0.0.1:3000**.
5. Choose **Work in a browser**, then **Start task**. The no-key demo operates the included company app and verifies a saved task.
6. Choose **Work with files**, start the task, and approve the proposed file creation. Open **Files → summaries** to read the output.

## Make it autonomous

The no-key examples are explicitly scripted. To run your own natural-language tasks:

1. Create an API key at https://aistudio.google.com/apikey.
2. Copy `.env.example` to `.env`.
3. Paste your key into `GEMINI_API_KEY`.
4. Restart the server, then choose **Gemini · live AI**.
5. Enter a goal and an optional starting website.

The controller now asks Gemini which tools to use, executes the returned requests, observes the results, and repeats. The model does not receive the entire computer: it sees browser observations and workspace file content supplied by tools.

Try: **“Search the workspace for the project brief, read it, save a three-bullet summary to summaries/brief.md, and verify the file.”**

## Learn the code

Read these files in order:

1. `src/browser.js`: opening and observing a browser.
2. `src/files.js`: reading and writing inside a bounded folder.
3. `src/tools.js`: describing available actions to the model.
4. `src/providers.js`: sending requests to Gemini and retrying temporary failures.
5. `src/agent.js`: the action–observation loop, task memory, approval and verification.
6. `server.js`: connecting the dashboard to the worker.
7. `public/app.js`: task input, activity updates, and user responses.

See `README.md` for configuration, limitations, architecture and tests. No live Gemini key is bundled in this project.
