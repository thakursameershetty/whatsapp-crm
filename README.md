# WhatsApp Sender

Send WhatsApp template messages to a large list of people with one click, spread across several WhatsApp Business numbers. It uses the official **WhatsApp Business Cloud API** (Meta).

## Run it

```bash
npm install
npm start            # → http://localhost:3000
```

Options (environment variables):

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`) |
| `APP_PASSWORD` | Password-protect the dashboard with a sign-in page (**set this before putting it online**). Sign out at `/logout`. |
| `GEMINI_API_KEY` | Gemini key for the AI assistant, if you'd rather not save it in Settings. A key saved in Settings takes priority. |
| `ANTHROPIC_API_KEY` | Same, for Claude. |

All data (numbers, tokens, templates, campaign logs, the AI assistant's API key) is saved in `data/db.json`. Back that file up, and never commit it, because it contains your access tokens.

## Before your API access is ready: Demo mode

The app starts in **Demo mode**. Everything works (adding numbers, templates, uploading contacts, sending, progress, delivered/read) but sending is simulated. Use it to set up and practise.

To see the app with data in it, click **Overview → Load demo workspace**. It adds 3 sample numbers, 3 templates and two weeks of campaign history. **Remove demo data** deletes only those samples; anything you added yourself stays. Demo campaigns are never counted in your live stats.

## Overview dashboard

The home page shows the last 14 days:

- Messages sent, delivery rate, read rate and failures, each with a trend line
- A messages-per-day chart (hover a bar for details, or switch it to a table)
- How far your messages got: sent → delivered → read
- Each number's usage today against its daily limit, plus its quality rating
- Upcoming scheduled sends and your recent campaigns
- A setup checklist until you've gone live

## AI assistant

**Assistant** (second in the sidebar, or **Ask AI** on the Overview) is a chat page for three things:

- **Questions:** how to do anything in the app, setting up WhatsApp credentials and the webhook, what an error means, why messages are stuck at "sent". It checks your actual setup (mode, numbers, tokens, templates, webhook activity) when the answer depends on it.
- **Stats:** *"How did this week's campaigns do?"* gives an answer plus a stats card.
- **Sending tasks:** attach a contact file (CSV, TSV or Excel) and say what to send, for example *"Send festive_offer to everyone in this file from Sales line 1, using the Name column for {{1}}"*.

How a sending task works:

- **Preview the file.** Attaching a file opens a preview of what was read from it: row counts, valid / invalid / duplicate numbers, filters, search, and which column holds the phone numbers. Change the phone column there if the guess is wrong; the assistant uses your choice.
- **It shows its work.** Each step (reading the file, checking templates and numbers, checking the plan) appears as it happens.
- **It asks instead of guessing.** If the template, sender number, a variable's column, an opt-in column or anything else is unclear, it asks with options taken from your real data. The server also checks every plan (template approved and on the same WABA as the number, every variable mapped, columns exist, numbers valid) and sends problems back to the assistant to fix.
- **It plans first and waits for you.** The result is a **campaign plan** card that starts with *What will happen*, a plain explanation of the plan, followed by the recipients and skip reasons, personalised message previews, the template, numbers, variable mapping, rules and the assistant's assumptions. Each section says what it shows. You can change the numbers or the variable mapping on the card. Only **Approve & send** (plus a confirmation) starts the campaign, through the same sending code as the Send page. **Decline**, or replying with a message instead, means nothing is sent.
- **Consent.** If the file has an opt-in style column, the plan only includes people who opted in.

**Chat history.** Every chat is saved (in `data/db.json`) and listed in the history panel (the clock button at the top left of the Assistant), grouped by day, with search, rename and delete. Open a past chat to read it or carry on where you left off, even after a restart. Attached files aren't saved, so re-attach a file if the assistant needs it again. A plan that was still waiting for approval when the app restarted shows as not approved; ask again for a fresh one. The last 100 chats are kept.

### Choosing the AI and getting a key

**Settings → AI assistant** switches between two providers. Chats already open keep the one they started with.

- **Gemini (Google), free tier**: good for development and demos. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key**. The default model is `gemini-3.8-flash` (you can change it in Settings). The free tier has per-minute and per-day request limits (the assistant waits and retries when it hits the per-minute one), and Google may use free-tier data to improve its products, so avoid real customer data there.
- **Claude (Anthropic)**: paid per use (a few cents per request), not included in a Claude.ai subscription, and more careful at mapping files to templates. Sign in at [console.anthropic.com](https://console.anthropic.com), add credit under **Settings → Billing**, then **Settings → API keys → Create key**. Uses Claude Opus 5.5.

Paste the key, click **Save**, then **Test**. For attached files the assistant only sees column names, the first five rows (phone numbers partly hidden) and summary counts, never the whole file. Whichever provider you use, a fixed link in a plan (like a header image URL) must be one you typed: the server rejects links the AI came up with. Conversations are kept in server memory and end when the server restarts.

## Contacts

**Contacts** (in the sidebar) is your address book, one entry per phone number.

- **Who's in it:** everyone you add or import, plus everyone who messages you (they're added automatically, with their WhatsApp name).
- **Tags** such as *Clients, Developers, Designers, Testers*: create, colour, rename or delete them from the tag bar; filter by clicking one; select people and use **Add tag / Remove tag** to tag in bulk.
- **Each contact:** name, phone, email, company, tags, lead status (New → Interested → Qualified → Won / Not interested), notes, an **opted out** switch, what the lead assistant learned, other imported details, and **Open chat**.
- **Import:** CSV or Excel, several files at once and every sheet of a workbook. Pick which columns are phone, name, email and company (guessed for you), fix shifted rows from lead-ad exports, keep the other columns as extra details, and tag everyone imported. People are matched by phone number, so importing again updates them instead of making duplicates, and blank cells never overwrite saved details.
- **Export:** CSV or Excel, of everyone, the filtered list, or just the selected people.
- **Sending:** select people and **Send a message**, or on the Send page use **From contacts** to add everyone with chosen tags as a sheet. In the Assistant, say *"send the offer to all designers"*. **Opted-out contacts are never sent to**, by any route: campaigns skip them with the reason "Opted out".
- **Opt-outs:** when someone replies STOP (or unsubscribe, opt out…), they're opted out straight away.

## Lead assistant (Inbox)

When someone replies, the AI can help turn the conversation into a lead. Set it up in **Settings → Lead assistant**:

- **About your business:** what you offer, prices, timings, FAQs, links (like a booking link) and the tone to use. These are the *only* facts it states; anything else gets "I'll check with the team".
- **What makes a qualified lead.**
- **Draft replies automatically:** when on, it drafts a reply a few seconds after someone writes. When off, use **Draft a reply with AI** in any chat.

In each chat:

- A **Suggested reply** card with **Send**, **Edit**, **Regenerate** and **Dismiss**. **Nothing is sent until you press Send.** If they write again before you send, the card says so.
- It asks one thing at a time to learn what they need, their budget and timeline, and saves it to their contact. The chat header shows their status and tags, with a lead summary underneath.
- **Needs you:** when the lead is qualified, they ask for a person, or it's something sensitive (complaints, refunds, payments), the chat is flagged in the list and a banner says why.
- **AI on / off** per chat. It only drafts inside WhatsApp's 24-hour reply window, never for opted-out people, and treats the customer's text as data, not instructions.

It uses the AI provider chosen in **Settings → AI assistant**.

## Campaigns

- **The list:** a 30-day summary (sent, delivered, read, replies, leads); anything **sending now** (live progress, time left, Stop) or **scheduled** (when, Send now) pinned on top; then every other campaign in a compact table with delivery bar, read rate, **replies** and **leads**, which you can search, filter (All / Completed / Stopped) and sort (newest, oldest, size, read rate, replies).
- **A campaign:**
  - the **message** as it went out, flipping through recipients to see their personal values;
  - **results** from sent → delivered → read → **replied** → **leads**, each as a share of the step before. A recipient counts as *replied* if they wrote to the same number within 7 days, and as a *lead* if their contact is now Qualified or Won;
  - **over time:** how many had been sent, delivered and read at each moment (hover for exact numbers, or switch to a table);
  - **why messages failed**, grouped by Meta's error in plain words, with **Retry** for the reasons where trying again can work;
  - **Follow up:** send again to people who didn't read, message everyone who replied, retry every failure, or duplicate the campaign. Each opens the Send page with those people and the same template and values, ready to check and send;
  - **recipients** in a read-only sheet (sort, filter, copy), with All / Read / Delivered / Sent / Replied / Failed / Pending; double-click someone who replied to open the chat;
  - Stop, Send now or Resume up front; Export CSV, Cancel schedule and Delete under **⋯**.

## When your API key and templates arrive

1. **Numbers → Add number** for each WhatsApp number: Phone number ID, WhatsApp Business Account (WABA) ID, and a permanent access token. Click **Test connection**.
2. **Templates → Sync from Meta** pulls in all your approved templates.
3. **Settings** → turn **Demo mode off**.
4. **Send**: choose a template and numbers, upload a CSV, map variables, send a test to yourself, then **Send to all**.

Step-by-step instructions for getting the credentials are on the app's Settings page.

## Send page: your contacts as a spreadsheet

Open **CSV, TSV or Excel (.xlsx/.xls)** files with **Upload files**, by dragging them onto the page, or with **+** next to the sheet tabs. You can also start a **Blank sheet** and paste straight from Excel or Google Sheets. If the first row has no phone numbers in it, it's used as the column names.

```csv
phone,name,city
9876543210,Ravi,Pune
919812345678,Priya,Delhi
```

- **Several files and sheets:** every file, and every sheet inside an Excel workbook, gets its own tab at the bottom (empty sheets are skipped). **Tick the tabs to send to**: ticked tabs are combined into one recipient list, and a number that appears in more than one sheet is only messaged once. Columns are matched across sheets by name. Opening a file that's already open asks before replacing it.
- **Edit like a spreadsheet:** click, Shift+click or drag to select; type or double-click (or Enter / F2) to edit a cell; Delete clears; arrow keys, Tab and Enter move (⌘ + arrow jumps to the edge); ⌘A selects all. Copy, cut and paste work with Excel and Google Sheets, and a paste that runs past the edge adds rows and columns. **Undo / redo** (⌘Z / ⇧⌘Z) covers every change.
- **Rows and columns:** the toolbar inserts rows and columns and deletes rows; right-click a cell or row number for more. Each column's **▾** menu (or right-click on its header) sorts A→Z / Z→A, filters (by ticking values, like Sheets, or by text a cell contains), renames (or double-click the header), inserts or deletes columns, and sets the **phone column**. Drag a column's edge to resize it.
- **Find & replace:** ⌘F or **Find** in the toolbar.
- **Who gets the message:** rows with a tick in their row header, a valid number, and shown by the current filters. Invalid numbers are red in the phone column (hover for why) and can't be ticked; duplicates are amber and sent once. Ten-digit numbers get the default country code added (`91` by default, changeable in Settings).
- **Your file isn't changed:** edits only affect what's sent. **Export** downloads the current sheet, edits included, as CSV.
- **Message panel** (right; hide it with **Message**): template, campaign name, sender numbers, personalisation (each variable from a column or the same text for everyone), a live preview of the row you've clicked, and a test send to yourself.
- **Send bar:** how many people will get the message and why others are skipped (invalid, duplicates, left out, hidden by filters, missing a value), then **Now** or **Later** and **Send**.

## Scheduling

Under **Send**, switch to **Schedule** and pick a date and time. Scheduled campaigns appear under Campaigns, where you can **Send now** or **Cancel** them. **The server must be running at the scheduled time.** If it was off, the campaign sends as soon as the server starts again.
- Each template variable (`{{1}}`, `{{name}}`, header image URL, URL-button suffix) can come from a CSV column or be a fixed value for everyone.

## Delivery and read status

Meta reports delivered, read and failed through a webhook. In the Meta App Dashboard → WhatsApp → Configuration, set:

- **Callback URL:** `https://YOUR-DOMAIN/webhook`
- **Verify token:** shown in the app's Settings page

Then subscribe to the `messages` field. The URL must be public HTTPS. Deploy the app to a server (Render, Railway, a VPS, etc.), or use `ngrok http 3000` while testing.

## Inbox

Replies from customers appear under **Inbox**, laid out like WhatsApp: chats on the left, the conversation on the right. While the Inbox is open, the sidebar shrinks to icons to make room.

- **What arrives:** text, photos, videos, voice notes, documents, stickers, locations, contact cards, button taps and emoji reactions. When someone replies to a specific message, the quote is shown. Media is downloaded once with your number's access token and kept in `data/media/`.
- **The whole conversation:** campaign messages you sent that person appear in the same thread, so you can see what they're replying to.
- **Replying:** WhatsApp allows free-form replies only within **24 hours of the customer's last message**. The chat header shows how long is left. After that, only an approved template can be sent; use **Send template** at the bottom of the chat.
- **New chat** (pencil icon): enter a phone number and pick one of your numbers. The first message must be a template.
- **Live:** new messages appear instantly without refreshing. The sidebar shows the unread count, and you get a notification when a message arrives in a chat you aren't looking at. Opening a chat sends blue ticks to the customer.
- **Demo mode:** **Load demo workspace** includes sample conversations, and replies get simulated ticks.

Replies reach the app through the same webhook as delivery status (see above), so it must be publicly reachable and subscribed to the `messages` field.

## How sending works

- Recipients are split evenly (round-robin) across the selected numbers, and every number sends in parallel.
- Rate-limit errors from Meta are retried with backoff. Speed is set per number in Settings.
- You can stop a campaign, resume it, retry the failed ones, or export results to CSV.

## Important WhatsApp rules

- You can only start conversations with **approved templates**.
- Each number has a **daily limit on unique recipients**. New numbers start low (about 250/day) and the limit grows to 1K, 10K, 100K and unlimited as you send good-quality messages. More numbers means more daily capacity.
- Only message people who **opted in**. Blocks and reports lower your quality rating and can get numbers restricted.
- Meta charges per template message, and the price depends on category and country.

## Icons

The interface uses animated Lucide icons from [lucide-animated](https://lucide-animated.com), ported to plain SVG + CSS in `public/icons.js` (shapes) and `public/style.css` → "Animated icons" (motion). They play when you hover or tab to the button, tab, tile or card they sit in. If "Reduce motion" is turned on in your system settings, they stay still.

To use one in the markup, add `data-icon="name"` to an element. In JavaScript, use `icon('name', size)`. Available names: `send`, `check-check`, `eye`, `badge-alert`, `upload`, `cloud-upload`, `refresh-cw`, `plus`, `delete`, `copy`, `clock`, `search`, `rocket`, `zap`, `layout-grid`, `chart-column-increasing`, `phone`, `file-text`, `settings`, `sun`, `sun-moon`, `moon`, `calendar-days`, `history`, `users`, `circle-check`.

## Look and motion

- **Colour:** the primary colour is black in light mode and white in dark mode, set by the `--accent-*` variables at the top of `public/style.css`. Status colours keep their meaning: green for delivered, read, valid and completed; red for failed and danger actions; amber for warnings; blue for sent; purple for scheduled.
- **Charts** use [D3](https://d3js.org). It's installed with `npm install` and served from the app at `/vendor/d3.min.js`, so it works offline. Bars grow in on first load. On live updates, bars, gridlines and the peak label move smoothly to their new values instead of redrawing.
- **Smooth motion** (`public/motion.js`):
  - Numbers count up, and bars, meters and progress slide from their last value.
  - A ceramic piece slides between options in the tabs and switches.
  - Pages and cards fade up into place, and dialogs and notifications ease out.
  - Switching light/dark mode cross-fades the colours.
- If "Reduce motion" is turned on in your system settings, all of this is switched off.

## Overview filters and charts

- **Filter row** (stays pinned while you scroll): pick 7, 14, 30 or 90 days, one number and one template. Everything below follows it: the four tiles, the chart, the funnel and the recent campaigns. Number health always shows *today* for all numbers, because daily limits reset each day. At 90 days, data is grouped by week.
- **Tiles** compare the period with the previous period of the same length. Counts show percent change. Rates show the change in percentage points, which is more accurate than "percent of a percent". The rate meter has a marker showing where the previous period was.
- **Chart:** click a tile, or use the switch above the chart, to plot Sent, Delivery rate, Read rate or Failed. Counts show as bars and rates as a line. Hover any day to see all four values. **Table** shows the exact numbers, and **Expand** opens a large view with its own controls and a table.

## Sidebar

Collapse the sidebar to icons with the button next to the app name; the choice is remembered. The Inbox starts with it collapsed to make room. On the Assistant page, the chat fills the window below the banner.
