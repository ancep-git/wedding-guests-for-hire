# Friends Included Ltd — finance system (Day 4 homework)

Ance Petrovica · Wedding Guests for Hire

Staff report sales and expenses through **Telegram** or the **website**. The manager approves them, and the records and financial results update automatically.

| Part | Its job |
|---|---|
| Telegram bot | Staff submissions, confirmations, manager-decision notifications |
| Supabase | Source of truth: employees, Telegram links, transactions, proposals and decisions |
| Vercel | Website (role selector, forms, manager decisions, dashboard) and the API (`/api/*`) |
| Google Sheets | Automatically updated, read-only copy (tabs `Sales` and `Expenses`) |

The system uses fixed rules only. It needs no AI model or paid AI API.

## How it works

* `lib/rules.js` holds the business rules: validation, permissions, the 10% commission pool, cent rounding (any remainder goes to the largest share; on a tie, Richard, then Anastasia, then Jean-Claude), results and message texts.
* `lib/service.js` is the **single processing layer**. The Telegram webhook (`api/telegram.js`) and the website API (`api/action.js`) both call it, so they apply the same validation, permissions and calculations. Every action re-checks the role on the server, so hiding a button is never the only protection.
* Approval is a conditional update (`… where status = 'pending'`). Approving twice cannot create a second commission or a second expense.
* Sheets rows are inserted or updated **by reference**. Approving or retrying overwrites the same row and never appends a second one.
* Sheet sync and Telegram delivery are tracked separately from the financial decision (`sync_status`, `notify_status`). A failure leaves the saved transaction in place, appears on the record, and has a **Retry** button.
* Bot submissions store their originating chat ID and are notified there later, even after the Telegram account is re-linked. Website entries notify the employee's linked chat at decision time. If no chat is linked, the record shows "No Telegram recipient linked".

## Setup (one time, about 30 minutes)

Never put secrets in GitHub, the website or the spreadsheet. They go only in **Vercel → Project → Settings → Environment Variables**.

### 1. Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`. Choose a name and a username ending in `bot`.
2. Copy the token BotFather sends you into `TELEGRAM_BOT_TOKEN`. Put the username (without the @) into `TELEGRAM_BOT_USERNAME`.
3. Invent a long random string (letters and digits only) for `TELEGRAM_WEBHOOK_SECRET`.

### 2. Supabase
1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Go to **Project Settings → API**. Copy the Project URL into `SUPABASE_URL` and the `service_role` key into `SUPABASE_SERVICE_ROLE_KEY`. Use the service_role key, not the anon key. It is a server-side secret.

### 3. Google Sheets (service account)
1. At console.cloud.google.com, create a project. Then go to **APIs & Services → Library → Google Sheets API → Enable**.
2. Go to **IAM & Admin → Service Accounts → Create service account** (no roles needed). Open it, then choose **Keys → Add key → JSON** to download a key file.
3. Create a new Google Sheet. **Share** it with the service account's email (`…@….iam.gserviceaccount.com`) as **Editor**. The app creates the `Sales` and `Expenses` tabs and their headers itself.
4. Put the whole JSON file content into `GOOGLE_SERVICE_ACCOUNT_JSON`. Put the sheet ID into `GOOGLE_SHEET_ID`; it is the long part of the sheet URL between `/d/` and `/edit`.
5. Share the sheet with your instructor as **Viewer**. Do not give anyone public edit access.

### 4. Vercel
1. Go to **vercel.com/new**, import `ancep-git/wedding-guests-for-hire`, and keep the framework preset **Other**. Deploy.
2. Add the environment variables from `.env.example`, then **Redeploy**.
3. Open the site, choose **Svetlana** as the demonstration role, and click **Manager setup → Register Telegram webhook**. Under *Integrations*, every item should show "configured".

| Variable | Example |
|---|---|
| `SUPABASE_URL` | `https://abcd.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret |
| `TELEGRAM_BOT_TOKEN` | secret |
| `TELEGRAM_BOT_USERNAME` | `friends_included_bot` |
| `TELEGRAM_WEBHOOK_SECRET` | secret random string |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret (whole key file) |
| `GOOGLE_SHEET_ID` | `1AbC…` |
| `GITHUB_REPO_URL` | `https://github.com/ancep-git/wedding-guests-for-hire` |
| `STUDENT_NAME` | `Ance Petrovica` |
| `ALLOW_RESET` | `true` only while clearing practice data; then remove it and redeploy |

## Running the two tests

**First milestone:** send one bot transaction, then confirm it appears in Supabase, on the website, and in the sheet. After that, clear the practice data (Manager setup → *Delete all transactions*, which needs `ALLOW_RESET=true`).

**Test 1**
1. Open the bot and press **Start**. It replies with your Telegram user ID.
2. On the website, act as Svetlana. In Manager setup, link your ID to **Richard**. In the bot, send:
   `/sale S01 | Olivia Rose | A | One proud uncle and an emotional grandmother | 1000 | 50/30/20`
3. Change the link to **Kevin**, then send:
   `/expense E01 | Rented suit and fake pearl necklace for the relatives | Materials | 120 | A`
4. On the website, enter S02 as Anastasia, and E02 and E03 as Kevin.
5. Act as Svetlana and make the decisions: approve S01, change S02 to 20/40/40 and approve, confirm E01 as A, and change E02 to A.

**Test 2**
1. Enter S03–S05 and E04–E07 on the website.
2. Link your Telegram ID to **Jean-Claude**, then approve S03 with the split changed to 20/30/50.
3. Approve S04. Leave S05 pending.
4. Link your Telegram ID to **Kevin**. Confirm E04 as B and change E05 to B. Leave E07 awaiting allocation.

Expected results after both tests:

| Measure | Project A | Project B | Company |
|---|---:|---:|---:|
| Result | €2,050 | €2,180 | €3,930 |

Expected commission: Richard €140, Anastasia €175, Jean-Claude €215.

**Failure checks:** In Manager setup, turn on *Simulate Google Sheets outage* or *Simulate Telegram delivery failure*. Make an entry or a decision: it is saved, and the record shows *Sync failed* or *Notification failed*. Turn the simulation off and press **Retry**. The same row is restored and the totals do not change.

## Automated tests

```
npm test                 # Test 1, Test 2, rule enforcement, Sheets/Telegram failure and retry, rounding
npm run dev              # local site on http://localhost:3000 (in-memory store when Supabase env is absent)
```

There are no npm dependencies. The project uses Node 18+ `fetch` and `crypto`, including for Google's service-account JWT.
