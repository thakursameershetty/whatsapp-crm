// AI assistant — turns a prompt (plus attached contact files) into answers and
// campaign plans, using tool use with Claude (Anthropic) or Gemini (Google).
//
// The model can only read. Its tools look at templates, numbers, stats and the
// attached files; the one that leads to sending, propose_campaign, only builds a
// plan. The plan is checked here, shown to the person as a card, and nothing is
// sent until they click Approve (POST /api/ai/plans/:id/approve).
//
// Conversations live in memory, keyed by a session id the browser holds, and are
// also saved to db.aiChats (a readable transcript, plus the model history so a chat
// can be picked up again later; attached files aren't saved). Each turn streams
// progress to the browser as newline-delimited JSON events.

const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI, ApiError: GeminiError } = require('@google/genai');

const CLAUDE_MODEL = 'claude-opus-5-5';
const MAX_STEPS = 30; // model calls per turn, a backstop against loops (combining many messy sheets takes a few)
const MAX_ROWS = 50000;
const SESSION_TTL = 6 * 3600 * 1000;
const MAX_SESSIONS = 40;
const MAX_CHATS = 100; // saved chats kept for the history list
const MAX_HISTORY_BYTES = 1500000; // larger model histories aren't saved (the transcript still is)

const SYSTEM = `You are the assistant inside a WhatsApp bulk-messaging dashboard (the "WhatsApp Sender" app). You help people in three ways:
1. Answer questions about this app, WhatsApp Business messaging, and how to get things done: setup, how each page works, why something failed, what to do next.
2. Report how their sending is going, using the stats tools.
3. Carry out sending tasks from contact lists they attach (CSV or Excel), always as a plan they approve first.

How tasks work here:
- You cannot send or change anything yourself. Your tools only read data. The one action is propose_campaign, which builds a plan. The server checks it and shows it to the person as a card: a "What will happen" explanation (your explanation field), the recipients and who is skipped and why, message previews, and a summary they can edit. Nothing goes out unless they click Approve.
- Plan first: work out every detail (file, template, numbers, variables, filters, opt-in, timing) before proposing. Explain the plan in the explanation field in plain words: what will be sent, to how many people, from which number, who is skipped and why, and what happens after approval. Don't repeat the whole plan as chat text; one short line pointing to the card is enough.
- Never say a message was sent, scheduled or queued unless a tool result says the person approved the plan.
- After you call propose_campaign or ask_user, stop and wait for the person.
- For other tasks (editing templates, adding numbers, changing settings, deleting or stopping campaigns, replying in the inbox), explain the exact steps for them to do it in the app.

Never guess:
- Every template, sender number, file column and value you use must come from a tool result in this conversation. Do not invent IDs, names, columns or numbers.
- Before proposing a campaign, call inspect_file on the file, list_templates and list_senders.
- If something needed is missing or ambiguous, call ask_user with concrete options taken from the real data. Ask when two or more reasonable choices exist, or when a wrong guess would send the wrong message to real people. Typical cases: no template named, or a name that matches none or several; several sender numbers and no hint which; a template variable with no clear column; several phone-like columns; numbers without a country code and no default code set; vague filters ("recent", "active") with no matching column; opt-in values you can't interpret.
- When the choice is clear (one sender number, a column literally named for the variable, the person's composer selection), go ahead without asking, and write the inference into propose_campaign's assumptions so the person can check it.
- Ask one question at a time.
- Never invent values the person hasn't given you: offer amounts, discount codes, dates, links, image URLs. Don't offer made-up examples as options either. Ask with ask_user and no options so they type the exact value, and use it word for word.
- For questions about the person's own setup or data, check with a tool (get_app_status, list_senders, list_templates, list_campaigns, get_stats) rather than assuming. If the guide below doesn't cover something and no tool can tell you, say you're not sure rather than making it up.

Saved contacts: to send to people saved on the Contacts page (for example "all clients" or "everyone tagged designers"), call use_contacts with the tag names from the context block; it attaches them as a sheet with a file_id and phone column "phone". If a tag the person mentions doesn't exist, ask which of the real tags they mean.

Several files and sheets: each sheet of an Excel workbook is attached as its own file (its name shows the workbook and sheet). Inspect every sheet that might be relevant. If the person says which sheets, use those; if they say "this file" and the workbook has several sheets with contacts, ask whether to use all of them or which ones. Put every chosen sheet in propose_campaign's sources, each with its own phone column.

Consent: if the file has an opt-in / consent / subscription column, always apply it with propose_campaign's opt_in. If you can't tell which values mean "opted in", ask. When you combine sheets and some lack that column, their rows are skipped: before proposing, ask the person whether the people in those sheets opted in, and set include_sheets_without_column only if they say yes. Either way, say in the explanation what happens to those sheets.

Cleaning and combining sheets: when the person wants their files tidied, merged or reformatted into one sheet (for example "combine these lead sheets into Name, Phone, City, Source", or just "clean these up for sending"):
1. Read everything first, and take your time. Call inspect_file on every sheet, then peek_rows wherever the shape isn't obvious: headers that look wrong or missing, junk rows at the top, notes, totals or blank rows, a name and number in one cell, numbers in mixed formats, the same field named differently in each sheet. Look at every sheet before building. Things to look for and handle in the recipe:
   - Sheets with no header row (columns named "Column A", "Column B"…): work out what each column holds from peek_rows and refer to them by letter.
   - Test or dummy rows (Meta's "<test lead: dummy data…>"), totals, sub-headings, notes and blank rows: filter them out with where.
   - Notes stuck to values, like "Mohamed(4pm)" or "Kiran (ref)": strip_brackets, and keep the note in a notes column if there is one.
   - Numbers with prefixes or punctuation ("p:+91…", "91-98765…", "098765…"): the phone transform handles these. A name and number in one cell: split or extract.
   - The same field with different names in each sheet (phone_number, Contact Phone Number, Mobile No.): map each one.
   - Codes instead of words (CREATED, y/n, short city names): map them to readable values when the person would want that.
   - Rows that were shifted a few columns to the right are fixed when the file is attached (the context block says how many); mention it in your reply.
2. Decide the output columns: exactly the ones the person asked for, in their order and their wording. If they didn't say, pick the useful ones for sending (always a phone column, then name, plus what their templates' variables need) and say what you chose. Ask with ask_user only when it's genuinely unclear.
3. Call build_sheet with a recipe for every sheet: for each output column, which source column(s) it comes from in that sheet and how to clean it. The server applies the recipe to every row, so never copy or retype data yourself. Never invent values that aren't in the files; leave a cell empty instead.
4. Check the result it returns (sample rows, empty cells per column, dropped rows). If something looks wrong, call build_sheet again with the same name and a fixed recipe; it replaces the earlier version.
5. Then reply in 2 to 4 short lines: what you combined, what you cleaned, and what was dropped and why. The card already shows the table with "Open in Send" and "Download", so don't list the rows. If they want to send to it, carry on with propose_campaign using the new sheet's file_id.

If propose_campaign returns problems, fix what you can from the data. If fixing needs a decision from the person, ask.

Template variables: a template lists variables with keys like "body.1" or "header.media". Map each one to a file column or a fixed value. A media header needs a fixed https URL typed by the person; ask for it (no options) if you don't have one. The server rejects URLs the person didn't type.

Stats questions: use get_stats and list_campaigns, then answer briefly with the numbers. The dashboard shows the stats you fetched as a card, so don't repeat every figure.

Style: short and plain. A sentence or two before a tool call is fine. For how-to answers, give numbered steps naming the exact page, button and field. Use simple bullet lists when listing things. No headings.

Tone: warm, with a light sense of humour, about one reply in ten. When it fits, add a single brief, good-natured line: a wry aside about spreadsheets, a nod to a nice result, a gentle joke about a typo-filled column name. Keep it short and never at the person's expense. The answer comes first and stays complete; the humour is a garnish. No jokes in plans, failure explanations, opt-out or consent questions, anything about money or sensitive topics, or when the person seems stressed or something went wrong. Don't force it or repeat the same joke, and skip it entirely if unsure.

<app_guide>
Pages (left sidebar; it can be collapsed to icons with the button next to the app name):
- Overview: dashboard for the last 7/14/30/90 days, filterable by number and template. Messages sent, delivery rate, read rate and failures with trends; a messages-per-day chart (click to expand, or switch to a table); sent → delivered → read funnel; each number's usage today against its daily limit and its quality rating; upcoming scheduled sends; recent campaigns; a setup checklist until live. "Load demo workspace" adds sample numbers, templates, campaigns and chats (demo mode only); "Remove demo data" deletes only those samples.
- Assistant: this chat. Attach a file with the paperclip (or drag it in); a preview window shows rows, valid / invalid / duplicate numbers, and lets the person change the phone column. The chip next to the paperclip picks which number to send from.
- Inbox: customer replies, laid out like WhatsApp. Free-form text replies are allowed only within 24 hours of the customer's last message (the chat header shows the time left); after that use "Send template" at the bottom of the chat. New chat (pencil icon): enter a phone number and pick a sender number; the first message must be a template. Filters: All, Unread, Can reply, and by number. Opening a chat sends blue ticks. Replies arrive through the webhook, so it must be set up.
- Send: the manual way to send a campaign. 1) Upload or drag a CSV/TSV/Excel file, or paste rows (first row can be column names). 2) The table can be sorted (click a heading), filtered (each column has a filter; in text filters "!text" = doesn't contain, "=text" = exact, ">30" / "<=5" for numbers) and rows selected (click; Shift+click selects a range; "Select all filtered"). Only ticked rows are sent; invalid numbers can't be ticked; duplicates are flagged. 3) Pick the phone column, the template and the sender numbers (toggles). 4) Map each template variable to a column or a fixed value; a live preview shows the message. 5) "Send test" sends one message to your own number. 6) Send now, or switch to Schedule and pick a date and time. A split view puts the table and setup side by side on wide screens.
- Campaigns: every campaign with status (queued, running, completed, stopped, scheduled, cancelled) and progress. Open one to see each recipient's status and error. Stop a running campaign; Resume it; retry the failed ones; Export CSV; Send now or Cancel a scheduled one; delete a finished one.
- Numbers: add each WhatsApp business number with a label, Phone number ID, WhatsApp Business Account (WABA) ID and a permanent access token. "Test connection" checks the credentials and loads the verified name, quality rating and messaging limit. Numbers can be edited, turned off or deleted. A blank token when editing keeps the saved one.
- Templates: "Sync from Meta" pulls templates from every WABA that has a number with a token. "Add template" defines one by hand (name, language, category, optional header text/image/video/document, body with {{1}} or {{name}} variables, footer, URL buttons); hand-added templates show status MANUAL and can't be sent in live mode because Meta hasn't approved them. Only APPROVED templates send; PENDING and REJECTED ones don't.
- Settings: Demo mode (on = sending is simulated, nothing reaches WhatsApp; turning it off asks for confirmation); default country code added to 10-digit numbers (91 by default); Graph API version; parallel sends per number and delay between sends (speed); webhook Callback URL and Verify token; the AI assistant's Anthropic API key.

Getting live (WhatsApp Cloud API credentials):
1. developers.facebook.com/apps → create an app of type Business → add the WhatsApp product.
2. WhatsApp → API Setup: add and verify each business phone number; copy each number's Phone number ID and the WhatsApp Business Account ID.
3. Permanent token: Business Settings → Users → System users → add a system user → assign the app and the WhatsApp account with full control → Generate token with whatsapp_business_messaging and whatsapp_business_management. The temporary token on the API Setup page expires within a day.
4. Create templates in WhatsApp Manager → Message templates and wait for approval.
5. In this app: Numbers → Add number, Test connection; Templates → Sync from Meta; Settings → turn Demo mode off.

Webhook (needed for delivered / read / failed status and for the Inbox): in the Meta App Dashboard → WhatsApp → Configuration, set the Callback URL to https://YOUR-DOMAIN/webhook and the Verify token from Settings, then subscribe to the "messages" field. It must be a public HTTPS address: deploy the app (Render, Railway, a VPS) or use a tunnel such as ngrok or cloudflared while testing. A quick tunnel's URL changes every restart, so the Callback URL has to be updated each time. Without a webhook, messages still send but stay at "sent".

How sending works: recipients are split evenly across the selected numbers, each number sends in parallel, and Meta rate-limit errors are retried with backoff. A scheduled campaign needs the server running at that time; if it was off, it sends as soon as the server starts again. Campaigns made in demo mode stay simulated.

WhatsApp rules: business-initiated conversations need an approved template. Each number has a daily limit on unique recipients (new numbers about 250/day, rising to 1K, 10K, 100K and unlimited with good quality). Only message people who opted in; blocks and reports lower the quality rating and can get a number restricted. Meta charges per template message by category and country. A template can only be sent from a number whose business account has access to it.

Common errors and fixes:
- Code 190 / "Authentication Error" / token expired: paste a new permanent system-user token under Numbers (edit the number).
- "(#10) ... cannot access the provided Paid Message Account" or permission errors: the system user needs full access to both the WhatsApp account that holds the number and the account that holds templates and billing (Business settings → WhatsApp accounts / Messaging accounts → assign the system user with full control), then generate a new token.
- 132001 template does not exist: the name or language doesn't match an approved template in that account; sync templates again and check the language.
- 132000 / 132012 parameter mismatch: the number or format of variables doesn't match the template; check the variable mapping.
- 131026 message undeliverable: the number isn't on WhatsApp or can't receive it.
- 131047 re-engagement: more than 24 hours since the customer's last message; send a template instead of free text.
- 131049: Meta chose not to deliver a marketing message to keep engagement healthy; don't retry right away.
- 130429 / 131056 rate limits: sending too fast or too often to one number; the app retries, or lower the speed in Settings.
- Messages stuck on "sent": the webhook isn't set up or isn't reachable.
</app_guide>`;

const TOOLS = [
  {
    name: 'list_templates',
    description: 'List the message templates available in the dashboard, with their ID, status, language, the variables each needs, and whether it can be used right now.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_senders',
    description: "List the WhatsApp sender numbers connected to the dashboard: ID, label, phone, whether enabled, WABA ID, quality rating, daily limit and how many were sent today.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'inspect_file',
    description: "Read an attached contact file: its columns (with fill counts, how many cells look like phone numbers, and the distinct values of low-variety columns), the first rows, a phone-number check, and any opt-in style columns. Also says which phone column the person picked in the preview, if any.",
    input_schema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'ID of the attached file, from the context block' } },
      required: ['file_id'],
    },
  },
  {
    name: 'peek_rows',
    description: "Read more rows of an attached sheet than inspect_file shows (phone numbers are partly hidden). Use it to understand messy sheets before building a clean one: header rows, junk rows, mixed formats, several values in one cell.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' },
        start: { type: 'integer', minimum: 1, description: 'First row to read (1 = the first data row). Default 1.' },
        count: { type: 'integer', minimum: 1, maximum: 60, description: 'How many rows. Default 30.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns (default all)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'build_sheet',
    description: "Build one clean sheet from one or more attached sheets, from a recipe: the output columns, and for each source sheet where each output column comes from and how to clean it. The server applies it to every row (you never copy data), drops rows without a valid phone number, merges duplicate numbers, and shows the person the result as a card with Open in Send and Download. Returns a sample of the result so you can check it, plus a new file_id usable in propose_campaign. Calling it again with the same name replaces the earlier version.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the new sheet, e.g. "Leads – combined"' },
        columns: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Output column names, in order, exactly as the person wants them' },
        phone_column: { type: 'string', description: 'Which output column holds the WhatsApp number (normalised to +countrycode…)' },
        sources: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              file_id: { type: 'string' },
              skip_first_rows: { type: 'integer', minimum: 0, description: 'Junk rows at the top to ignore (titles, notes)' },
              where: {
                type: 'array',
                description: 'Only use rows matching all of these (columns of this source)',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string' },
                    op: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'not_empty', 'greater_than', 'less_than', 'matches'] },
                    value: { type: 'string', description: 'For matches: a regular expression' },
                  },
                  required: ['column', 'op'],
                },
              },
              fields: {
                type: 'array',
                description: 'One entry per output column you can fill from this source; columns left out stay empty for its rows',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string', description: 'Output column name' },
                    from: { type: 'array', items: { type: 'string' }, description: 'Source column(s) of this sheet. Several are joined with sep. A column can also be given by letter, e.g. "C".' },
                    sep: { type: 'string', description: 'Joins several source columns. Default a space.' },
                    fixed: { type: 'string', description: 'The same text for every row of this source instead of a column (e.g. the source name "Facebook ads")' },
                    split: { type: 'string', description: 'Split the value on this text and keep one part (e.g. " - " for "Ravi - 98765…")' },
                    part: { type: 'integer', description: 'Which part after split: 0 = first, 1 = second, -1 = last. Default 0.' },
                    extract: { type: 'string', description: 'Regular expression; keeps the first group (or the whole match). E.g. "(\\+?\\d[\\d\\s-]{8,})" for a number inside text.' },
                    transform: { type: 'array', items: { type: 'string', enum: ['title_case', 'upper', 'lower', 'sentence_case', 'first_word', 'last_word', 'digits_only', 'phone', 'email', 'number', 'date', 'strip_emoji', 'strip_punctuation', 'strip_brackets'] }, description: 'Applied in order, after split/extract. Spaces are always tidied.' },
                    map: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }, description: 'Replace whole values (case-insensitive), e.g. Y → Yes, blr → Bengaluru' },
                    default: { type: 'string', description: 'Used when the result is empty' },
                  },
                  required: ['column'],
                },
              },
            },
            required: ['file_id', 'fields'],
          },
        },
        dedupe_by_phone: { type: 'boolean', description: 'Merge rows with the same number into one, filling its empty cells from the others. Default true.' },
        keep_rows_without_phone: { type: 'boolean', description: "Keep rows with no valid number (they can't be sent to). Default false." },
        sort_by: { type: 'object', properties: { column: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] },
        summary: { type: 'string', description: 'One or two plain sentences for the card: what was combined and cleaned' },
      },
      required: ['name', 'columns', 'phone_column', 'sources', 'summary'],
    },
  },
  {
    name: 'get_stats',
    description: 'Get sending stats for a period: totals for sent, delivered, read, failed, the previous period for comparison, per-number usage, and recent and upcoming campaigns. The dashboard shows the result to the person as a card.',
    input_schema: {
      type: 'object',
      properties: {
        range_days: { type: 'integer', enum: [7, 14, 30, 90], description: 'Length of the period, ending today. Default 14.' },
        sender_id: { type: 'string', description: 'Only count this sender number (ID from list_senders)' },
        template_name: { type: 'string', description: 'Only count campaigns using this template name' },
      },
    },
  },
  {
    name: 'use_contacts',
    description: 'Attach saved contacts from the Contacts page as a sheet, chosen by tag and optionally lead status. People who opted out are never included. Returns the new sheet (with its file_id) like inspect_file, ready for propose_campaign.',
    input_schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names; contacts with any of them. Leave empty for everyone.' },
        statuses: { type: 'array', items: { type: 'string', enum: ['new', 'interested', 'qualified', 'won', 'lost'] }, description: 'Only contacts with these lead statuses' },
      },
    },
  },
  {
    name: 'get_app_status',
    description: "Check the dashboard's setup: demo or live mode, settings (country code, Graph API version, send speed), how many numbers have tokens and when they were last checked, templates by status, whether the webhook is receiving anything, and the setup checklist. Use it for questions about the person's own setup or troubleshooting.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description: 'List recent campaigns, newest first, with their status, recipient count and delivery numbers.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'How many to return. Default 10.' } },
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the person one question and wait for the answer. Use it whenever something needed is missing or ambiguous instead of guessing. When the choices exist in the real data (templates, numbers, columns, column values), give 2 to 6 of them as options; the person can also type their own answer. When the answer is a value only the person knows (a URL, an offer, a code, a date), give no options so they type it.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in one or two short sentences' },
        options: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short button text' },
              description: { type: 'string', description: 'Optional one-line detail shown under the label' },
            },
            required: ['label'],
          },
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'propose_campaign',
    description: "Build a campaign plan from an attached file and show it to the person for approval. Nothing is sent until they approve. The server checks everything (template usable, numbers valid, every variable mapped, columns exist) and returns problems to fix if any. Only call this once you have inspected the file and listed templates and senders.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short campaign name' },
        sources: {
          type: 'array',
          minItems: 1,
          description: 'The attached sheets to send to, each with the column holding its phone numbers. Every sheet of an Excel file is attached separately with its own file_id. Rows from all of them are combined; a number in several sheets gets one message; columns are matched by name.',
          items: {
            type: 'object',
            properties: { file_id: { type: 'string' }, phone_column: { type: 'string' } },
            required: ['file_id', 'phone_column'],
          },
        },
        template_id: { type: 'string', description: 'Template ID from list_templates' },
        sender_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Sender number IDs from list_senders; recipients are spread across them' },
        mapping: {
          type: 'array',
          description: 'One entry per template variable',
          items: {
            type: 'object',
            properties: {
              variable: { type: 'string', description: 'Variable key from list_templates, e.g. body.1' },
              source: { type: 'string', enum: ['column', 'fixed'] },
              value: { type: 'string', description: 'Column name, or the fixed text/URL' },
            },
            required: ['variable', 'source', 'value'],
          },
        },
        filters: {
          type: 'array',
          description: 'Only include rows matching all of these',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'not_empty', 'greater_than', 'less_than'] },
              value: { type: 'string', description: 'Comparison value (not needed for is_empty / not_empty)' },
            },
            required: ['column', 'op'],
          },
        },
        opt_in: {
          type: 'object',
          description: 'Skip rows that have not opted in',
          properties: {
            column: { type: 'string' },
            allowed_values: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Values that mean opted in, e.g. ["yes", "y", "true"]; compared case-insensitively' },
            include_sheets_without_column: { type: 'boolean', description: 'Only true if the person confirmed that everyone in the chosen sheets that lack the opt-in column has opted in. Otherwise those rows are skipped.' },
          },
          required: ['column', 'allowed_values'],
        },
        exclude_contacted_within_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Skip numbers any campaign already messaged within this many days' },
        schedule_at: { type: 'string', description: 'ISO 8601 date-time to send at; omit to send right after approval' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'Every inference you made that the person should check, in plain words' },
        explanation: { type: 'string', description: 'Shown at the top of the plan card under "What will happen": 2 to 5 short plain sentences on what will be sent, to how many people, from which number, who is skipped and why, and what happens after approval. Refer to the preview below it where useful.' },
      },
      required: ['name', 'sources', 'template_id', 'sender_ids', 'mapping', 'assumptions', 'explanation'],
    },
  },
];

const PAUSING = new Set(['ask_user', 'propose_campaign']);

const STEP_LABELS = {
  list_templates: ['searching', 'Checking your templates'],
  list_senders: ['searching', 'Checking your numbers'],
  inspect_file: ['searching', 'Reading the file'],
  get_stats: ['searching', 'Looking at your stats'],
  list_campaigns: ['searching', 'Looking at your campaigns'],
  get_app_status: ['searching', 'Checking your setup'],
  use_contacts: ['searching', 'Getting your contacts'],
  peek_rows: ['searching', 'Reading more rows'],
  build_sheet: ['working', 'Building the clean sheet'],
  propose_campaign: ['working', 'Checking the plan'],
};

// --- Model providers -------------------------------------------------------
// Each provider keeps the conversation in its own API's format (thinking blocks,
// Gemini thought signatures and the like must go back exactly as received) and
// turns every reply into the same shape: { texts, calls: [{ id, name, input }] }.
// Tool results come back as { id, name, content, isError }.

// `system` and `tools` default to the Assistant's; the Inbox lead assistant passes its own.
function claudeProvider(key, { system = SYSTEM, tools = TOOLS } = {}) {
  const api = new Anthropic({ apiKey: key });
  return {
    label: 'Claude Opus 5.5',
    addUser(history, { results, text }) {
      history.push({
        role: 'user',
        content: [
          ...results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
          { type: 'text', text },
        ],
      });
    },
    async step(history) {
      const response = await api.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system,
        tools,
        messages: history,
      });
      if (response.stop_reason === 'refusal') return { refused: true, texts: [], calls: [] };
      history.push({ role: 'assistant', content: response.content });
      const calls = response.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return {
        texts: response.content.filter((b) => b.type === 'text').map((b) => b.text),
        calls,
        truncated: response.stop_reason === 'max_tokens' && calls.length > 0,
      };
    },
  };
}

const geminiTools = (tools) => [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }];
const GEMINI_BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiProvider(key, model, newId, { system = SYSTEM, tools = TOOLS } = {}) {
  const ai = new GoogleGenAI({ apiKey: key });
  const config = { systemInstruction: system, tools: geminiTools(tools), automaticFunctionCalling: { disable: true } };
  const unnamed = new Set(); // calls Gemini sent without an id: their responses go back without one too
  const asObject = (content) => {
    try {
      const v = JSON.parse(content);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : { output: v };
    } catch {
      return { output: content };
    }
  };
  return {
    label: model,
    addUser(history, { results, text }) {
      history.push({
        role: 'user',
        parts: [
          ...results.map((r) => ({ functionResponse: { ...(unnamed.has(r.id) ? {} : { id: r.id }), name: r.name, response: r.isError ? { error: r.content } : asObject(r.content) } })),
          { text },
        ],
      });
    },
    async step(history, { onRetry } = {}) {
      let res;
      // The free tier allows only a few requests a minute: wait out short limits instead of failing the turn.
      for (let attempt = 0; ; attempt++) {
        try {
          res = await ai.models.generateContent({ model, contents: history, config });
          break;
        } catch (e) {
          const retryable = e instanceof GeminiError && (e.status === 429 || e.status === 503 || e.status === 500);
          const daily = /per.?day/i.test(e.message || '');
          const wait = Number((e.message || '').match(/"retryDelay":\s*"(\d+)/)?.[1]) || [5, 15, 30][attempt];
          if (!retryable || daily || attempt >= 3 || wait > 60) throw e;
          onRetry?.(wait, attempt);
          await sleep(wait * 1000);
        }
      }
      const cand = res.candidates?.[0];
      if (!cand?.content?.parts?.length) {
        if (GEMINI_BLOCKED.has(cand?.finishReason) || res.promptFeedback?.blockReason) return { refused: true, texts: [], calls: [] };
        return { texts: [], calls: [] };
      }
      history.push(cand.content);
      const calls = cand.content.parts.filter((p) => p.functionCall).map(({ functionCall: fc }) => {
        const cid = fc.id || 'call_' + newId();
        if (!fc.id) unnamed.add(cid);
        return { id: cid, name: fc.name, input: fc.args || {} };
      });
      return {
        texts: cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text),
        calls,
        truncated: cand.finishReason === 'MAX_TOKENS' && calls.length > 0,
      };
    },
  };
}

module.exports = function mountAi(app, ctx) {
  const { db, save, id, wrap, fail, aiConfig, contacts, normalizePhone, templateVariables, createCampaign, computeStats, summary } = ctx;
  const wsId = ctx.wsId || (() => null); // sessions and plans belong to one workspace
  db.aiChats ||= [];
  const chatById = (cid) => db.aiChats.find((c) => c.id === cid);

  const sessions = new Map();
  const plans = new Map(); // planId -> plan (also referenced from its session)

  function prune() {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.updatedAt > SESSION_TTL && !s.busy) dropSession(sid);
    const extra = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.updatedAt - b.updatedAt);
    while (sessions.size > MAX_SESSIONS && extra.length) dropSession(extra.shift().id);
  }
  function dropSession(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    for (const pid of s.planIds) plans.delete(pid);
    sessions.delete(sid);
    providers.delete(sid);
  }
  function getSession(sid, create = true) {
    let s = sid && sessions.get(sid);
    if (s && s.ws !== wsId()) s = null; // another workspace's conversation
    // A saved chat that isn't in memory (server restarted, or it timed out): pick it up again.
    const saved = !s && sid && chatById(sid);
    if (saved) {
      prune();
      s = { id: saved.id, ws: wsId(), provider: saved.provider, history: structuredClone(saved.history || []), said: [...(saved.said || [])], files: new Map(), planIds: [], pending: null, busy: false, updatedAt: Date.now(), restored: true };
      sessions.set(s.id, s);
    }
    if (!s && sid && !create) throw fail('This conversation has expired. Start a new one.', 410);
    if (!s) {
      prune();
      s = { id: id(), ws: wsId(), provider: aiConfig().provider, history: [], said: [], files: new Map(), planIds: [], pending: null, busy: false, updatedAt: Date.now() };
      sessions.set(s.id, s);
    }
    s.updatedAt = Date.now();
    return s;
  }

  // --- Reading data --------------------------------------------------------

  const looksLikePhone = (v) => /^\+?[\d\s\-().]{8,}$/.test(String(v).trim());
  const OPT_IN_RE = /opt|consent|subscri|permission|agree|allow|marketing|dnd|unsub|whatsapp.?ok/i;

  function templateInfo(t) {
    const usable = templateUsable(t);
    const body = (t.components || []).find((c) => (c.type || '').toUpperCase() === 'BODY');
    const header = (t.components || []).find((c) => (c.type || '').toUpperCase() === 'HEADER');
    return {
      id: t.id,
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      waba_id: t.wabaId || null,
      header: header ? (header.format === 'TEXT' ? { format: 'TEXT', text: header.text } : { format: header.format }) : null,
      body: body?.text || '',
      variables: templateVariables(t.components).map((v) => ({ key: v.key, label: v.media ? `header ${v.media} URL` : `${v.where} {{${v.name}}}` })),
      usable: usable.ok,
      ...(usable.ok ? {} : { not_usable_because: usable.reason }),
    };
  }

  function templateUsable(t) {
    if (t.status === 'APPROVED') return { ok: true };
    if (t.status === 'MANUAL') return db.settings.demoMode ? { ok: true } : { ok: false, reason: 'Added by hand, not synced from Meta, so Meta has not approved it. Sync templates or use demo mode.' };
    return { ok: false, reason: `Status is ${t.status}; only approved templates can be sent` };
  }

  function sentTodayBySender() {
    const today = new Date().toLocaleDateString('en-CA');
    const out = {};
    for (const c of db.campaigns) {
      if (Boolean(c.demo) !== db.settings.demoMode) continue;
      for (const r of c.recipients) if (r.sentAt && new Date(r.sentAt).toLocaleDateString('en-CA') === today) out[r.senderId] = (out[r.senderId] || 0) + 1;
    }
    return out;
  }

  const TIERS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: 'unlimited' };

  function senderInfo(s, today) {
    return {
      id: s.id,
      label: s.label,
      phone: s.displayPhone || null,
      enabled: s.enabled !== false,
      has_access_token: Boolean(s.accessToken),
      waba_id: s.wabaId || null,
      quality_rating: s.qualityRating || null,
      daily_limit: TIERS[s.messagingLimit] ?? null,
      sent_today: today[s.id] || 0,
    };
  }

  // The model never needs full phone numbers to understand a file: keep the shape, hide the middle digits.
  const maskPhones = (v) => {
    if (!looksLikePhone(v)) return v;
    let seen = 0;
    const total = String(v).replace(/\D/g, '').length;
    return String(v).replace(/\d/g, (d) => (++seen <= 2 || seen > total - 2 ? d : '•'));
  };

  function inspectFile(session, fileId) {
    const f = session.files.get(fileId);
    if (!f) throw new Error(`No attached file with id "${fileId}". Attached: ${[...session.files.keys()].join(', ') || 'none'}`);
    const columns = f.headers.map((h) => {
      const vals = f.rows.map((r) => String(r[h] ?? '').trim());
      const filled = vals.filter(Boolean);
      const counts = new Map();
      for (const v of filled) counts.set(v, (counts.get(v) || 0) + 1);
      const col = { name: h, filled: filled.length, phone_like: filled.filter((v) => { const d = v.replace(/\D/g, '').length; return d >= 10 && d <= 15; }).length, distinct: counts.size, examples: [...counts.keys()].slice(0, 3).map(maskPhones) };
      if (counts.size && counts.size <= 12) col.values = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => [maskPhones(v), n]));
      return col;
    });
    const phoneCol = f.phoneColumn || columns.slice().sort((a, b) => b.phone_like - a.phone_like)[0]?.name;
    const cc = db.settings.defaultCountryCode || '';
    let valid = 0, invalid = 0, duplicates = 0, tenDigit = 0;
    const seen = new Set();
    for (const r of f.rows) {
      const raw = String(r[phoneCol] ?? '').replace(/\D/g, '').replace(/^00/, '');
      if (raw.length === 10) tenDigit++;
      const p = normalizePhone(r[phoneCol]);
      if (!p) invalid++;
      else if (seen.has(p)) duplicates++;
      else { seen.add(p); valid++; }
    }
    return {
      file_id: f.id,
      name: f.name,
      ...(f.sheet ? { sheet: f.sheet } : {}),
      rows: f.rows.length,
      columns,
      first_rows: f.rows.slice(0, 5).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskPhones(v)]))),
      note_on_privacy: 'Phone numbers are partly hidden here; the server uses the full numbers when it builds the plan.',
      phone_column_picked_by_person: f.phoneColumn || null,
      phone_check: {
        column: phoneCol,
        valid,
        invalid,
        duplicates,
        ten_digit_numbers: tenDigit,
        note: cc ? `10-digit numbers get the default country code +${cc} added automatically.` : 'No default country code is set, so 10-digit numbers count as invalid.',
      },
      opt_in_like_columns: f.headers.filter((h) => OPT_IN_RE.test(h)),
    };
  }

  // --- Reading more rows, and building one clean sheet from a recipe ------------------------

  const fileOrThrow = (session, fileId) => {
    const f = session.files.get(fileId);
    if (!f) throw new Error(`No attached file with id "${fileId}". Attached: ${[...session.files.keys()].join(', ') || 'none'}`);
    return f;
  };
  // A source column by name, or by spreadsheet letter ("C") when names are unhelpful.
  const colLetter = (i) => { let n = i + 1, out = ''; while (n) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); } return out; };
  function resolveCol(f, name) {
    const n = String(name ?? '');
    if (f.headers.includes(n)) return n;
    const ci = f.headers.find((h) => h.toLowerCase().trim() === n.toLowerCase().trim());
    if (ci) return ci;
    const byLetter = f.headers.findIndex((_, i) => colLetter(i) === n.toUpperCase());
    if (/^[A-Z]{1,2}$/i.test(n) && byLetter >= 0) return f.headers[byLetter];
    return null;
  }

  function peekRows(session, input) {
    const f = fileOrThrow(session, input.file_id);
    const start = Math.max(1, input.start || 1), count = Math.min(60, Math.max(1, input.count || 30));
    const cols = input.columns?.length ? input.columns.map((c) => resolveCol(f, c)).filter(Boolean) : f.headers;
    return {
      file_id: f.id, name: f.name, total_rows: f.rows.length,
      columns: cols.map((h) => ({ name: h, letter: colLetter(f.headers.indexOf(h)) })),
      rows: f.rows.slice(start - 1, start - 1 + count).map((r, i) => ({ row: start + i, ...Object.fromEntries(cols.map((h) => [h, maskPhones(r[h] ?? '')])) })),
      note_on_privacy: 'Phone numbers are partly hidden; build_sheet works on the full numbers.',
    };
  }

  const titleCase = (v) => v.toLowerCase().replace(/(^|[\s\-'’(./])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function toDate(v) {
    const t = String(v).trim();
    if (/^\d{5}(\.\d+)?$/.test(t)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86400000); return d.toISOString().slice(0, 10); } // Excel serial day
    let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); // day first, as written in India and the UK
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    m = t.match(/^(\d{1,2})\s*([a-z]{3,4})[a-z]*[\s,-]*(\d{2,4})/i);
    if (m && MONTHS[m[2].toLowerCase()]) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    return t;
  }
  const TRANSFORMS = {
    title_case: titleCase,
    upper: (v) => v.toUpperCase(),
    lower: (v) => v.toLowerCase(),
    sentence_case: (v) => v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(),
    first_word: (v) => v.split(/\s+/)[0] || '',
    last_word: (v) => v.split(/\s+/).at(-1) || '',
    digits_only: (v) => v.replace(/\D/g, ''),
    phone: (v) => { const p = normalizePhone(v); return p ? '+' + p : ''; },
    email: (v) => { const m = v.toLowerCase().match(/[^\s@<>,;:]+@[^\s@<>,;:]+\.[a-z]{2,}/); return m ? m[0] : ''; },
    number: (v) => { const n = v.replace(/[^\d.\-]/g, ''); return n && !Number.isNaN(Number(n)) ? String(Number(n)) : ''; },
    date: toDate,
    strip_emoji: (v) => v.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ''),
    strip_punctuation: (v) => v.replace(/[^\p{L}\p{N}\s+@.\-]/gu, ''),
    strip_brackets: (v) => v.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' '), // "Mohamed(4pm)" → "Mohamed"
  };
  const tidy = (v) => String(v ?? '').replace(/[\u00a0\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const regexOf = (src, what) => { try { return new RegExp(src, 'i'); } catch (e) { throw new Error(`${what}: "${src}" isn't a valid regular expression (${e.message})`); } };

  function fieldValue(f, row, fd) {
    let v;
    if (fd.fixed != null) v = String(fd.fixed);
    else {
      const parts = (fd.from || []).map((c) => tidy(row[resolveCol(f, c)] ?? '')).filter(Boolean);
      v = parts.join(fd.sep ?? ' ');
    }
    v = tidy(v);
    if (v && fd.split) { const bits = v.split(fd.split).map(tidy); const k = fd.part ?? 0; v = (k < 0 ? bits[bits.length + k] : bits[k]) ?? ''; }
    if (v && fd.extract) { const m = v.match(regexOf(fd.extract, `extract for "${fd.column}"`)); v = m ? tidy(m[1] ?? m[0]) : ''; }
    for (const t of fd.transform || []) if (v && TRANSFORMS[t]) v = tidy(TRANSFORMS[t](v));
    if (v && fd.map?.length) { const hit = fd.map.find((m) => String(m.from).toLowerCase().trim() === v.toLowerCase()); if (hit) v = String(hit.to); }
    if (!v && fd.default != null) v = String(fd.default);
    return v;
  }
  const passesWhere = (f, row, w) => {
    const v = tidy(row[resolveCol(f, w.column)] ?? ''), x = String(w.value ?? ''), lv = v.toLowerCase(), lx = x.toLowerCase();
    switch (w.op) {
      case 'equals': return lv === lx;
      case 'not_equals': return lv !== lx;
      case 'contains': return lv.includes(lx);
      case 'not_contains': return !lv.includes(lx);
      case 'is_empty': return !v;
      case 'not_empty': return Boolean(v);
      case 'greater_than': return Number(v.replace(/[^\d.\-]/g, '')) > Number(x);
      case 'less_than': return Number(v.replace(/[^\d.\-]/g, '')) < Number(x);
      case 'matches': return regexOf(x, `where on "${w.column}"`).test(v);
      default: return true;
    }
  };

  function buildSheet(session, input) {
    const cols = [...new Set((input.columns || []).map((c) => tidy(c)).filter(Boolean))];
    if (!cols.length) throw new Error('Give at least one output column.');
    const phoneCol = cols.find((c) => c.toLowerCase() === String(input.phone_column || '').toLowerCase());
    if (!phoneCol) throw new Error(`phone_column must be one of the output columns: ${cols.join(', ')}`);
    const problems = [];
    for (const src of input.sources || []) {
      const f = session.files.get(src.file_id);
      if (!f) { problems.push(`No attached file "${src.file_id}"`); continue; }
      for (const fd of src.fields || []) {
        if (!cols.includes(fd.column)) problems.push(`${f.name}: "${fd.column}" isn't one of the output columns (${cols.join(', ')})`);
        for (const c of fd.from || []) if (!resolveCol(f, c)) problems.push(`${f.name}: no column "${c}". Its columns: ${f.headers.map((h, i) => `${colLetter(i)} ${h}`).join(', ')}`);
        if (fd.fixed == null && !(fd.from || []).length) problems.push(`${f.name}: "${fd.column}" needs from (source columns) or fixed`);
      }
      for (const w of src.where || []) if (!resolveCol(f, w.column)) problems.push(`${f.name}: no column "${w.column}" to filter on`);
    }
    if (problems.length) throw new Error('Fix the recipe:\n- ' + [...new Set(problems)].join('\n- '));

    const out = [], byPhone = new Map(), perSource = [];
    let noPhone = 0, merged = 0, filtered = 0;
    for (const src of input.sources) {
      const f = session.files.get(src.file_id);
      let used = 0, skipped = 0;
      const rows = f.rows.slice(src.skip_first_rows || 0);
      for (const row of rows) {
        if (Object.values(row).every((v) => !String(v ?? '').trim())) continue;
        if ((src.where || []).some((w) => !passesWhere(f, row, w))) { skipped++; filtered++; continue; }
        const rec = Object.fromEntries(cols.map((c) => [c, '']));
        for (const fd of src.fields) rec[fd.column] = fieldValue(f, row, fd);
        const p = normalizePhone(rec[phoneCol]);
        rec[phoneCol] = p ? '+' + p : rec[phoneCol];
        if (!p && !input.keep_rows_without_phone) { noPhone++; continue; }
        if (p && input.dedupe_by_phone !== false && byPhone.has(p)) {
          const first = byPhone.get(p);
          for (const c of cols) if (!first[c] && rec[c]) first[c] = rec[c]; // fill gaps from the later copy
          merged++;
          continue;
        }
        if (p) byPhone.set(p, rec);
        out.push(rec);
        used++;
      }
      perSource.push({ file: f.name, rows_in: rows.length, rows_used: used, skipped_by_filter: skipped });
    }
    if (input.sort_by?.column && cols.includes(input.sort_by.column)) {
      const k = input.sort_by.column, dir = input.sort_by.order === 'desc' ? -1 : 1;
      out.sort((a, b) => dir * String(a[k]).localeCompare(String(b[k]), undefined, { numeric: true, sensitivity: 'base' }));
    }
    // Same name again: this version replaces the earlier one.
    const prev = [...session.files.values()].find((x) => x.built && x.name === tidy(input.name));
    if (prev) session.files.delete(prev.id);
    const sheet = { id: 'f_' + id().slice(0, 8), name: tidy(input.name) || 'Clean sheet', sheet: '', headers: cols, rows: out, phoneColumn: phoneCol, announced: true, built: true, summary: String(input.summary || '').slice(0, 600) };
    session.files.set(sheet.id, sheet);
    const empty = Object.fromEntries(cols.map((c) => [c, out.filter((r) => !r[c]).length]).filter(([, n]) => n));
    const card = {
      id: sheet.id, replaces: prev?.id || null, name: sheet.name, columns: cols, phone_column: phoneCol, rows: out.length, summary: sheet.summary,
      sources: perSource, dropped: { no_valid_phone: noPhone, duplicates_merged: merged, filtered_out: filtered }, empty_cells: empty,
      preview: out.slice(0, 8),
    };
    return {
      card,
      result: {
        file_id: sheet.id, name: sheet.name, rows: out.length, columns: cols, per_source: perSource,
        dropped: card.dropped, empty_cells_per_column: empty,
        sample_rows: out.slice(0, 10).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskPhones(v)]))),
        ...(out.length ? {} : { warning: 'No rows came out. Check the phone column and the filters.' }),
        note: 'Shown to the person as a card with Open in Send and Download. Use file_id in propose_campaign to send to it.',
      },
    };
  }

  function statsFor(input) {
    const query = { range: input.range_days || 14, sender: input.sender_id || '', template: input.template_name || '' };
    const st = computeStats(query);
    const label = (sid) => db.senders.find((s) => s.id === sid)?.label;
    return {
      mode: st.demo ? 'demo (simulated sends only)' : 'live',
      range_days: st.range,
      filters: { sender: label(st.filters.sender) || null, template: st.filters.template || null },
      totals: st.totals,
      previous_period: st.prev,
      per_day: st.days.filter((d) => d.sent || d.failed),
      numbers: st.senders.map((s) => ({ label: s.label, sent_today: s.today, daily_limit: s.limit ?? null, quality: s.qualityRating })),
      recent_campaigns: st.recent.map(campaignInfo),
      upcoming_campaigns: st.upcoming.map(campaignInfo),
      running_now: st.running,
      _card: st, // stripped before it reaches the model; drawn as the stats card
    };
  }

  function campaignInfo(c) {
    const s = c.stats || {};
    return {
      name: c.name,
      template: c.templateName,
      status: c.status,
      recipients: c.total,
      sent: (s.sent || 0) + (s.delivered || 0) + (s.read || 0),
      delivered: (s.delivered || 0) + (s.read || 0),
      read: s.read || 0,
      failed: s.failed || 0,
      created_at: c.createdAt,
      ...(c.scheduledAt ? { scheduled_at: c.scheduledAt } : {}),
    };
  }

  // The most common failure reasons in a campaign, for troubleshooting questions.
  function topErrors(c) {
    const counts = {};
    for (const r of c.recipients) if (r.status === 'failed' && r.error) counts[r.error] = (counts[r.error] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return top.length ? { top_errors: top.map(([error, count]) => ({ error, count })) } : {};
  }

  function appStatus() {
    const st = db.settings;
    const byStatus = {};
    for (const t of db.templates) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const lastIn = db.messages.filter((m) => m.dir === 'in' && !m.demo).at(-1);
    const live = db.campaigns.filter((c) => !c.demo);
    const sentRecips = live.flatMap((c) => c.recipients.filter((r) => r.sentAt)).slice(-500);
    const withStatus = sentRecips.filter((r) => r.status === 'delivered' || r.status === 'read').length;
    return {
      mode: st.demoMode ? 'demo (sends are simulated)' : 'live',
      default_country_code: st.defaultCountryCode || null,
      graph_api_version: st.graphVersion,
      parallel_sends_per_number: st.concurrencyPerNumber,
      delay_between_sends_ms: st.delayMsPerNumber,
      numbers: db.senders.map((s) => ({ label: s.label, enabled: s.enabled !== false, has_access_token: Boolean(s.accessToken), waba_id: s.wabaId || null, quality_rating: s.qualityRating || null, last_checked: s.lastCheckedAt || null, demo_sample: Boolean(s.seed) })),
      templates_by_status: byStatus,
      webhook: {
        verify_token_set: Boolean(st.webhookVerifyToken),
        last_real_customer_message_at: lastIn?.ts || null,
        recent_live_sends_with_delivery_updates: sentRecips.length ? `${withStatus} of the last ${sentRecips.length} sent messages got delivered/read updates` : 'no live sends yet',
        hint: 'If live messages never move past "sent" and no customer messages arrive, the webhook is not set up or not reachable.',
      },
      setup_checklist: {
        number_added: db.senders.length > 0,
        token_saved: db.senders.some((s) => s.accessToken),
        template_available: db.templates.length > 0,
        campaign_sent: db.campaigns.length > 0,
        live: !st.demoMode,
      },
    };
  }

  // --- Plans ---------------------------------------------------------------

  const OPS = {
    equals: (v, x) => v.toLowerCase() === x.toLowerCase(),
    not_equals: (v, x) => v.toLowerCase() !== x.toLowerCase(),
    contains: (v, x) => v.toLowerCase().includes(x.toLowerCase()),
    not_contains: (v, x) => !v.toLowerCase().includes(x.toLowerCase()),
    is_empty: (v) => !v,
    not_empty: (v) => Boolean(v),
    greater_than: (v, x) => compare(v, x) > 0,
    less_than: (v, x) => compare(v, x) < 0,
  };
  function compare(a, b) {
    const na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
    const da = Date.parse(a), dbb = Date.parse(b);
    if (!isNaN(da) && !isNaN(dbb)) return da - dbb;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function recentlyMessaged(days) {
    const since = Date.now() - days * 86400000;
    const out = new Set();
    for (const c of db.campaigns) {
      if (Boolean(c.demo) !== db.settings.demoMode) continue;
      for (const r of c.recipients) if (r.sentAt && new Date(r.sentAt).getTime() >= since) out.add(r.phone);
    }
    return out;
  }

  // Checks a proposal against the real data. Returns { problems } or { plan }.
  function buildPlan(session, input) {
    const problems = [];
    // The sheets to send to: `sources` (each with its own phone column), or the single file_id + phone_column.
    const wanted = Array.isArray(input.sources) && input.sources.length ? input.sources : [{ file_id: input.file_id, phone_column: input.phone_column }];
    const sources = [];
    for (const src of wanted) {
      const f = session.files.get(src?.file_id);
      if (!f) { problems.push(`No attached file with id "${src?.file_id}". Attached: ${[...session.files.keys()].join(', ') || 'none'}`); continue; }
      if (sources.some((x) => x.f === f)) continue;
      if (!f.headers.includes(src.phone_column)) problems.push(`Column "${src.phone_column}" is not in "${f.name}". Its columns: ${f.headers.join(', ')}`);
      sources.push({ f, phone: src.phone_column });
    }
    if (!wanted.length) problems.push('Pick at least one attached file');
    // Columns are matched by name across sheets; a sheet without a column just has no value there.
    const allCols = [...new Set(sources.flatMap((x) => x.f.headers))];
    const has = (col) => allCols.includes(col);
    const where = sources.length > 1 ? 'any of the chosen sheets' : 'the file';

    const template = db.templates.find((t) => t.id === input.template_id);
    if (!template) problems.push(`No template with id "${input.template_id}". Call list_templates for the real IDs.`);
    else {
      const u = templateUsable(template);
      if (!u.ok) problems.push(`Template "${template.name}" can't be used: ${u.reason}`);
    }

    const senderIds = [...new Set(input.sender_ids || [])];
    const senders = [];
    for (const sid of senderIds) {
      const s = db.senders.find((x) => x.id === sid);
      if (!s) problems.push(`No sender number with id "${sid}". Call list_senders for the real IDs.`);
      else if (s.enabled === false) problems.push(`Sender "${s.label}" is turned off`);
      else if (!db.settings.demoMode && !s.accessToken) problems.push(`Sender "${s.label}" has no access token, so it can't send in live mode`);
      else if (template?.wabaId && s.wabaId && template.wabaId !== s.wabaId) problems.push(`Template "${template.name}" belongs to WABA ${template.wabaId}, but sender "${s.label}" is on WABA ${s.wabaId}. Pick a sender on the same WABA or another template.`);
      else senders.push(s);
    }
    if (!senderIds.length) problems.push('Pick at least one sender number');

    const vars = template ? templateVariables(template.components) : [];
    const mapping = {};
    for (const m of input.mapping || []) {
      const v = vars.find((x) => x.key === m.variable);
      if (!v) { if (template) problems.push(`Template "${template.name}" has no variable "${m.variable}". Its variables: ${vars.map((x) => x.key).join(', ') || 'none'}`); continue; }
      if (m.source === 'column' && !has(m.value)) problems.push(`Variable ${m.variable} is mapped to column "${m.value}", which is not in ${where}`);
      else if (m.source === 'fixed' && !String(m.value || '').trim()) problems.push(`Variable ${m.variable} has an empty fixed value`);
      else if (v.media && m.source === 'fixed' && !/^https:\/\//i.test(m.value)) problems.push(`Variable ${m.variable} needs an https URL to the ${v.media}`);
      // Links are where a guess does the most harm, so a fixed URL must be one the person actually typed.
      if (m.source === 'fixed' && /https?:\/\//i.test(m.value) && !session.said.some((t) => t.includes(m.value.trim()))) problems.push(`The URL for ${m.variable} wasn't given by the person. Ask them for the exact link with ask_user (no options) and use it as typed.`);
      mapping[m.variable] = { type: m.source, value: m.value };
    }
    for (const v of vars) if (!mapping[v.key]) problems.push(`Variable ${v.key} is not mapped to a column or fixed value`);

    const filters = input.filters || [];
    for (const fl of filters) {
      if (!has(fl.column)) problems.push(`Filter column "${fl.column}" is not in ${where}`);
      if (!OPS[fl.op]) problems.push(`Unknown filter "${fl.op}"`);
    }
    const optIn = input.opt_in;
    if (optIn && !has(optIn.column)) problems.push(`Opt-in column "${optIn.column}" is not in ${where}`);
    if (optIn && !(optIn.allowed_values || []).length) problems.push('Opt-in needs at least one allowed value');

    let scheduledAt = null;
    if (input.schedule_at) {
      const when = new Date(input.schedule_at);
      if (isNaN(when)) problems.push(`"${input.schedule_at}" is not a valid date-time`);
      else if (when < Date.now() - 60_000) problems.push(`Scheduled time ${when.toISOString()} is in the past`);
      else scheduledAt = when.toISOString();
    }
    if (problems.length) return { problems };

    // Walk the rows: every skip gets a reason the person can see.
    const allowed = optIn ? new Set(optIn.allowed_values.map((v) => String(v).trim().toLowerCase())) : null;
    const recent = input.exclude_contacted_within_days ? recentlyMessaged(input.exclude_contacted_within_days) : null;
    const seen = new Set();
    const kept = [];
    const skipped = [];
    const reasons = {};
    for (const src of sources) {
      src.kept = 0;
      const skip = (row, reason) => {
        reasons[reason] = (reasons[reason] || 0) + 1;
        skipped.push({ raw: row[src.phone], reason, sheet: src.f.name });
      };
      for (const row of src.f.rows) {
        const val = (c) => String(row[c] ?? '').trim();
        if (!Object.values(row).some((v) => String(v).trim())) continue; // blank row
        if (!filters.every((fl) => OPS[fl.op](val(fl.column), String(fl.value ?? '')))) { skip(row, 'Filtered out'); continue; }
        // A sheet without the opt-in column can't show consent, so its rows are left out too.
        const noColumn = allowed && !src.f.headers.includes(optIn.column);
        if (noColumn && !optIn.include_sheets_without_column) { skip(row, 'No opt-in column in this sheet'); continue; }
        if (allowed && !noColumn && !allowed.has(val(optIn.column).toLowerCase())) { skip(row, 'Not opted in'); continue; }
        const phone = normalizePhone(row[src.phone]);
        if (!phone) { skip(row, 'Invalid number'); continue; }
        if (seen.has(phone)) { skip(row, 'Duplicate'); continue; }
        seen.add(phone);
        if (recent?.has(phone)) { skip(row, `Messaged in the last ${input.exclude_contacted_within_days} days`); continue; }
        const empty = vars.find((v) => mapping[v.key].type === 'column' && !val(mapping[v.key].value));
        if (empty) { skip(row, `No value for ${empty.key}`); continue; }
        kept.push({ ...row, __phone: phone });
        src.kept++;
      }
    }
    if (!kept.length) return { problems: [`No one is left to message: ${Object.entries(reasons).map(([r, n]) => `${n} ${r.toLowerCase()}`).join(', ')}`] };

    const valuesFor = (row) => Object.fromEntries(vars.map((v) => [v.key, mapping[v.key].type === 'column' ? String(row[mapping[v.key].value] ?? '').trim() : String(mapping[v.key].value)]));
    const nameCol = allCols.find((h) => /^(full ?)?name$/i.test(h)) || allCols.find((h) => /name/i.test(h));
    const rowCount = sources.reduce((n, x) => n + x.f.rows.length, 0);
    return {
      plan: {
        name: String(input.name || template.name).slice(0, 120),
        sources: sources.map((x) => ({ fileId: x.f.id, name: x.f.name, phoneColumn: x.phone, rows: x.f.rows.length, recipients: x.kept })),
        fileId: sources[0].f.id,
        fileName: sources.map((x) => x.f.name).join(', '),
        templateId: template.id,
        templateName: template.name,
        templateStatus: template.status,
        senders: senders.map((s) => ({ id: s.id, label: s.label, phone: s.displayPhone || '' })),
        phoneColumn: sources[0].phone,
        mapping,
        variables: vars.map((v) => ({ key: v.key, label: v.media ? `header ${v.media} URL` : `${v.where} {{${v.name}}}`, media: v.media || null })),
        filters,
        optIn: optIn || null,
        excludeDays: input.exclude_contacted_within_days || null,
        scheduledAt,
        demo: db.settings.demoMode,
        assumptions: (input.assumptions || []).map(String).slice(0, 12),
        explanation: String(input.explanation || '').slice(0, 2000),
        counts: { rows: rowCount, recipients: kept.length, skipped: reasons },
        samples: kept.slice(0, 6).map((row) => ({ phone: row.__phone, name: nameCol ? String(row[nameCol] ?? '') : '', values: valuesFor(row) })),
        columns: allCols,
        keptRows: kept,
        skippedList: skipped,
      },
    };
  }

  const publicPlan = (p) => {
    const { keptRows, skippedList, input, sessionId, toolUseId, ...rest } = p;
    return rest;
  };

  // --- The conversation loop --------------------------------------------------

  function runTool(session, name, input, emit) {
    switch (name) {
      case 'list_templates':
        return { templates: db.templates.map(templateInfo) };
      case 'list_senders': {
        const today = sentTodayBySender();
        return { mode: db.settings.demoMode ? 'demo (sends are simulated)' : 'live', senders: db.senders.map((s) => senderInfo(s, today)) };
      }
      case 'inspect_file':
        return inspectFile(session, input.file_id);
      case 'peek_rows':
        return peekRows(session, input);
      case 'build_sheet': {
        const { card, result } = buildSheet(session, input);
        emit({ type: 'sheet', sheet: card });
        return result;
      }
      case 'get_stats': {
        const out = statsFor(input);
        emit({ type: 'stats', stats: out._card });
        delete out._card;
        return out;
      }
      case 'list_campaigns': {
        const list = db.campaigns.filter((c) => Boolean(c.demo) === db.settings.demoMode).slice(0, Math.min(30, input.limit || 10));
        return { campaigns: list.map((c) => ({ ...campaignInfo(summary(c)), ...topErrors(c) })) };
      }
      case 'get_app_status':
        return appStatus();
      case 'use_contacts': {
        const tags = (input.tags || []).map(String).filter(Boolean);
        const list = contacts.listByTags(tags, { statuses: input.statuses || [] });
        if (!list.length) throw new Error(`No contacts match${tags.length ? ` the tags ${tags.join(', ')}` : ''} (opted-out people are never included). Existing tags: ${db.tags.map((t) => t.name).join(', ') || 'none'}`);
        const extras = [...new Set(list.flatMap((c) => Object.keys(c.extra || {})))].slice(0, 30);
        const headers = ['phone', 'name', 'email', 'company', 'tags', 'status', ...extras];
        const tagName = (t) => db.tags.find((x) => x.id === t)?.name || '';
        const f = {
          id: 'f_' + id().slice(0, 8),
          name: `Contacts · ${tags.length ? tags.join(', ') : 'everyone'}${input.statuses?.length ? ` (${input.statuses.join(', ')})` : ''}`,
          sheet: '',
          headers,
          rows: list.map((c) => ({ phone: c.phone, name: c.name, email: c.email, company: c.company, tags: c.tags.map(tagName).filter(Boolean).join(', '), status: c.status, ...Object.fromEntries(extras.map((k) => [k, c.extra?.[k] ?? ''])) })),
          phoneColumn: 'phone',
          announced: true, // the tool result describes it, so the context block needn't
        };
        session.files.set(f.id, f);
        return inspectFile(session, f.id);
      }
      default:
        throw new Error(`Unknown tool "${name}"`);
    }
  }

  // What the model sees at the start of each turn: facts that change, kept out of the cached system prompt.
  function contextBlock(session, body) {
    const lines = [
      `Now: ${new Date().toString()}`,
      `Mode: ${db.settings.demoMode ? 'demo (sends are simulated)' : 'live (real messages, charged by Meta)'}`,
      `Default country code: ${db.settings.defaultCountryCode ? '+' + db.settings.defaultCountryCode : 'none set'}`,
    ];
    const fresh = [...session.files.values()].filter((f) => !f.announced || f.phoneChanged);
    for (const f of fresh) {
      lines.push(f.announced
        ? `The person changed the phone column of file ${f.id} ("${f.name}") to "${f.phoneColumn}". Use that column.`
        : `Attached file: id ${f.id}, "${f.name}"${f.sheet ? ` (sheet "${f.sheet}" of ${f.workbook || 'a workbook'})` : ''}, ${f.rows.length} rows, columns: ${f.headers.join(', ')}${f.phoneColumn ? `. The phone column looks like "${f.phoneColumn}".` : ''}${f.shiftedFixed ? ` ${f.shiftedFixed} row(s) were shifted a few columns to the right and have already been moved back; any extra answers that caused it are in "Extra answer" columns.` : ''}`);
      f.announced = true;
      f.phoneChanged = false;
    }
    if (db.contacts?.length) {
      const counts = db.tags.map((t) => `${t.name} (${db.contacts.filter((c) => !c.optOut && c.tags.includes(t.id)).length})`);
      lines.push(`Saved contacts: ${db.contacts.filter((c) => !c.optOut).length} who can be messaged${counts.length ? `; tags: ${counts.join(', ')}` : ', no tags'}`);
    }
    if (body.senderId) {
      const s = db.senders.find((x) => x.id === body.senderId);
      if (s) lines.push(`Sender number selected in the composer: "${s.label}" (id ${s.id}). Use it unless the person says otherwise.`);
    }
    return `<context>\n${lines.join('\n')}\n</context>`;
  }

  // The tool results owed for the turn that paused, plus the answer to the pausing call.
  function settlePending(session, body) {
    const p = session.pending;
    if (!p) return { results: [], consumedText: false };
    session.pending = null;
    let content, consumedText = false;
    if (p.kind === 'ask') {
      const answer = String(body.answer ?? body.text ?? '').trim();
      content = answer ? `The person answered: ${answer}` : 'The person did not answer and moved on; see their message.';
      consumedText = body.answer == null && Boolean(answer);
    } else {
      const plan = plans.get(p.planId);
      if (plan?.status === 'approved') content = plan.resultNote;
      else if (plan?.status === 'declined') content = plan.resultNote;
      else {
        if (plan) { plan.status = 'superseded'; syncPlan(plan); }
        content = 'The person did not approve this plan and replied instead (see their message). Nothing was sent.';
      }
    }
    return { results: [...p.results, { id: p.toolUseId, name: p.toolName, content }], consumedText };
  }

  const PROVIDER_NAMES = { claude: 'Anthropic (Claude)', gemini: 'Gemini' };
  const providers = new Map(); // session id -> provider object (holds per-conversation state like Gemini's unnamed calls)

  function providerFor(session) {
    const cfg = aiConfig();
    if (session.provider !== cfg.provider && session.history.length) {
      throw fail(`This chat used ${PROVIDER_NAMES[session.provider]}, but the assistant is now set to ${PROVIDER_NAMES[cfg.provider]}. Start a new chat.`, 409);
    }
    session.provider = cfg.provider;
    const key = cfg.keys[cfg.provider];
    if (!key) throw fail(`Add your ${PROVIDER_NAMES[cfg.provider]} API key in Settings → AI assistant to use the assistant.`, 412);
    let p = providers.get(session.id);
    if (!p || p.key !== key || p.model !== cfg.geminiModel) {
      p = cfg.provider === 'gemini' ? geminiProvider(key, cfg.geminiModel, id) : claudeProvider(key);
      Object.assign(p, { key, model: cfg.geminiModel });
      providers.set(session.id, p);
    }
    return p;
  }

  function explain(e) {
    if (e instanceof GeminiError) {
      const m = e.message || '';
      if (e.status === 400 && /api key/i.test(m)) return 'The Gemini API key was rejected. Check it in Settings → AI assistant.';
      if (e.status === 403) return "This Gemini API key doesn't have access. Check it in Google AI Studio.";
      if (e.status === 404) return `Gemini doesn't know the model "${aiConfig().geminiModel}". Pick another in Settings → AI assistant.`;
      if (e.status === 429) return /per.?day/i.test(m) ? "You've used today's free Gemini quota. It resets daily, or switch to Claude in Settings." : 'Gemini is rate limited right now (free tier). Wait a minute and try again.';
      return `Gemini returned an error (${e.status ?? 'unknown'}). Try again.`;
    }
    if (e instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI assistant.';
    if (e instanceof Anthropic.PermissionDeniedError) return "This API key doesn't have access to the model. Check your Anthropic account.";
    if (e instanceof Anthropic.RateLimitError) return 'The AI is rate limited right now. Wait a moment and try again.';
    if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Check the server's internet connection.";
    if (e instanceof Anthropic.APIError) return `The AI service returned an error (${e.status ?? 'unknown'}). Try again.`;
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(e.message || '')) return "Couldn't reach the AI service. Check the server's internet connection.";
    return e.message;
  }

  async function turn(session, body, emit) {
    const model = providerFor(session);
    const { results, consumedText } = settlePending(session, body);
    const text = consumedText ? '' : String(body.text || '').trim();
    session.said.push(String(body.answer ?? ''), String(body.text || ''));
    model.addUser(session.history, { results, text: `${contextBlock(session, body)}\n\n${text || '(no message — continue from the answer above)'}` });

    for (let step = 0; step < MAX_STEPS; step++) {
      const thinkId = 'think-' + step;
      emit({ type: 'step', id: thinkId, state: 'reasoning', label: step ? 'Thinking it through' : 'Understanding your request', status: 'running' });
      let reply;
      try {
        reply = await model.step(session.history, {
          onRetry: (secs, n) => {
            const rid = `retry-${step}-${n}`;
            emit({ type: 'step', id: rid, state: 'retrying', label: `The AI is busy (free tier limit). Trying again in ${secs}s`, status: 'running' });
            setTimeout(() => emit({ type: 'step', id: rid, status: 'done' }), secs * 1000);
          },
        });
      } finally {
        emit({ type: 'step', id: thinkId, status: 'done' });
      }

      if (reply.refused) {
        emit({ type: 'text', text: "I can't help with that request." });
        return;
      }
      for (const t of reply.texts) if (t.trim()) emit({ type: 'text', text: t });
      if (!reply.calls.length) {
        if (!reply.texts.some((t) => t.trim())) emit({ type: 'text', text: "I didn't get a reply that time. Try asking again." });
        return;
      }
      if (reply.truncated) {
        emit({ type: 'text', text: 'That reply ran too long and was cut off. Try asking in smaller steps.' });
        return;
      }

      const toolResults = [];
      const result = (u, content, isError = false) => toolResults.push({ id: u.id, name: u.name, content, isError });
      let pause = null;
      for (const u of reply.calls) {
        const input = u.input && typeof u.input === 'object' ? u.input : {};
        if (PAUSING.has(u.name) && pause) {
          result(u, 'Only one question or plan at a time. Wait for the person to respond first.', true);
          continue;
        }
        if (u.name === 'ask_user') {
          const options = (Array.isArray(input.options) ? input.options : []).filter((o) => o && o.label).slice(0, 6);
          if (!input.question) {
            result(u, 'ask_user needs a question.', true);
            continue;
          }
          const qid = id();
          pause = { kind: 'ask', toolUseId: u.id, toolName: u.name, questionId: qid };
          emit({ type: 'question', id: qid, question: String(input.question), options: options.map((o) => ({ label: String(o.label), description: o.description ? String(o.description) : '' })) });
          continue;
        }
        const [state, label] = STEP_LABELS[u.name] || ['working', 'Working'];
        const stepId = 'tool-' + u.id;
        const fileName = u.name === 'inspect_file' ? session.files.get(input.file_id)?.name : null;
        emit({ type: 'step', id: stepId, state, label: fileName ? `Reading ${fileName}` : label, status: 'running' });
        if (u.name === 'propose_campaign') {
          const { problems, plan } = buildPlan(session, input);
          if (problems) {
            emit({ type: 'step', id: stepId, status: 'done', detail: `${problems.length} thing${problems.length > 1 ? 's' : ''} to fix` });
            result(u, JSON.stringify({ problems }), true);
            continue;
          }
          Object.assign(plan, { id: id(), sessionId: session.id, toolUseId: u.id, input, status: 'pending', createdAt: new Date().toISOString() });
          plans.set(plan.id, plan);
          session.planIds.push(plan.id);
          emit({ type: 'step', id: stepId, status: 'done', detail: `${plan.counts.recipients.toLocaleString()} recipients` });
          pause = { kind: 'plan', toolUseId: u.id, toolName: u.name, planId: plan.id };
          emit({ type: 'plan', plan: publicPlan(plan) });
          continue;
        }
        try {
          const out = runTool(session, u.name, input, emit);
          const detail = u.name === 'build_sheet' ? `${out.rows.toLocaleString()} rows` : u.name === 'peek_rows' ? `${out.rows.length} rows` : u.name === 'use_contacts' ? `${out.rows.toLocaleString()} contacts` : u.name === 'inspect_file' ? `${out.rows.toLocaleString()} rows · ${out.columns.length} columns` : u.name === 'list_templates' ? `${out.templates.length} found` : u.name === 'list_senders' ? `${out.senders.length} found` : '';
          emit({ type: 'step', id: stepId, status: 'done', detail });
          result(u, JSON.stringify(out));
        } catch (e) {
          emit({ type: 'step', id: stepId, status: 'done', detail: 'failed' });
          result(u, e.message, true);
        }
      }

      if (pause) {
        // The other tools' results wait with the pausing call's, so the next user message answers every call at once.
        session.pending = { ...pause, results: toolResults };
        emit({ type: 'await', kind: pause.kind });
        return;
      }
      model.addUser(session.history, { results: toolResults, text: '' });
    }
    emit({ type: 'text', text: 'I stopped after several steps without finishing. Try rephrasing, or break the request into smaller parts.' });
  }

  // --- Routes ---------------------------------------------------------------

  app.post('/api/ai/files', wrap((req, res) => {
    const { sessionId, name, sheet, workbook, headers, rows, phoneColumn, shiftedFixed } = req.body;
    if (!Array.isArray(headers) || !headers.length || !Array.isArray(rows)) throw fail('The file has no columns');
    if (rows.length > MAX_ROWS) throw fail(`Files are limited to ${MAX_ROWS.toLocaleString()} rows`);
    const session = getSession(sessionId);
    if (session.busy) throw fail('Wait for the current reply to finish', 409);
    const cols = headers.map(String);
    const f = {
      id: 'f_' + id().slice(0, 8),
      name: String(name || 'contacts').slice(0, 200),
      sheet: sheet ? String(sheet) : '',
      workbook: workbook ? String(workbook).slice(0, 200) : '',
      headers: cols,
      rows: rows.map((r) => Object.fromEntries(cols.map((h) => [h, String(r?.[h] ?? '')]))),
      phoneColumn: cols.includes(phoneColumn) ? phoneColumn : '',
      shiftedFixed: Math.max(0, Number(shiftedFixed) || 0),
      announced: false,
    };
    session.files.set(f.id, f);
    res.json({ sessionId: session.id, fileId: f.id, rows: f.rows.length });
  }));

  app.put('/api/ai/files/:fileId', wrap((req, res) => {
    const session = getSession(req.body.sessionId, false);
    const f = session.files.get(req.params.fileId);
    if (!f) throw fail('File not found', 404);
    const col = String(req.body.phoneColumn || '');
    if (!f.headers.includes(col)) throw fail(`No column "${col}"`);
    if (f.phoneColumn !== col) {
      f.phoneColumn = col;
      if (f.announced) f.phoneChanged = true;
    }
    res.json({ ok: true });
  }));

  // A sheet the assistant built, in full, for "Open in Send" and "Download".
  app.get('/api/ai/files/:fileId', wrap((req, res) => {
    const session = getSession(String(req.query.sessionId || ''), false);
    const f = session.files.get(req.params.fileId);
    if (!f || !f.built) throw fail('This sheet is no longer available (the server restarted or the chat timed out). Ask the assistant to build it again.', 404);
    res.json({ name: f.name, headers: f.headers, rows: f.rows.map((r) => f.headers.map((h) => r[h] ?? '')), phoneColumn: f.phoneColumn });
  }));

  app.delete('/api/ai/files/:fileId', wrap((req, res) => {
    const session = getSession(req.query.sessionId, false);
    const f = session.files.get(req.params.fileId);
    // Once the model has seen a file it stays, so earlier turns still make sense.
    if (f && !f.announced) session.files.delete(f.id);
    res.json({ ok: true });
  }));

  // --- Saved chats (history) --------------------------------------------------------

  // The saved chat for a session, created on its first message.
  function chatFor(session, firstText) {
    let c = chatById(session.id);
    if (!c) {
      const title = String(firstText || '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat';
      c = { id: session.id, title, provider: session.provider, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], history: [], said: [] };
      db.aiChats.unshift(c);
      if (db.aiChats.length > MAX_CHATS) db.aiChats.length = MAX_CHATS;
    }
    return c;
  }
  // Keep a saved plan card in step with the live plan (approved, declined, edited…).
  function syncPlan(p) {
    const c = chatById(p.sessionId);
    const item = c?.messages.flatMap((m) => m.items || []).find((it) => it.type === 'plan' && it.plan.id === p.id);
    if (item) { item.plan = publicPlan(p); save(); }
  }
  function storeHistory(c, session) {
    const json = JSON.stringify(session.history);
    c.history = json.length <= MAX_HISTORY_BYTES ? session.history : [];
    c.continuable = json.length <= MAX_HISTORY_BYTES;
    c.said = session.said.slice(-200);
    c.provider = session.provider;
  }

  app.get('/api/ai/chats', (req, res) => {
    // For the list: how many messages the person sent, and the start of the latest reply.
    const preview = (c) => {
      const items = c.messages.filter((m) => m.role === 'ai').flatMap((m) => m.items || []);
      const last = items.filter((it) => it.type === 'text').at(-1)?.text || (items.some((it) => it.type === 'plan') ? 'Prepared a campaign plan' : '');
      return String(last).replace(/\*\*|`|^[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    };
    res.json(db.aiChats.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.messages.filter((m) => m.role === 'user').length, preview: preview(c) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });

  app.get('/api/ai/chats/:id', wrap((req, res) => {
    const c = chatById(req.params.id);
    if (!c) throw fail('Chat not found', 404);
    // Plans still waiting for approval can only be approved while they're in memory.
    const messages = c.messages.map((m) => (m.items ? { ...m, items: m.items.map((it) => (it.type === 'plan' && it.plan.status === 'pending' && !plans.has(it.plan.id) ? { ...it, plan: { ...it.plan, status: 'expired' } } : it)) } : m));
    res.json({ id: c.id, title: c.title, messages, continuable: c.continuable !== false, provider: c.provider });
  }));

  app.patch('/api/ai/chats/:id', wrap((req, res) => {
    const c = chatById(req.params.id);
    if (!c) throw fail('Chat not found', 404);
    const title = String(req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!title) throw fail('Give the chat a name');
    c.title = title;
    save();
    res.json({ id: c.id, title: c.title });
  }));

  app.delete('/api/ai/chats/:id', wrap((req, res) => {
    const s = sessions.get(req.params.id);
    if (s?.busy) throw fail('Wait for the current reply to finish', 409);
    dropSession(req.params.id);
    db.aiChats = db.aiChats.filter((c) => c.id !== req.params.id);
    save();
    res.json({ ok: true });
  }));

  app.post('/api/ai/chat', async (req, res) => {
    let session;
    try {
      session = getSession(req.body.sessionId, Boolean(!req.body.sessionId));
      if (session.busy) throw fail('Wait for the current reply to finish', 409);
      if (!String(req.body.text || '').trim() && req.body.answer == null) throw fail('Type a message');
      providerFor(session); // fail fast, before streaming, when no key is set or the provider changed
    } catch (e) {
      return res.status(e.httpStatus || 400).json({ error: e.message });
    }
    session.busy = true;
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    // Save the turn as it happens: what the person said (and which files came with it), then the reply.
    const shown = String(req.body.shown ?? req.body.text ?? req.body.answer ?? '').slice(0, 8000);
    const newFiles = [...session.files.values()].filter((f) => !f.announced).map((f) => ({ name: f.name, sheet: f.sheet, rows: f.rows.length }));
    const chat = chatFor(session, shown || newFiles[0]?.name);
    chat.messages.push({ role: 'user', text: shown, files: newFiles, ts: new Date().toISOString() });
    const reply = { role: 'ai', items: [], ts: new Date().toISOString() };
    chat.messages.push(reply);
    const record = (ev) => {
      if (ev.type === 'text' || ev.type === 'error') reply.items.push({ type: ev.type, text: ev.text ?? ev.error });
      else if (ev.type === 'question') reply.items.push({ type: 'question', id: ev.id, question: ev.question, options: ev.options });
      else if (ev.type === 'plan') reply.items.push({ type: 'plan', plan: ev.plan });
      else if (ev.type === 'stats') reply.items.push({ type: 'stats', stats: ev.stats });
      else if (ev.type === 'sheet') reply.items.push({ type: 'sheet', sheet: ev.sheet });
    };
    const emit = (ev) => { record(ev); res.write(JSON.stringify(ev) + '\n'); };
    emit({ type: 'session', sessionId: session.id });
    try {
      await turn(session, req.body, emit);
    } catch (e) {
      console.error('AI turn failed:', e);
      emit({ type: 'error', error: explain(e) });
    } finally {
      session.busy = false;
      session.updatedAt = Date.now();
      chat.updatedAt = new Date().toISOString();
      storeHistory(chat, session);
      save();
      emit({ type: 'done' });
      res.end();
    }
  });

  const findPlan = (pid) => {
    const p = plans.get(pid);
    if (!p || sessions.get(p.sessionId)?.ws !== wsId()) throw fail('This plan has expired. Ask the assistant again.', 410);
    return p;
  };

  // The person edits a pending plan on its card (sender numbers, variable mapping); re-check it.
  app.patch('/api/ai/plans/:id', wrap((req, res) => {
    const p = findPlan(req.params.id);
    if (p.status !== 'pending') throw fail(`This plan is already ${p.status}`);
    const session = getSession(p.sessionId, false);
    if (session.busy) throw fail('Wait for the current reply to finish', 409);
    const input = { ...p.input };
    if (Array.isArray(req.body.senderIds)) input.sender_ids = req.body.senderIds;
    if (req.body.mapping && typeof req.body.mapping === 'object') {
      // A fixed value typed on the card counts as given by the person.
      for (const m of Object.values(req.body.mapping)) if (m?.type === 'fixed') session.said.push(String(m.value ?? ''));
      input.mapping = Object.entries({ ...p.mapping, ...req.body.mapping }).map(([variable, m]) => ({ variable, source: m.type, value: m.value }));
    }
    const { problems, plan } = buildPlan(session, input);
    if (problems) throw fail(problems.join(' · '));
    const edited = [...new Set([...(p.edited || []), ...(req.body.senderIds ? ['sender numbers'] : []), ...(req.body.mapping ? ['variable mapping'] : [])])];
    Object.assign(p, plan, { input, edited });
    syncPlan(p);
    res.json(publicPlan(p));
  }));

  app.post('/api/ai/plans/:id/approve', wrap((req, res) => {
    const p = findPlan(req.params.id);
    if (p.status !== 'pending') throw fail(`This plan is already ${p.status}`);
    const session = getSession(p.sessionId, false);
    if (session.busy) throw fail('Wait for the current reply to finish', 409);
    // Re-check against current data: a template or number may have changed since the plan was made.
    const { problems, plan } = buildPlan(session, p.input);
    if (problems) throw fail(problems.join(' · '));
    Object.assign(p, plan, { input: p.input });
    const c = createCampaign({
      name: p.name,
      templateId: p.templateId,
      senderIds: p.senders.map((s) => s.id),
      rows: p.keptRows,
      phoneColumn: '__phone',
      mapping: p.mapping,
      scheduledAt: p.scheduledAt,
      skipped: p.skippedList,
      source: 'assistant',
    });
    p.status = 'approved';
    p.campaignId = c.id;
    const edits = p.edited?.length ? ` They edited the ${p.edited.join(' and ')} on the card before approving.` : '';
    p.resultNote = `The person approved the plan.${edits} Campaign "${c.name}" was created with ${c.recipients.length} recipients; it is ${c.status === 'scheduled' ? 'scheduled for ' + c.scheduledAt : 'sending now'}${c.demo ? ' (demo mode, simulated)' : ''}.`;
    syncPlan(p);
    res.json({ plan: publicPlan(p), campaign: summary(c) });
  }));

  app.post('/api/ai/plans/:id/decline', wrap((req, res) => {
    const p = findPlan(req.params.id);
    if (p.status !== 'pending') throw fail(`This plan is already ${p.status}`);
    p.status = 'declined';
    p.resultNote = 'The person declined the plan. Nothing was sent.';
    syncPlan(p);
    res.json(publicPlan(p));
  }));

  app.get('/api/ai/plans/:id/recipients.csv', (req, res) => {
    const p = plans.get(req.params.id);
    if (!p) return res.sendStatus(404);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const keys = p.variables.map((v) => v.key);
    const lines = [['phone', 'name', ...keys, 'note'].map(esc).join(',')];
    const nameCol = p.columns.find((h) => /^(full ?)?name$/i.test(h)) || p.columns.find((h) => /name/i.test(h));
    for (const row of p.keptRows) {
      const vals = keys.map((k) => (p.mapping[k].type === 'column' ? row[p.mapping[k].value] : p.mapping[k].value));
      lines.push([row.__phone, nameCol ? row[nameCol] : '', ...vals, ''].map(esc).join(','));
    }
    for (const s of p.skippedList) lines.push([s.raw, '', ...keys.map(() => ''), `skipped: ${s.reason}${p.sources.length > 1 ? ` (${s.sheet})` : ''}`].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="plan-${p.id}.csv"`);
    res.send(lines.join('\n'));
  });

  // Settings → "Test": a cheap call that proves the active provider's key works and can see the model.
  app.post('/api/ai/test', wrap(async (req, res) => {
    const cfg = aiConfig();
    if (!cfg.key) throw fail(`Add your ${PROVIDER_NAMES[cfg.provider]} API key first`);
    try {
      if (cfg.provider === 'gemini') {
        const m = await new GoogleGenAI({ apiKey: cfg.key }).models.get({ model: cfg.geminiModel });
        res.json({ ok: true, provider: 'gemini', model: m.displayName || cfg.geminiModel });
      } else {
        const m = await new Anthropic({ apiKey: cfg.key }).models.retrieve(CLAUDE_MODEL);
        res.json({ ok: true, provider: 'claude', model: m.display_name || m.id });
      }
    } catch (e) {
      if (e.httpStatus) throw e;
      throw fail(explain(e));
    }
  }));
};

// Shared with the Inbox lead assistant (lead.js).
module.exports.claudeProvider = claudeProvider;
module.exports.geminiProvider = geminiProvider;
module.exports.GeminiError = GeminiError;
module.exports.Anthropic = Anthropic;
