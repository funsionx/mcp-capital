# portfolio-mcp

An MCP server that returns a single, normalized snapshot of a personal investment
portfolio spread across brokers, a crypto exchange, and several blockchains. One tool,
`get_portfolio_summary`, fans out to all configured sources in parallel and aggregates
everything into USD (and RUB where applicable).

## Stack

- **Bun** runtime
- `@modelcontextprotocol/sdk` over Streamable HTTP (`Bun.serve`) or stdio
- TypeScript (strict), `zod` for the tool schema
- Native `fetch`

## Setup

```bash
bun install
cp .env.example .env   # fill in your own keys/addresses
```

All secrets are your own personal/read-only keys or free developer tiers. Sources that
need no key at all: MOEX ISS, CBR FX, CoinGecko, Jupiter, Sui/NEAR RPC.

## Run

```bash
bun run start          # HTTP on PORT (default 3000), MCP endpoint /mcp
bun run start:stdio    # stdio transport (for Cursor / local spawn)
bun run dev            # watch mode (HTTP)
bun run typecheck      # tsc --noEmit (strict)
bun run inspector      # MCP Inspector over stdio
bun run scripts/smoke.ts   # quick end-to-end protocol check (stdio)
```

HTTP mode reads `PORT`, `HOST`, and `ALLOWED_ORIGINS` from the environment (see `.env.example`).
Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`.

For **Perplexity** or **ngrok**, use stateless HTTP (default): each request gets a fresh MCP session, so proxies do not need to forward `Mcp-Session-Id`. Point ngrok at the local port, then add the connector URL `https://<subdomain>.ngrok-free.dev/mcp` (no trailing slash).

In the Inspector, call `get_portfolio_summary` with no arguments to fetch everything, or
filter, e.g. `{ "includeSources": ["moex", "static", "sui"] }`.

## The tool

**`get_portfolio_summary`**

Input:

```ts
{
  includeSources?: ("tinkoff"|"bybit"|"moex"|"evm"|"solana"|"sui"|"near"|"hyperliquid"|"static")[],
  minValueUsd?: number   // hide positions below this from the listing (default 1; totals still include them). Pass 0 for everything.
}
```

Omit `includeSources` to fetch all. Output (single JSON text block):

```jsonc
{
  "timestamp": "ISO-8601",
  "totalValueUsd": 0,            // over ALL positions (incl. hidden)
  "totalValueRub": 0,           // whole portfolio at the live CBR USD/RUB rate
  "positionCount": 0,            // total positions found
  "sourceBreakdown": { "<source>": { "label": "Friendly name", "valueUsd": 0, "positionCount": 0 } },
  "allocation": {
    "byCategory": { "<category>": { "valueUsd": 0, "pct": 0 } },   // asset class
    "byChain":    { "<chain>": { "valueUsd": 0, "pct": 0 } },      // "offchain" = brokerage/cash
    "stablecoin": { "valueUsd": 0, "pct": 0 }                      // share in USD stables
  },
  "positions": [ /* trimmed, sorted by value desc, >= minValueUsd */ ],
  "hiddenBelowThreshold": { "count": 0, "valueUsd": 0, "minValueUsd": 1 },
  "errors": [ { "source": "...", "error": "..." } ]
}
```

Resilience & token economy:
- Sources run under `Promise.allSettled`, each with an **18s timeout** — one source
  failing or hanging never breaks the rest (it shows up in `errors[]`), and the tool
  always returns within ~18s so the calling agent can't time out on a slow upstream.
- Output is **compact JSON** (no indentation), numbers are rounded, empty fields are
  dropped, and sub-`minValueUsd` dust is excluded from the listing (still summed in
  totals + reported in `hiddenBelowThreshold`) — keeps the response small for the agent.

## Sources

| Filter | Module | What it reads | Auth |
|---|---|---|---|
| `tinkoff` | `sources/tinkoff.ts` | T-Invest portfolio across **all accounts** (auto-discovered via `GetAccounts`), stocks/bonds/ETF enriched per-instrument | `TINKOFF_TOKEN` (account id optional) |
| `bybit` | `sources/bybit.ts` | Unified wallet balances + open linear perps + **Earn** (FlexibleSaving/OnChain) | `BYBIT_API_KEY`/`SECRET` (HMAC) |
| `moex` | `sources/moex.ts` | AKMM money-market fund (182 units) via ISS | keyless |
| `evm` | `sources/evm.ts` | Both EVM wallets, **tokens + DeFi** (deposited/staked/borrowed) via Zerion, all chains incl. Plasma | `ZERION_API_KEY`, `EVM_WALLET_1/2` |
| `solana` | `sources/solana.ts` | Native SOL + SPL tokens via Helius DAS; Jupiter price fallback | `HELIUS_API_KEY`, `SOLANA_WALLET` |
| `sui` | `sources/sui.ts` | Sui spot coins (AlphaLend DeFi not valued yet) | keyless RPC |
| `near` | `sources/near.ts` | Native NEAR + fungible tokens + **staked NEAR** (delegated pools) | keyless |
| `hyperliquid` | `sources/hyperliquid.ts` | HyperCore **perps equity + spot + vault deposits (HLP)** | keyless (`HYPERLIQUID_WALLET`, default `EVM_WALLET_2`) |
| `static` | `sources/static.ts` | ЦФА Альфа + **manual positions** (кубышка ВТБ, etc.) | local (file/env) |

RUB→USD conversion uses the live CBR rate (`lib/usdRub.ts`), cached per invocation.

## Adding a source

Sources are isolated and uniform — each is one file exporting a single function:

```ts
// src/sources/<name>.ts
import type { PositionItem } from "../lib/types.ts";
export async function fetchPositions(): Promise<PositionItem[]> {
  // fetch, normalize into PositionItem[], throw on whole-source failure
}
```

Then register it with **one line** in [`src/sources/index.ts`](src/sources/index.ts):

```ts
export const SOURCES = [
  // ...existing...
  { id: "mynewsource", fetch: mynewsource },
] as const ...;
```

That's it — the tool's `includeSources` enum and the `SourceFilter` type derive from
that array automatically; `tools/portfolio.ts` needs no changes. Shared building blocks:
`lib/http.ts` (`fetchJson` / `fetchText` / `jsonRpc` with timeouts + retries),
`lib/coingecko.ts`, `lib/usdRub.ts`, `lib/stablecoins.ts`, `lib/money.ts`. The server
transports live in `src/server/` and the entry point (`src/index.ts`) just wires them.

## DeFi coverage

- **EVM DeFi** — Zerion returns `deposited`/`staked`/`borrowed` positions across all
  chains (incl. Plasma), tagged `category: "defi"` with `protocol`/`apy` when available.
  Zerion's `no_filter` returns both the decoded deposit **and** the raw receipt/wrapper
  token (e.g. `sUSDC`, `aBasUSDC`) — the same money. We drop the duplicates by keeping
  only `attributes.flags.displayable !== false` (Zerion's own canonical view); tokens
  with no decoded alternative (e.g. `aPlaUSDT0` on Plasma) stay `displayable: true` and
  are kept. When Zerion can't price such a kept asset (`value: null`), USD-stable
  positions are re-priced from quantity at ~$1 (`stableUsd()` in `evm.ts`).
- **Hyperliquid** — perps account equity (`clearinghouseState.marginSummary.accountValue`)
  + spot balances + vault deposits like HLP (`userVaultEquities`). Spot is priced by token
  index from `spotMetaAndAssetCtxs` (spot names collide), only against USD-stable-quoted
  pairs **with >$10k/24h volume** — illiquid/junk tokens are left at $0 to avoid phantom
  valuations (e.g. a stray airdropped token quoted at a stale price).
- **NEAR staking** — delegated stake is discovered via FastNear (`/staking`) and read per
  pool with `get_account_total_balance` (e.g. `here.poolv1.near`), tagged `category:"defi"`.
- **Bybit Earn** — flexible savings / on-chain earn positions, priced via spot tickers.

## Return tracking (snapshots + flows)

Stateful return tracking is stored in **SQLite** (`bun:sqlite`, file at `DB_PATH`,
gitignored). Three extra tools:

- **`snapshot_portfolio`** `{ trigger }` — builds the current portfolio and saves a
  timestamped snapshot. `on_chat` is deduplicated to ≤1/hour; cron uses
  `daily`/`month_start`/`month_end`; `manual` is user-forced.
- **`record_flow`** `{ direction, amountUsd, source?, note?, ts? }` — logs an **external**
  deposit/withdrawal (money entering/leaving the whole portfolio). Transfers between your
  own tracked accounts are NOT flows.
- **`get_returns`** `{ period? | from?, to? }` — return between two snapshots, net of
  flows, via **Modified Dietz** (deposits excluded from gain and time-weighted). Returns
  `gainUsd`, `returnPct`, `netFlowUsd`. Counts manual + **confirmed** flows only.
- **`detect_flows`** `{ sinceDays? }` — scans **EVM** (Zerion tx history), **Bybit**
  (deposit/withdraw records) and **T-Invest** (cash operations) for external flows,
  recording them as `pending`. **`list_flows`** / **`confirm_flow`** (`{id}` or
  `{all:true}`) / **`reject_flow`** review them. Internal moves are skipped/netted: EVM
  transfers to/from own addresses, Bybit withdrawals/deposits to/from own addresses,
  swaps and DeFi deposits/withdrawals. **Both legs of a CEX↔chain transfer reconcile
  automatically** — an EVM leg whose on-chain hash matches a Bybit `txID` is auto-rejected
  (`nettedInternal` in the result).
- **`list_manual_positions`** / **`upsert_manual_position`** / **`remove_manual_position`** —
  manage deposits/ЦФА/кубышка (stored in the `manual_positions` table; seeded once from
  `positions.local.json` / `MANUAL_POSITIONS` on first run).

The data shape: `snapshots(ts, trigger, total_usd, total_rub, breakdown_json,
allocation_json, positions_json)` and `flows(ts, direction, amount_usd, source, note,
auto)`. `buildPortfolio()` in `src/portfolio/build.ts` is shared by the live tool and the
snapshot writer.

**Flows: external vs internal.** A flow is money crossing the *boundary* of the tracked
portfolio. Salary landing on a wallet = external inflow (a flow). Moving funds between
your own EVM_1 ↔ Bybit = internal (nets to zero, not a flow). Today flows are entered
manually; auto-detection (classifying transfers by whether the counterparty is one of
your own addresses) is the planned next step — see the chat notes.

**Auth (set at least one before exposing publicly — it reveals your net worth):**
- **Static bearer** — set `AUTH_TOKEN`; clients send `Authorization: Bearer <token>`
  (Perplexity, manual clients).
- **OAuth 2.1** — set `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` (and `OAUTH_ISSUER` when
  behind ngrok/a proxy). A minimal single-user Authorization Server (auth code + PKCE +
  refresh) is served at `/.well-known/oauth-*`, `/authorize`, `/token`, `/register` in
  [`src/server/oauth.ts`](src/server/oauth.ts). Paste the client id/secret into clients
  that require OAuth (e.g. Claude). Both schemes work simultaneously; `/mcp` accepts
  either a valid OAuth access token or the static bearer.

**Deploying:** behind HTTPS (Caddy auto-TLS or a Cloudflare Tunnel), drive cron triggers
with systemd timers hitting `snapshot_portfolio`. SQLite needs no server; a 1GB VPS is plenty.

## Source display names

`sourceBreakdown[*].label` carries a human-friendly name per source (e.g. `tinkoff` →
"Российский фондовый рынок", `evm_1` → "EVM 1 (The Vault)", `static` → "Депозиты
(<asset names>)"). Edit the map in [`src/lib/labels.ts`](src/lib/labels.ts) — purely
cosmetic, no effect on data.

## Manual positions

For holdings no API can reach (e.g. a VTB savings account / "кубышка"), declare them
manually. Two sources, merged by `ticker` (env overrides file, which overrides built-in
defaults like ЦФА Альфа):

1. **`positions.local.json`** (project root, gitignored) — see
   [`positions.local.example.json`](positions.local.example.json).
2. **`MANUAL_POSITIONS`** env — a JSON array of the same shape.

Each entry: `{ ticker, name, valueRub?|value?(USD), category?, currency?, description? }`.
`valueRub` is converted to USD via the live CBR rate; `value` is used directly.

## Known limitations

- **Sui AlphaLend** position (the wallet's `…::position::PositionCap`) is **not valued
  yet** — no free REST API; needs `@alphafi/alphalend-sdk` or on-chain + Pyth math. The
  EGUSDC coin balance still shows under Sui.
- **Hyperliquid:** spot tokens with no USD-stable-quoted pair are listed at `price: 0`.
  Perps are reported as account equity (not per-position notional) to avoid double-count.
- Sui/NEAR tokens with no CoinGecko mapping are listed at `price: 0` (visible, not
  dropped). Extend the `COIN_COINGECKO` / `FT_COINGECKO` maps to add more.
- CoinGecko free tier is rate-limited (~30 req/min) — fine for an on-demand single call.
- Snapshot only: no historical P&L or cost basis.

## Notes

- **T-Invest TLS:** `*.tbank.ru` chains to the *Russian Trusted Root CA* (Минцифры),
  which isn't in default trust stores (a plain `fetch` fails with
  `SELF_SIGNED_CERT_IN_CHAIN`). That root + sub CA are pinned in
  [`src/lib/tbankCa.ts`](src/lib/tbankCa.ts) and passed as an additional trust anchor —
  TLS verification stays **on** (no `rejectUnauthorized:false`). Root SHA-256 ends
  `…CA:8E:CF:31`.
- **Rate limits:** Zerion (free tier) and CoinGecko calls retry on HTTP 429/5xx with
  backoff that honors `Retry-After`.
- All diagnostic logging goes to **stderr**; stdout carries only MCP protocol frames.
