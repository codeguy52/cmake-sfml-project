# Ember — budgeting and financial independence

An offline-first web app for running a budget and tracking progress toward
financial independence, with receipt scanning that reads the photo on your own
device.

Everything you enter — budgets, transactions, receipt photos, account balances —
is stored in your browser's IndexedDB on the device you entered it on. There is
no account and no sync.

Out of the box the app makes **no network requests at all** after it loads: even
the OCR engine and its language model are served from the app's own origin. The
single exception is brokerage linking, which is **off by default** and has to be
switched on deliberately — see [Linking a brokerage](#linking-a-brokerage).

## What it does

**Budget by percentage or by dollar amount, freely mixed.** Every category
claims either a share of your monthly income or a flat amount, and the toggle
between the two converts at your current income rather than resetting. Rent is
naturally a fixed number; savings is naturally a percentage. Subcategories claim
a share of *their parent's* resolved budget, so "80% of housing goes to rent"
stays true when your income changes.

Categories and subcategories can be added, renamed, recolored, reordered and
removed at any time. Deleting a category **keeps** its transactions — they become
uncategorized and can be reassigned, because losing spending history to a budget
edit would be indefensible.

**Receipt scanning on-device.** Photograph a receipt (the camera opens directly
on a phone) and Tesseract reads it locally. The parser pulls out the merchant,
the date and the total, and is deliberately suspicious: it scores total
candidates rather than trusting the first match, refuses lines like `SUBTOTAL`,
`TOTAL SAVINGS` and `CHANGE`, and tolerates OCR turning `TOTAL` into `T0TAL`.
Every field arrives as an editable draft with warnings attached — nothing is
committed until you press Save. Manual entry is always available as a first-class
path, with or without a photo.

**Investments.** Accounts by tax treatment (401(k), IRA, Roth, HSA, taxable,
etc.), holdings with cost basis, allocation by asset class and by account, drift
from a target mix, blended expense ratio and what it costs you per year, plus
other assets and debts rolled into net worth. Enter holdings by hand, import the
positions file your brokerage already exports, or link a brokerage and have them
synced.

**Importing a positions file.** Every brokerage will hand you your holdings as
CSV, or as OFX/QFX from its "download to Quicken" button — including the 401(k)
providers no aggregator reaches. Drop the file in and it is read on your device:
no account, no credentials, no server, nothing sent anywhere.

The parser expects broker exports to be messy, because they are — preamble
lines above the header, disclaimer footers below it, two tables in one file,
`n/a` where a number should be, dollar signs and thousands separators, commas
inside quoted names. Nothing is merged until you have seen what was read: the
review step shows the accounts, positions and totals it found, along with every
row it skipped and every figure it could not reconcile. A position whose stated
value disagrees with its own shares × price is flagged rather than averaged into
a total — that mismatch is usually an option contract of 100.

Re-importing next month's file updates the same accounts in place. It goes
through the identical merge rules as a live sync, so a file only ever speaks for
the accounts inside it: importing one brokerage's export never marks another's
holdings as missing.

**How to invest.** The widely-taught order of operations — starter emergency
fund → employer match → expensive debt → full emergency fund → HSA → IRA →
workplace plan → taxable — evaluated against your own numbers, so it can tell
you that you're $300 a month short of your match rather than describing the
concept. Plus reference material on index funds, fees, account types and risk.
It is framed throughout as education rather than advice, names no products, and
deliberately hardcodes no contribution limits: those change annually, and a
stale figure stated confidently is worse than none.

**Financial independence.** Your FI number from the withdrawal rate you choose,
progress toward it, what your portfolio already covers each month, Coast FI, a
month-by-month projection separating contributions from compounding, savings
rate, and how much the whole picture moves if the withdrawal rate is 3% instead
of 4%.

Everything is expressed in **today's dollars**: rather than inflating the
spending target each year, the expected return is discounted by inflation, so a
7% nominal return with 3% inflation is treated as a ~3.88% real return and the FI
number stays put. Every figure on screen is comparable to what things cost now.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```sh
npm run build      # production build into dist/
npm run preview    # serve the production build
npm test           # unit tests
npm run typecheck  # tsc, no emit
```

`npm run dev` and `npm run build` both run `scripts/vendor-ocr-assets.mjs`
first, which copies the OCR worker, the WebAssembly core and the English
language model out of `node_modules` into `public/tesseract/`. Those files are
git-ignored — they're large and reproducible from the lockfile.

The built output in `dist/` is plain static files and can be served from any
static host, including a subdirectory (asset paths are relative).

## Deploying it

`.github/workflows/deploy.yml` publishes to GitHub Pages. Enable it once under
**Settings → Pages → Source → GitHub Actions**; after that every push to
`master` deploys, and the Actions tab has a "Run workflow" button to deploy from
a branch before merging.

The site lands at `https://<user>.github.io/<repo>/`. Asset paths are relative
and the service worker scopes itself to wherever it's served from, so a
subdirectory deploy works without configuration — as does any other static host
(Netlify, Cloudflare Pages, S3) if you'd rather drag `dist/` somewhere.

## Setting it up on a phone

Open the deployed URL and answer three questions. There is no account to make,
nothing to install first, and nothing to configure — the whole thing is under a
minute of typing:

1. **What do you take home each month?** One number, after tax.
2. **How much of it do you want to keep?** Three starting points — roughly a
   tenth, a fifth, or a third and up. The budget rescales around whichever you
   pick, and every category stays editable afterwards.
3. **Anything saved already?** A rough total and what you add each month, both
   optional. Enough to make the FI projection real on day one.

Then it offers to put the app on your home screen — a real one-tap install on
Android, and the two-tap Share → Add to Home Screen on iOS, where Apple gives
web apps no install API.

Everything after that is optional. You can skip setup entirely and edit the
starting budget by hand, and Settings → Setup → **Run setup again** re-asks the
questions later without touching anything you've recorded.

It then launches like an app, without browser chrome. A service worker caches
the shell and assets, so after the first visit it opens with no network. Receipt
scanning works offline too, once the first scan has pulled the language model
into cache.

Adding your holdings is the one step that can't be done in a few taps from
nothing. The quickest route on a phone is to email yourself your brokerage's
positions export and import the file — "Importing a positions file" under
[What it does](#what-it-does) covers it. Typing a rough total during setup
works too, and the FI numbers are meaningful either way.

**It has to be HTTPS.** Serving the dev server over your LAN
(`npm run dev -- --host`, then `http://192.168.x.x:5173` on the phone) is fine
for a quick look and the app itself works, but browsers refuse to register a
service worker on a plain-HTTP origin, so there's no install and no offline
mode. GitHub Pages is HTTPS, so it gets the full behaviour.

## Linking a brokerage

Optional, off by default, and the only feature that sends anything off your
device. If you want holdings without any of that, import a positions file
instead — it needs no backend, no keys and no network, and it covers accounts
aggregators don't.

Aggregators authenticate with API keys that cannot ship in a web app — anything
the browser holds is readable by anyone with devtools, and those keys can
enumerate every account connected under them. So linking needs a small backend
of your own to hold them. `server/` contains one: a small Node service whose
only dependency is the official SnapTrade SDK. It stores nothing and deploys to
any free tier.

```sh
cd server && npm install && npm run dev:personal
```

Then **Settings → Link a brokerage** → `http://localhost:8787` → **Test
connection** → **I understand — enable linking**. The mock lets you exercise the
whole flow with no SnapTrade account.

Its routing is a plain `Request → Response` function, so the same backend runs
on your machine during development and on Cloudflare Workers or Deno Deploy in
production — both free tiers that stay awake, which matters because a sleeping
host makes the first sync of the day look like a failure. A Node host (Render,
Railway, Fly.io, a VPS) works unchanged.

For real accounts, see [`server/README.md`](server/README.md). Two API keys go
into your host's secret store; nothing is stored on your device, and they never
belong in this repo.

### Personal vs commercial mode

In **personal mode** — the default, and the right one for running your own copy
— your SnapTrade API key *is* the identity. There is no registration step, no
credential on your device, and the brokerages already attached to your key are
simply there when you press Sync. **Commercial mode** is the multi-tenant path,
where each user is registered and issued their own identity.

The backend reports its mode on the health check and the app adapts.

### What a sync does and doesn't touch

| Owned by the provider (replaced each sync) | Owned by you (always kept) |
|---|---|
| Holdings, share counts, prices | Monthly contribution and employer match |
| Account balance and institution | Account type and tax treatment |
| Account name, until you rename it | The name, once you've renamed it |

An account the provider stops returning is **marked, never deleted** — a revoked
connection must not silently wipe the portfolio your FI projection is built on.
Disconnecting keeps the holdings as ordinary manual entries.

In commercial mode the provider credential lives on your device and is
**excluded from exported backups**, since a backup file gets emailed around in a
way the browser's database does not. In personal mode there is no such
credential to leak.

### What a sync will not guess

Two things are flagged rather than silently valued:

- **Foreign-currency cash** is never added to an account in another currency —
  this app does no FX conversion, and says so.
- **Option positions** import with a `! check value` badge. Equity options are
  quoted per share but held in contracts of 100, and whether SnapTrade's price
  already accounts for that could not be verified. A figure wrong by 100× inside
  a net-worth total is worse than an honest prompt to check.

## Backups matter

There is no cloud copy. If you clear your browser's site data, the data is gone.
Settings has:

- **Export backup (JSON)** — the complete dataset, with receipt photos inlined
  (optional, since it makes the file much larger). This is the only way to move
  data to another device.
- **Export transactions (CSV)** — for a spreadsheet or a tax preparer.
- **Restore from backup** — replaces everything currently in the app.

The app also asks the browser for persistent storage and tells you in Settings
whether it was granted. Without it, a browser under storage pressure may evict
the database.

## How it's built

React 19 + TypeScript, Vite, Zustand for state, `idb` for IndexedDB, Recharts
for charts, Tesseract.js for OCR. No backend.

```
src/
  types.ts              Domain model
  store.ts              State and every mutation, with debounced persistence
  lib/
    money.ts            Integer-cent arithmetic and parsing
    budget.ts           Allocation resolution and rollups
    fi.ts               FI number, projections, Coast FI, savings rate
    investments.ts      Portfolio, net worth, rebalancing
    guidance.ts         Order-of-operations engine for the invest tab
    receiptParser.ts    OCR text → merchant, date, total, line items
    ocr.ts              Tesseract worker, image preprocessing
    db.ts               IndexedDB, migrations, storage quota
    backup.ts           JSON/CSV export and import
    palette.ts          Validated categorical palette, series folding
    setup.ts            First-run choices — savings presets, budget rescaling
    install.ts          Add-to-home-screen prompt and per-platform steps
    linking/
      types.ts          Provider-neutral snapshot shape
      client.ts         Talks to your backend; inert until configured
      importHoldings.ts CSV/OFX/QFX broker exports → the same snapshot shape
      sync.ts           Merge rules — what a sync may and may not overwrite
  components/           Shared UI and the chart layer
  pages/                One file per section
server/                 Optional linking backend (see server/README.md)
  src/app.js            Routing, as a Request -> Response function
  src/server.js         Node entry
  src/worker.js         Cloudflare Workers / Deno Deploy entry
scripts/
  vendor-ocr-assets.mjs Copies the OCR runtime into public/
```

Two conventions hold throughout:

- **Money is always an integer number of cents**, never a float dollar amount.
- **Percentages are integer basis points**, where 10,000 bp = 100%.

Both exist so repeated arithmetic can't accumulate binary-float drift in numbers
you'll reconcile against a bank statement. Money parsing reads the typed digits
as strings rather than multiplying a float, because `Number('1.005') * 100` is
`100.49999999999999` — the float route quietly turns $1.005 into $1.00.

The financial logic is covered by unit tests (`npm test`), including that the
projection matches a closed-form annuity, that proportional splits never lose or
invent a cent, and that the receipt parser picks the right total out of realistic
noise.

### Charts

Chart form follows the data's job rather than variety: a ratio against a limit is
a meter, part-to-whole is a horizontal stacked bar, a trend is a line, and the FI
projection is a stacked area that separates contributions from growth. There is
no pie chart and no dual-axis chart anywhere.

Series colors come from a categorical palette validated for colorblind
separation and lightness band in both light and dark mode; the slot **order** is
the safety mechanism, so it isn't cosmetic. Past seven series the tail folds into
a neutral "Other" rather than generating a new hue. Three light-mode slots sit
below 3:1 contrast against the surface, so every chart ships direct labels and a
table view — that's the documented relief, not a nicety.

## Limitations, stated plainly

- **OCR accuracy varies.** Crisp printing scans well; faded thermal paper,
  creases and bad light do not. The workflow assumes you'll check the total.
- **Prices only update when you sync.** Without linking, holdings are worth what
  you last typed or last imported. With it, they are worth what the last sync
  said — there are no live streaming quotes.
- **File import is best-effort across brokers.** It was built against the shapes
  Fidelity, Schwab and Vanguard exports take, plus OFX/QFX, and it is tested
  against those. A broker that formats things differently may need its columns
  recognised; the review step exists so you see what was read before it counts
  toward anything.
- **The real SnapTrade path has never run against the live API.** It is built on
  the official SDK rather than hand-rolled HTTP, which removes the request
  signing as a source of error, but this repo had no network access to SnapTrade
  to prove it end to end. Both mock providers and every app-side path are
  tested; first contact with real data is yours.
- **Projections are arithmetic, not forecasts.** A single smooth rate of return,
  steady contributions and unchanging spending are all fictions. A portfolio
  averaging 7% still has years down 30%, and the order those years arrive in
  matters as much as the average. This is not investment advice.
- **One device.** No sync between devices. Export/import is the transfer
  mechanism, and it deliberately leaves the linking credential behind.
- **The invest tab is education, not advice.** It applies a general rule of
  thumb to numbers you entered. It knows nothing about your tax situation, job
  security, health or family, and it will never name a fund to buy.

## License

MIT — see [LICENSE.md](LICENSE.md).
