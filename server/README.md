# Linking backend

A small server that holds your aggregator's API keys so the browser never has
to. Node built-ins only — no dependencies, nothing to `npm install`.

It stores **nothing**. No database, no sessions, no user records. The browser
keeps its own provider identity and sends it with each call, so losing this
server loses nothing but connectivity.

## Why it has to exist

Aggregators (SnapTrade, Plaid) authenticate with a client ID and a consumer
key. Those cannot ship in a web app: anything the browser holds is readable by
anyone who opens devtools, and these keys can enumerate every account connected
under them. So they live here instead, in an environment variable on a server
you control.

This is the honest cost of "link my accounts" in a client-only app. Everything
else in Ember works with no server at all.

## Try it without an aggregator account

```sh
cd server
npm run dev
```

That runs on `http://localhost:8787` with `PROVIDER=mock` — a fake brokerage
with two accounts, fractional shares, a missing cost basis and uninvested cash.
The whole connect → sync → rename → disconnect flow works against it, which is
how the app's linking code is tested.

Then in the app: **Settings → Link a brokerage**, enter
`http://localhost:8787`, press **Test connection**, then **I understand —
enable linking**. Connect from the Investments page.

## Running it for real

### 1. Get SnapTrade credentials

Register at [snaptrade.com](https://snaptrade.com) and obtain a **client ID**
and **consumer key**. SnapTrade is used rather than Plaid because it is built
specifically for brokerage positions — holdings, units and cost basis are
first-class rather than a paid add-on tier.

### 2. Configure

| Variable | Required | Meaning |
|---|---|---|
| `SNAPTRADE_CLIENT_ID` | yes | Your SnapTrade client ID |
| `SNAPTRADE_CONSUMER_KEY` | yes | Your SnapTrade consumer key — secret |
| `ALLOWED_ORIGINS` | yes | Comma-separated origins allowed to call this. Set it to your app's URL. |
| `PORT` | no | Defaults to 8787 |
| `PROVIDER` | no | `mock` for the fake brokerage; anything else uses SnapTrade |

`ALLOWED_ORIGINS` is not optional in practice. A wildcard would let any site on
the internet drive this backend with a stolen user secret, so an empty value
blocks every browser request rather than allowing them all.

```sh
SNAPTRADE_CLIENT_ID=... \
SNAPTRADE_CONSUMER_KEY=... \
ALLOWED_ORIGINS=https://yourname.github.io \
npm start
```

### 3. Deploy

Anywhere that runs Node 18+ and gives you HTTPS: Render, Railway, Fly.io, a
container, a VPS. There is no build step and no state, so a free tier that
sleeps when idle is fine — the first sync after a cold start is just slower.

Set the environment variables in the host's dashboard, never in the repo.

### 4. Point the app at it

**Settings → Link a brokerage** → paste the deployed URL → **Test connection**
→ **I understand — enable linking**.

## ⚠️ The SnapTrade adapter is unverified

`src/snaptrade.js` was written from the published API specification in an
environment with **no outbound network access to SnapTrade**, so it has never
run against the live service. The mock provider and the entire app-side flow
are tested; this file is not.

Two things to check first when you have keys:

1. **Request signing** — `sign()` builds an HMAC over `{content, path, query}`
   with the query in sorted key order. If every call returns 401, this is why.
2. **Response field names** — the `mapAccount` and `mapPosition` helpers read
   several candidate paths per field because SnapTrade nests values
   inconsistently. If balances or symbols come through empty, log a raw
   response and add the actual path.

Start with `/api/link/health`, then `register`, then `holdings`. The app
surfaces backend errors verbatim, so failures are visible rather than silent.

## Endpoints

All are `POST` with a JSON body and a JSON response.

| Path | Body | Returns |
|---|---|---|
| `/api/link/health` | `{}` | `{ok, provider}` |
| `/api/link/register` | `{}` | `{userId, userSecret}` |
| `/api/link/portal` | `{userId, userSecret, returnUrl}` | `{redirectUri}` |
| `/api/link/holdings` | `{userId, userSecret}` | `{snapshots: [...]}` |
| `/api/link/disconnect` | `{userId, userSecret, providerAccountId}` | `{ok}` |

`returnUrl` is validated against `ALLOWED_ORIGINS` — an open redirect here
would be a phishing vector wearing your app's name.

## Swapping providers

Implement the `Provider` interface in `src/provider.js` and export it from
`src/server.js`. The app knows nothing about SnapTrade; it only knows the five
endpoints above and the snapshot shape.

## What the aggregator sees

Your brokerage credentials are entered on the aggregator's own portal and never
touch this server or the app. The aggregator does see your account balances and
holdings — that is inherent to any linking service, and it is the trade you are
making in exchange for not typing them in. If that trade isn't worth it, leave
linking off; manual entry drives every feature identically.
