# Ember — budgeting and financial independence

An offline-first web app for running a budget and tracking progress toward
financial independence, with receipt scanning that reads the photo on your own
device.

Everything you enter — budgets, transactions, receipt photos, account balances —
is stored in your browser's IndexedDB on the device you entered it on. There is
no account, no server and no sync. The app makes **no network requests at all**
after it loads: even the OCR engine and its language model are served from the
app's own origin.

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
etc.), holdings with cost basis and hand-entered prices, allocation by asset
class and by account, drift from a target mix, blended expense ratio and what it
costs you per year, plus other assets and debts rolled into net worth. Prices are
manual by design — a live quote would mean a network call.

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

## Installing it on a phone

Open the deployed URL on the phone, then:

- **iOS / Safari** — Share → Add to Home Screen
- **Android / Chrome** — the install prompt, or ⋮ → Add to Home screen

It then launches like an app, without browser chrome. A service worker caches
the shell and assets, so after the first visit it opens with no network. Receipt
scanning works offline too, once the first scan has pulled the language model
into cache.

**It has to be HTTPS.** Serving the dev server over your LAN
(`npm run dev -- --host`, then `http://192.168.x.x:5173` on the phone) is fine
for a quick look and the app itself works, but browsers refuse to register a
service worker on a plain-HTTP origin, so there's no install and no offline
mode. GitHub Pages is HTTPS, so it gets the full behaviour.

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
    receiptParser.ts    OCR text → merchant, date, total, line items
    ocr.ts              Tesseract worker, image preprocessing
    db.ts               IndexedDB, migrations, storage quota
    backup.ts           JSON/CSV export and import
    palette.ts          Validated categorical palette, series folding
  components/           Shared UI and the chart layer
  pages/                One file per section
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
- **Prices don't update.** No network means no quotes. Holdings are worth what
  you last typed.
- **Projections are arithmetic, not forecasts.** A single smooth rate of return,
  steady contributions and unchanging spending are all fictions. A portfolio
  averaging 7% still has years down 30%, and the order those years arrive in
  matters as much as the average. This is not investment advice.
- **One device.** No sync. Export/import is the transfer mechanism.

## License

MIT — see [LICENSE.md](LICENSE.md).
