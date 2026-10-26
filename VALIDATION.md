# Validation

The latest checks used Node.js 26.5.1 on macOS, Playwright 1.64.1,
@google/genai 1.52.0, PDF.js 6.4.299 and headless Chromium. The full automated
suite passed 46 tests, and the dashboard browser checks passed.

The automated checks cover:

- Workspace traversal, absolute path and symlink rejection in workspace mode.
- All-files reads, searches, moves, and approved writes outside the default
  workspace; explicit symlink access without recursive search cycles.
- All-files API mode reporting, absolute folder navigation, and cross-origin rejection.
- Existing-file and move-destination collision protection.
- Tool argument and URL validation.
- File writes pausing before approval, with both decline and approval exercised.
- External browser interactions waiting for approval.
- Clarification responses and cancellation of a pending question.
- Rejection of missing, failed, stale, or subsequently invalidated verification evidence.
- Retry of a temporary 503 and immediate reporting of quota exhaustion.
- Real SDK error parsing with mocked HTTP responses, so retries retain status
  codes and quota, access, and missing-model errors retain their details.
- Actionable messages for connection failures and request timeouts.
- Native tool-call history preservation, including model content containing thought signatures.
- Native Ollama tool schema translation, assistant history and tool-result replay,
  malformed argument rejection, local-only endpoints, setup errors, and cancellation.
- A full Ollama controller task through a local HTTP fixture with no Gemini key.
- Excel/XLS/ODS/CSV/TSV reading, exact worksheet ranges, saved formula results,
  missing-cache warnings, and pagination without changing source bytes.
- Word DOCX/RTF, PowerPoint and OpenDocument text extraction in source order.
- Read-only Office protections, bounded parsing, cancellation, and rejection of
  oversized archives before expansion.
- PowerPoint ordering follows presentation relationships, including reordered
  slides. Workbook cache notes are retained in task results.
- Local-model text-only pauses receive at most one completion reminder; repeated
  pauses remain blocked and cannot manufacture verification evidence.
- Office uploads preserve binary bytes, reject malformed names/data and existing
  filenames, and return extracted text through the file API.
- PDF viewer requests use a fixed executable and a single literal absolute path;
  non-PDF files and out-of-scope paths are rejected before opening.
- PDF opening evidence requires an accepted handoff in the current run and a
  matching content hash; failed/cancelled requests and changed PDFs cannot finish.
  Unit tests mock the native opener and do not launch desktop applications.
- Recovery after a missing-file tool result, followed by verified completion.
- PDF text extraction with page labels, preserved source bytes, empty-page/OCR
  reporting, cancellation, and 50-page / 32,000-character limits.
- Invoice validation, exact decimal amounts, invalid dates, concurrent duplicate
  rejection, disk-error recovery without phantom saves, and persistence on restart.
- Exact table-row verification rejects values from different rows, hidden rows,
  duplicate matches and ambiguous column headings.
- A controller integration test reads a sample PDF, fills the actual invoice
  form with general browser tools, reloads it and verifies all saved fields.

The real-browser smoke test drives the dashboard and checks:

- A task is created through Playwright in the practice app and verified in the saved list.
- A screenshot is available in the dashboard.
- A file is absent while approval is pending, then saved and readable after approval.
- The saved file can be opened from the Files interface.
- Cross-origin requests are rejected; out-of-workspace paths are rejected in workspace mode.
- All-files mode can browse an external folder and open its text file through
  the dashboard, with working parent/workspace buttons and a narrow-screen layout.
- The narrow-screen dashboard has no horizontal overflow.
- No frontend JavaScript errors occur during these flows.
- Excel, Word and PDF uploads and previews work through the Files dashboard, with the
  saved workbook-value note visible in spreadsheet previews.
- Ollama mode selection, readiness checks, and verified completion through the
  native adapter using a local HTTP model fixture.
- The invoice sample selects AI mode and cannot run as a scripted demo. Its
  form and saved table work at desktop and mobile sizes; screenshots were inspected.

The automated suite makes no live model requests and spends no API credits.
Gemini controller tests use an injected fake provider; Ollama controller and UI
tests use a local HTTP fixture. The two visible scripted demos do not use a model.
Manual live-model checks are separate from this suite.

## Manual local-model check

On 26 October 2026, Ollama 0.40.11 with the downloaded `qwen3.5:4b` model
completed two real worker runs on this 16 GB Apple Silicon Mac:

- Read a temporary Markdown file outside the default workspace, reported
  Project Cedar and its owner, and finished with passed file-content checks.
- Used the actual Playwright browser to create a High-priority task in the
  practice website, then verified it in the saved list.

Both runs used six model turns. No Gemini key was supplied to the test app.
Temporary test files and the practice app's data were removed afterward.
These checks establish those sample workflows, not general model reliability
or a speed guarantee for arbitrary tasks.

A subsequent real Ollama run used `file_open_pdf` to hand the requested PDF in
Downloads to the macOS default viewer. The run finished in four model turns with
passed `file_opened` evidence, including a fresh content-hash check at completion.
This confirms the OS handoff, not the viewer's visible window or document text.

A real local Ollama Office task read an Excel range and a Word brief, reported
the saved workbook total and document owner, and finished with passed file-content
checks. Both source files retained their original content hashes. The run needed
tool-error recovery before completing; general local-model reliability remains
dependent on the task and model.

Run the checks yourself after browser installation:

```bash
npm test
npm run test:e2e
```

## Complete invoice workflow with real Ollama

On 26 October 2026, `qwen3.5:4b` completed the invoice task in **17 model turns
and 17 tool calls**, using the actual local model and browser. It searched the
sample invoices, chose Company X's CX-1042 over the older matching invoice,
read the PDF, and entered INR 18450.75 with due date 2026-11-19. It refreshed the
register, verified all seven fields in the same saved row, verified the source
invoice number, and cited both checks when finishing. Source bytes were unchanged.

The acceptance harness checked the actual stored record independently of the
model's summary. It used temporary data and no Gemini key; no real invoice
system or payment was involved. One successful run is not a reliability estimate.
Reproduce it with the installed Ollama service/model:

```bash
npm run test:invoice:ai
```

This separate, opt-in check makes real local model requests. The regular unit
and browser suites still use fixtures without model generation or API credits.
