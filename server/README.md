# Linking backend

A small server that holds your SnapTrade API keys so the browser never has to.
It stores **nothing** — no database, no sessions, no user records — so losing it
loses nothing but connectivity, and it can be redeployed anywhere at any time.

Its only dependency is the official `snaptrade-typescript-sdk`.

## Why it has to exist

SnapTrade authenticates with a client ID and a consumer key. Those cannot ship
in a web app: anything the browser holds is readable by anyone who opens
devtools, and these keys can enumerate every account connected under them. So
they live here, in an environment variable on a server you control.

## Two modes

| | **Personal** (default) | **Commercial** |
|---|---|---|
| Who is the user | Your API key itself | Users you register |
| Identity stored in the browser | **None** | A `userId`/`userSecret` pair |
| Existing connections | Used as-is | Each user connects their own |
| Right for | One person, one copy | Multi-tenant apps |

Personal mode is the one to use if you're running your own copy. There is no
registration step, calls take no user parameters, and the brokerages already
attached to your key are simply there when you press Sync.

## Try it without an API key

```sh
cd server
npm install
npm run dev:personal   # personal mode, fake brokerage, already "connected"
npm run dev            # commercial mode, register + portal flow
```

Both run on `http://localhost:8787`. In the app: **Settings → Link a brokerage**,
enter that URL, **Test connection**, then **I understand — enable linking**.

`dev:personal` deliberately returns an option position and cash in a second
currency, so you can see how the app flags figures it can't verify.

## Running it for real

### 1. Get keys

From the SnapTrade dashboard's **Build with AI** section: a **Client ID** and a
**Consumer Key**.

### 2. Configure

| Variable | Required | Meaning |
|---|---|---|
| `SNAPTRADE_CLIENT_ID` | yes | Your client ID |
| `SNAPTRADE_CONSUMER_KEY` | yes | Your consumer key — secret |
| `ALLOWED_ORIGINS` | yes | Comma-separated origins allowed to call this |
| `SNAPTRADE_AUTH_MODE` | no | `personal` (default) or `commercial` |
| `PORT` | no | Defaults to 8787 |
| `PROVIDER` | no | `mock` / `mock-personal` for the fake brokerage |

`ALLOWED_ORIGINS` is not optional in practice — an empty value blocks every
browser request rather than allowing them all, because a wildcard would let any
site on the internet drive this backend.

Set these in your host's dashboard, **never in the repo**.

### 3. Deploy

Anywhere running Node 18+ with HTTPS: Render, Railway, Fly.io, a VPS. No build
step, no state, so a free tier that sleeps when idle is fine — the first sync
after a cold start is just slower.

### 4. Point the app at it

**Settings → Link a brokerage** → paste the deployed URL → **Test connection**.
That call exercises your credentials, so a wrong key fails there with a clear
message rather than showing up later as an empty sync.

## Endpoints

All `POST`, JSON in and out.

| Path | Body | Returns |
|---|---|---|
| `/api/link/health` | `{}` | `{ok, provider, mode}` — also verifies credentials |
| `/api/link/register` | `{}` | `{userId, userSecret}` (a sentinel in personal mode) |
| `/api/link/portal` | `{userId?, userSecret?, returnUrl}` | `{redirectUri}` |
| `/api/link/holdings` | `{userId?, userSecret?}` | `{snapshots: [...]}` |
| `/api/link/disconnect` | `{userId?, userSecret?, providerAccountId}` | `{ok}` |

`returnUrl` is validated against `ALLOWED_ORIGINS` — an open redirect here would
be a phishing vector wearing your app's name.

## Why the SDK, and not hand-rolled HTTP

An earlier version of `snaptrade.js` made the HTTP calls directly. Reading the
SDK's actual signing implementation showed it was wrong in five ways, each of
which alone would have returned 401 on every request or corrupted a balance:

1. The consumer key must be `encodeURI`'d before use as the HMAC key.
2. The signed payload uses a **globally sorted key** JSON replacer, not
   insertion order.
3. The signed query must be the **literal string as sent** — sorting it for
   signing while sending it unsorted guarantees a mismatch.
4. The signed path excludes the API base (`/accounts`, not `/api/v1/accounts`).
5. `balances` holds **one entry per currency**, so summing it across
   currencies adds CAD to USD.

None of that is discoverable without the SDK source or a live account to fail
against. Delegating to the SDK removes the whole class of bug.

## What this backend will not guess

Two things are surfaced to the user rather than silently valued:

- **Foreign-currency cash** is never added to an account in another currency.
  This app does no FX conversion; it says so instead.
- **Option positions** are imported but flagged. Equity options are quoted per
  share and held in contracts of 100, and whether SnapTrade's `price` already
  accounts for that could not be verified here. A value wrong by 100× inside a
  net-worth total is worse than an honest "check this".

## Swapping providers

Implement the `Provider` interface in `provider.js` and register it in
`server.js`. The app knows nothing about SnapTrade — only the five endpoints
above and the snapshot shape.

## What the aggregator sees

Your brokerage credentials are entered on SnapTrade's own portal and never
touch this server or the app. SnapTrade does see your balances and holdings —
inherent to any linking service, and the trade you make in exchange for not
typing them in. If that isn't worth it, leave linking off; manual entry drives
every feature identically.
