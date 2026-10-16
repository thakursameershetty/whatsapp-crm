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

All data (numbers, tokens, templates, campaign logs) is saved in `data/db.json`. Back that file up, and never commit it, because it contains your access tokens.

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

## When your API key and templates arrive

1. **Numbers → Add number** for each WhatsApp number: Phone number ID, WhatsApp Business Account (WABA) ID, and a permanent access token. Click **Test connection**.
2. **Templates → Sync from Meta** pulls in all your approved templates.
3. **Settings** → turn **Demo mode off**.
4. **Send**: choose a template and numbers, upload a CSV, map variables, send a test to yourself, then **Send to all**.

Step-by-step instructions for getting the credentials are on the app's Settings page.

## Contacts file

Upload or drag in a **CSV, TSV or Excel (.xlsx/.xls)** file, or paste rows. The first row can be column names:

```csv
phone,name,city
9876543210,Ravi,Pune
919812345678,Priya,Delhi
```

The whole file is shown as a table:

- **Sort:** click a column heading (ascending, descending, then original order).
- **Filter:** every column has a filter box. Columns with only a few different values get a dropdown. In text filters you can type `!text` (doesn't contain), `=text` (exact match), or `>30`, `<=5` (numbers).
- **Select:** click rows to tick them. Click one row, then **Shift+click** another to select every row between them. "Select all filtered" ticks everything that matches the current filters.
- Only ticked rows are sent. A "Number check" column marks invalid and duplicate numbers. Invalid ones can't be selected.
- Ten-digit numbers get the default country code added (`91` by default, which you can change in Settings).

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

## Split view (Send page)

Once a contact file is loaded, **Split view** turns the Send page into a full-height workspace:

- **Left:** your file as a spreadsheet, with gridlines, A/B/C column letters, pinned row numbers and checkboxes, and sort and filter on every column.
- **Right:** a "Message setup" panel (template, numbers, personalisation, preview, test) that scrolls on its own. The send controls stay pinned at its bottom.
- **Resizing:** drag the divider between the two panels to change their widths. Arrow keys work too, and double-click resets. Your layout is remembered.
- **Switching:** the change between stacked and split view is animated. Split view is only offered on wide screens.
