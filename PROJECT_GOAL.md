# Project goal: an AI worker that completes computer tasks

Relay takes a natural-language outcome, gathers information, decides what to do,
uses computer tools, checks the result, and reports what happened. Reading files
and opening applications are tools within that workflow.

## The prototype's complete example

> Find the latest invoice from Company X, extract the amount and due date,
> enter it into our internal system, and tell me once it is done.

Choose **Process an invoice · AI workflow** in the dashboard. It uses the local
practice app as the internal system and fictional files in `sample-invoices/`.
The card supplies the company, source folder, destination and date basis so the
worker has enough information to act. Ollama or Gemini decides the tool calls;
there is no invoice-specific extraction tool or scripted invoice agent.

| Stage | What happens | What you can inspect |
| --- | --- | --- |
| Understand | Record a plan; ask if required details are missing | Plan and questions |
| Find and read | Search the relevant folder and extract text from the invoices | Paths, snippets and source text |
| Decide | Compare company and invoice dates; choose the latest matching document | Tool results and task memory |
| Act | Inspect existing records, fill the website form, and save | Actions and browser screenshots |
| Check | Refresh the saved records and compare all invoice fields in one row | Passed/failed verification evidence |
| Report | State the saved invoice number, amount, currency, due date and source | Completion summary and exported run |

The supplied latest Company X invoice is **CX-1042**, dated **2026-10-20**, for
**INR 18450.75**, due **2026-11-19**. An older Company X invoice and a newer
Company Y invoice test the selection. The register rejects duplicate company /
invoice-number pairs. Registering an invoice does not make a payment.

## Try it

1. Restart the existing server with Ctrl+C, then `npm start`. Refresh the dashboard.
2. Choose **Process an invoice · AI workflow**. The card selects AI mode and
   supplies the practice website automatically.
3. Use **Ollama · local AI**, then **Start task**. Watch actions and verification.
4. Open the practice app at `/demo#invoices` to inspect the saved record, or use
   **Export run** for the action log and evidence.

The two older browser/file examples still offer fixed scripted demonstrations.
They are useful integration checks; use Ollama or Gemini for autonomous choices.

## What is demonstrated, and what remains

The prototype combines local file search, PDF/Office text extraction, browser
interaction, recovery, questions, approvals, persisted history and evidence.
It can attempt other tasks that fit those tools. Model decisions remain fallible;
a passed condition establishes only what that check actually tested.

To use a real internal system, provide its URL and the relevant source folder.
The browser starts with a fresh session. Authentication may need a supported
login/session handoff; external interactions currently pause for review. Email
inboxes, cloud drives and native desktop controls need dedicated integrations.
Scanned PDFs need OCR, and Office editing/recalculation is outside this version.

Next milestones should expand complete workflows: authentication and session
handoff, browser downloads, inbox/drive discovery, OCR for scanned invoices, then
additional native application tools. Evaluate each with successful, ambiguous,
duplicate and failed-save cases before claiming it works reliably.

## Repeat the checks

```bash
npm test
npm run test:e2e
npm run test:invoice:ai
```

The first two use fixtures without paid model calls. The last explicitly uses
the installed local Ollama model with a temporary practice app, verifies the
saved fields and unchanged source PDF, then removes its temporary data. It can
take several minutes and can fail if the local model makes a poor decision.
