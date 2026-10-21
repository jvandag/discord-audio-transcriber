# Optional weekly meeting reports

Reporting is disabled by default. It runs separately from local Whisper transcription.
You can choose OpenAI or Gemini. Only transcript text, internal speaker labels, speaker
names, template field instructions, and guidelines are sent to the selected provider.
Requests are built from an explicit allowlist: speaker ID/name and segment ID/speaker/text.
Whisper model, language, session/channel/Discord IDs, start/stop metadata, segment
timestamps, recording warnings, project settings, document URLs and email links are
excluded before any draft, extraction, repair or review request is built. The bot fills
the meeting date locally from the saved session time. Raw audio and previous log entries
are not sent. No tools are exposed to
the model. Ordinary bot code controls the Google Docs destination and append operation.

## Your two private Google Docs

Keep the live format URL in `REPORT_TEMPLATE_URL` and the separate weekly-log URL in
`REPORT_LOG_URL` in the gitignored `.env` file. Never put actual document URLs in the
public configuration, documentation, or example files. The links are not broadcast in
Discord channel messages; authorized report editors can retrieve the log link privately.

Every generation attempt fetches the current format from the template document. There
is no cached-format fallback. The exact text, fetch time, and available revision ID are
saved with the report. Editing the template affects the next generation, including an
explicit regeneration of a discarded draft. It does not rewrite existing reports.
A retry that only publishes an already-generated report reuses that saved report and
its template snapshot; it does not make another AI request.

The bot fills each `<instruction>` placeholder separately and retains every surrounding
heading, label, member, blank line and section in the fetched template. Native paragraph
styles, fonts, emphasis, standard nested bullets, hyperlinks and linked member names
are recreated in the weekly log. Repeated placeholder wording is safe: each occurrence
has its own field ID and context. Missing or duplicate fields fail validation instead
of publishing a shortened summary. The supplied paragraph-and-bullet template is
supported. Google person chips are rendered as their original display names with
mailto links, preserving the visible names and email destinations; Docs forbids
specifying the display name when inserting a new person chip. Embedded tables, images
and other unsupported structures cause a clear
error rather than silently losing formatting. Page-wide settings of the destination
document are not changed. Use placeholders such as:

```text
<Date of meeting/transcript> Meeting
Last Week (times in hours)
  Team Review
    <Summary of work discussed in the meeting>
  Member full name
    <Specific details and hours for this member>
Next week
  Team Plan
    <General plan, preserving any tentative wording>
Blocked
  Member full name
    <Specific blockers for this member>
```

Member names remain present even when no information is available. In a missing
member's Last Week field the bot inserts `Not present for meeting.` as the first
sentence, followed by any evidence-backed information reported about them by others.
Other empty member fields say `Not discussed`; unused Additional details stays blank.
Names are matched using exact names or unambiguous first-name/last-name abbreviations
(for example, Jeremiah V maps to Jeremiah Vandagrift). Use full transcript aliases
where abbreviated names could refer to multiple members. The absence wording reflects
this transcript participant mapping.

Both links must refer to different native Google Docs. A document with multiple tabs
requires `templateTabId` or `logTabId`, respectively. A `?tab=...` in either link also
selects its tab; an explicit config field takes precedence. Nested tabs are supported.

## Setup

### Which files to edit

| File                           | What belongs here                                                                                    | Required action                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.env` in the repository root  | All report setup: AI key, Google credential JSON, document links, model, server ID, and project name | Add all report values here. This file is ignored by Git.           |
| `config/bot.json`              | General transcription and bot settings                                                               | Leave reporting out of this tracked file.                          |
| `.env.example`                 | Empty variable names and format hints                                                                | Reference only. Do not put real credentials or links here.         |
| `config/reports/guidelines.md` | Report-writing rules                                                                                 | Already provided; change only if you want different writing rules. |

**Only `.env` needs reporting setup or credentials. No separate Google credential JSON file is required.**
The bot loads `config/bot.json` by default and reads `.env` from the directory where
you launch it, so run from the repository root. `BOT_CONFIG_PATH` in `.env` can select
a different configuration file if you deliberately choose one.

1. Open the existing private `.env` in the repository root. If it does not exist,
   copy `.env.example` to `.env` once. Do not overwrite an existing `.env`, and do not
   add secrets to either example file. Preserve existing `DISCORD_TOKEN`,
   `DISCORD_APPLICATION_ID`, and any `DISCORD_GUILD_ID` values.
2. Fill `GEMINI_API_KEY` **or** `OPENAI_API_KEY`, depending on your selected provider,
   and add your two actual Google Docs URLs. Fill `GOOGLE_CREDENTIALS_JSON` with the
   complete credential JSON obtained for the bot's Google identity:

   ```dotenv
   # Private .env only. These are placeholders, not working credentials.
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY
   REPORT_TEMPLATE_URL=https://docs.google.com/document/d/YOUR_TEMPLATE_ID/edit
   REPORT_LOG_URL=https://docs.google.com/document/d/YOUR_WEEKLY_LOG_ID/edit
   GOOGLE_CREDENTIALS_JSON='{"type":"service_account","client_email":"BOT@PROJECT.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"}'
   ```

   Use the actual downloaded JSON, not a handwritten key. Enclose the JSON in single
   quotes and preserve the `\n` escapes within its private-key string. A single line
   or a quoted multiline JSON value works. No separate credential file is needed.
   Keep `.env` private; do not paste credentials into chat or Discord.

   Alternatively, the existing `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/file.json`
   setting still works. If both are set, `GOOGLE_CREDENTIALS_JSON` takes precedence;
   invalid JSON fails instead of silently falling back to a different Google identity.
   `authorized_user` OAuth credential JSON with the Docs scope is also supported in
   `.env`; obtain it through a separate consent flow, not from a Gemini API key.

3. In that service account's Google Cloud project, enable the **Google Docs API**.
   Share the **template as Viewer** and the **weekly log as Editor** with the service
   account's email. No domain-wide delegation is required. If school sharing policy
   blocks service accounts, use authorized-user OAuth credentials permitted by the
   school. External OAuth apps left in Testing can have refresh tokens expire after
   seven days; configure the OAuth application's publishing status appropriately.
4. Add the report configuration to `.env`. Replace the server-ID placeholder with your
   numeric Discord server ID. Report models are independent of the local Whisper model;
   there is no automatic provider/model fallback.

   ```dotenv
   REPORTS_ENABLED=true
   REPORTS_PROVIDER=gemini
   REPORTS_MODEL=gemini-3.1-flash-lite
   REPORTS_GUILD_ID=YOUR_DISCORD_SERVER_ID
   REPORTS_PROJECT=Your project name
   ```

   `REPORTS_PROJECT` is optional. The template URL automatically comes from
   `REPORT_TEMPLATE_URL` and the log URL from `REPORT_LOG_URL`, both in the same
   private `.env` file. No report settings or URLs need to be added to `config/bot.json`.

5. By default, Manage Server permission is required for reporting. Add Discord role
   IDs to `allowedRoleIds` for other editors. All actions also check current access to
   the original transcript's channel; staying in voice is not required.
6. Restart the bot after changing configuration or credentials. From the repository
   root with Node 24, validate, register commands, build, and launch:

   ```bash
   export PATH="$PWD/.runtime/node_modules/.bin:$PATH"
   npm run doctor:reports
   npm run register
   npm run build
   npm start
   ```

The reporting doctor checks keys are present, the guidelines file, live template read
access, tab selection, and log revision access. It does not spend tokens, verify the
model with a live generation, or make a test append. The bot can start and record even
when optional report credentials are missing. Configured reports then fail with an
actionable status rather than interrupting transcription.

Google authentication in ChatGPT/Codex is **not** inherited by the standalone bot.
You must configure the bot's credentials separately.

### Optional report settings

The basic `.env` variables above configure one Discord server. You can also set
`REPORTS_PUBLICATION_MODE=review`, `REPORTS_ALLOWED_ROLE_IDS` as a comma-separated
list, `REPORTS_TIMEZONE`, or `REPORTS_TEMPLATE_TAB_ID` / `REPORTS_LOG_TAB_ID`.
The latter two require `REPORTS_GUILD_ID`. The full list is documented in
`.env.example`. Literal document URLs are never accepted in `config/bot.json`.

The legacy `reports` block in a custom `bot.json` is still recognized for an existing
deployment, but corresponding `REPORTS_*` values take precedence. New setups should
keep reporting entirely in `.env`.

## Use and review

After transcription finishes, the final attachment message shows **Generate report**
and a disclosure identifying the provider and the use of a private template and log.
One click queues generation, validation, and an append to the weekly log. A separate
status message shows progress and eventually a **View weekly report log** button.
The private response to a button click is a status snapshot; follow the report status
message in the transcript channel for ongoing progress and any errors.
That button checks the editor's permissions and replies privately with the link;
channel messages and button URLs do not reveal either document URL. Only the last part of a multipart
transcript has the button; the report always uses the entire saved transcript.

Set `publicationMode: "review"` to require **Preview report** and **Append reviewed
report** after a clean factuality check. An unresolved flagged factuality review never appends
automatically and cannot be overridden with Approve. Preview includes a text draft
and JSON with source quotes, segment IDs, review issues, template snapshot, and token
usage. Discard and regenerate after addressing issues; the template is fetched again.
Transcript snapshots are immutable, so a bad speech-recognition result cannot be
fixed by changing aliases or manually editing the old attachment. Such a report needs
manual correction outside this workflow or a new source recording.

Recovery commands all accept `session:<ID from the transcript message>`:

```text
/transcript report status session:...
/transcript report preview session:...
/transcript report retry session:...
/transcript report approve session:...
/transcript report discard session:...
/transcript report regenerate session:...
```

`retry` can also request a report for an older completed session. Repeated clicks
return the existing report; published reports cannot be regenerated or appended again.
Regeneration requires explicitly discarding an unpublished draft. Stale controls
from an earlier draft are rejected.

## Accuracy, limits, recovery, and retention

Report inputs freeze speaker names, segment text/timestamps, and recording warnings.
The AI must cite transcript evidence for each factual entry. Code validates
the schema, source IDs, evidence quotes, and attribution references. A separate AI
pass checks meaning, uncertainty, corrections, and template compliance. These checks
reduce errors; they do not guarantee factual accuracy or recover mistranscribed audio.
Evidence text comes from the frozen transcript. For a valid segment ID whose quoted
text was altered by the model, the bot uses that entire original segment as evidence;
the independent review still checks whether it supports the claim. Unknown IDs fail.
Invalid draft structure or evidence gets at most one correction attempt. A factuality
review with issues gets at most one correction pass followed by a fresh independent
review. All corrections must pass the same local evidence checks; unresolved review
issues still hold the draft without publication. Correction passes use additional API
requests and tokens, which are included in the saved usage.
Prose uses paraphrases, no direct quotations, and no em dashes. Missing fields are
explicitly marked Not discussed or Not specified.

Long transcripts use overlapping segment chunks, evidence-backed extraction, and a
consolidation/review pass. All chunks are included. The final review uses all extracted
facts and original cited segments with neighboring context. The worker rejects inputs
that still exceed `maxInputCharacters`, individual segments larger than a chunk, and
meetings needing more than 30 chunks. It never silently truncates. Character limits
are conservative application bounds, not exact provider token counts; configure them
for your model. Output truncation and provider refusals fail without publication.

One report worker serializes Google Docs publication. It reads the latest document,
checks a stable visible report identifier, and appends with a required revision ID.
Timeouts and crashes cause a reconciliation read before retrying, not a blind append.
New template-filled reports use an invisible Google Docs named range for duplicate
detection and contain no visible technical footer. Keep these named ranges intact.
Older reports retain their `[Meeting report ID: ...]` footer for reconciliation.
Confirmed Discord transcript parts are tracked, although a crash after Discord accepts
a message but before its ID is saved can still duplicate that Discord message.

Jobs, template snapshots, drafts, evidence, token counts, and publication status are
stored in `data/bot.sqlite`. They survive restarts and the cleanup of temporary session
files. As with existing recognized transcript text, these SQLite records currently
remain until deliberately removed by the operator; `retentionHours` only governs
session files. Saved jobs retain their resolved destinations for safe publication
retries, so this ignored local database is private too. Include it in your backup
and data-retention policy. Moving settings does not remove links from any older
Discord messages or previously published content; those require separate cleanup.

Transient request errors retry with backoff up to `maxAttempts`; other failures need
an explicit retry. Google publication retries reuse the saved report, provider,
template, and destination. A failed generation retried explicitly uses the current
configuration and freshly fetched template. Disabling reporting pauses pending report
work, and re-enabling it resumes saved jobs on restart. Run only one bot process per
database. SDK retries are disabled so the report queue owns retry limits. Review
token usage in the evidence download and set account-side budgets/limits as needed.

Gemini student/app access does not establish Developer API quota. Verify the actual
API project, model availability, free tier, and any developer credits. The unpaid
Gemini tier's data-use terms differ from paid API use and caution against submitting
sensitive, confidential, or personal content. Choose a tier suitable for your logs.

References: [OpenAI structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output),
[Gemini billing](https://ai.google.dev/gemini-api/docs/billing),
[Gemini data-use terms](https://ai.google.dev/gemini-api/terms),
[Google credentials](https://developers.google.com/workspace/guides/create-credentials),
[Google OAuth expiry](https://developers.google.com/identity/protocols/oauth2/),
[Docs revision control](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate).

## Live acceptance (not performed without credentials)

Use a disposable weekly log initially. Record a short meeting with a conditional
deadline, a suggestion, and a later correction. Generate a report and compare its
claims to the transcript. Edit the live template and generate for a second meeting;
confirm the new structure is used. Revoke template access and confirm no cached
format is used. Test review mode, permissions, double clicks, a restart during an
append, and restored log access after a failed upload. Confirm old log entries and
the template document remain intact and each report identifier occurs once.
