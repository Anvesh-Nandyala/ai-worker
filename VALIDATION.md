# Validation

The project was checked with Node.js 24, Playwright 1.64.1, @google/genai 1.52.0, and a compatible headless Chromium executable.

The automated checks cover:

- Workspace traversal, absolute path and symlink rejection.
- Existing-file and move-destination collision protection.
- Tool argument and URL validation.
- File writes pausing before approval, with both decline and approval exercised.
- External browser interactions waiting for approval.
- Clarification responses and cancellation of a pending question.
- Rejection of missing, failed, stale, or subsequently invalidated verification evidence.
- Retry of a temporary 503 and immediate reporting of quota exhaustion.
- Native tool-call history preservation, including model content containing thought signatures.
- Recovery after a missing-file tool result, followed by verified completion.

The real-browser smoke test drives the dashboard and checks:

- A task is created through Playwright in the practice app and verified in the saved list.
- A screenshot is available in the dashboard.
- A file is absent while approval is pending, then saved and readable after approval.
- The saved file can be opened from the Files interface.
- Cross-origin requests and out-of-workspace paths are rejected.
- The narrow-screen dashboard has no horizontal overflow.
- No frontend JavaScript errors occur during these flows.

No live Gemini request was made during validation: a real API credential and available quota are required to validate live autonomous behavior. Controller protocol tests use an injected fake provider, and the two visible no-key scenarios are explicitly scripted.

Run the checks yourself after browser installation:

```bash
npm test
npm run test:e2e
```
