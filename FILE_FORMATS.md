# File compatibility

Relay can open, read, and summarize existing documents. Excel and Word source
files are read-only; the text writer rejects binary document formats.

| Files | Agent can read | Agent can open on macOS |
| --- | --- | --- |
| Excel `.xlsx`, `.xls` | Sheet names, cell ranges, saved values, and formulas | System default spreadsheet app |
| OpenDocument `.ods` | Sheet names, ranges, saved values, and formulas | System default spreadsheet app |
| `.csv`, `.tsv` | Text or structured cell ranges | System default associated app |
| Word `.docx` | Extracted document text | System default document app |
| Legacy Word `.doc`, `.rtf` | Text through macOS `textutil` | System default document app |
| OpenDocument `.odt` | Body text and headings | System default document app |
| PowerPoint `.pptx` | Slide text in slide order | System default presentation app |
| OpenDocument `.odp` | Presentation text | System default presentation app |
| PDF `.pdf` | Text layer with page labels; no OCR for scanned/image-only pages | System default PDF viewer |
| Legacy PowerPoint `.ppt` | Opening only; convert to `.pptx` for text extraction | System default presentation app |
| `.txt`, `.md` | Text | System default associated app |
| Other supported text files, including `.json`, `.log`, `.js`, `.css` | Text | Not handled by the document opener |

Reading modern documents does not require Microsoft Office or a paid API.
Opening a document requires a suitable default app installed on the Mac.
The opener confirms macOS accepted the request and checks that the document's
contents are unchanged. It does not inspect or control the app window.

## Try a task

Select **Ollama · local AI** or **Gemini · live AI**, then enter a goal:

> Read ~/Downloads/budget.xlsx and summarize the Costs worksheet. Use the saved values and identify any missing formula results.

> Read cells A1:D20 on the Sales worksheet in ~/Documents/report.xlsx. Tell me the column headings and the saved total.

> Summarize ~/Documents/project-brief.docx. Verify the project name and owner against the document text.

> Read ~/Downloads/presentation.pptx and summarize the main points from each slide.

> Open ~/Downloads/budget.xlsx in my default spreadsheet app and verify the opening request.

With `FILE_ACCESS=all`, these paths can be outside the project folder, subject
to your OS account's permissions. In workspace mode they must stay inside
`data/workspace/`.

## Add and preview documents

Use **Files → Add file** to upload a document. Uploads are stored under
`data/workspace/imports/` and do not overwrite existing filenames. Excel and
Word previews show extracted content, not a visual replica of the original app.
You can also give the agent the path to an existing file in all-files mode.

Office/PDF uploads and readers accept files up to **16 MB**. Text uploads
remain limited to **128 KB**; the plain-text reader accepts files up to 512 KB.
Extracted document previews are limited to **32,000 characters**. Spreadsheet
previews include up to five worksheets; `spreadsheet_read` can select another
sheet or range and returns pagination information when results are limited.
Each range is bounded to 200 rows, 50 columns, 2,000 cells and a text budget.
Long cell text or formulas can be marked truncated; narrow the range for more
detail. PDF extraction reads at most 50 pages and reports empty or truncated
pages. Document-content searches inspect at most 12 Office/PDF files per search;
narrow the starting directory if this limit is reached.

## What the extracted data means

Spreadsheet formulas are exposed as text. Their displayed values come from
the workbook's **saved/cached results**, which may be stale or missing. Relay
does not recalculate a workbook, execute macros, or fetch external workbook
links. Dates use the workbook's display format. Opening the workbook in a
spreadsheet app uses that app's own behavior and settings.

Text extraction does not preserve full page layout, render charts, perform OCR,
or describe embedded images. Password-protected/encrypted files are not
supported. PDF/OOXML/OpenDocument parsing runs with a 20-second time limit and
a 256 MB worker heap limit; PDF scripts and external links are not executed.
Office archives above 32 MB expanded or 4,000 entries are rejected. Legacy `.doc` and
`.rtf` extraction uses the fixed macOS text converter with a timeout.

Parsed content is sent to the selected model: local Ollama or cloud Gemini.
Original Office and PDF files are not rewritten. If you explicitly ask for a saved
summary, the agent can propose a Markdown/text file using the existing approval
flow.
