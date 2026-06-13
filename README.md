# portfolio-mcp

An MCP server that returns a single, normalized snapshot of a personal investment
portfolio spread across brokers, a crypto exchange, and several blockchains. One tool,
`get_portfolio_summary`, fans out to all configured sources in parallel and aggregates
everything into USD (and RUB where applicable).

## Stack

- **Bun** runtime
- `@modelcontextprotocol/sdk` over stdio
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
bun run start          # run the server over stdio
bun run dev            # watch mode
bun run typecheck      # tsc --noEmit (strict)
bun run inspector      # open the MCP Inspector against this server
bun run scripts/smoke.ts   # quick end-to-end protocol check
```

In the Inspector, call `get_portfolio_summary` with no arguments to fetch everything, or
filter, e.g. `{ "includeSources": ["moex", "static", "sui"] }`.

## The tool

**`get_portfolio_summary`**

Input:

```ts
{ includeSources?: ("tinkoff"|"bybit"|"moex"|"evm"|"solana"|"sui"|"near"|"static")[] }
```

Omit `includeSources` to fetch all. Output (single JSON text block):

```jsonc
{
  "timestamp": "ISO-8601",
  "totalValueUsd": 0,
  "totalValueRub": 0,
  "positionCount": 0,
  "sourceBreakdown": { "<source>": { "valueUsd": 0, "positionCount": 0 } },
  "positions": [ /* PositionItem[] */ ],
  "errors": [ { "source": "...", "error": "..." } ]
}
```

Sources run under `Promise.allSettled`: one source failing never breaks the rest — its
failure shows up in `errors[]`.

## Sources

| Filter | Module | What it reads | Auth |
|---|---|---|---|
| `tinkoff` | `sources/tinkoff.ts` | T-Invest portfolio (stocks/bonds/ETF), enriched per-instrument | `TINKOFF_TOKEN`, `TINKOFF_ACCOUNT_ID` |
| `bybit` | `sources/bybit.ts` | Unified wallet balances + open linear perps | `BYBIT_API_KEY`/`SECRET` (HMAC) |
| `moex` | `sources/moex.ts` | AKMM money-market fund (182 units) via ISS | keyless |
| `evm` | `sources/evm.ts` | Both EVM wallets, **tokens + DeFi** (deposited/staked/borrowed) via Zerion | `ZERION_API_KEY`, `EVM_WALLET_1/2` |
| `solana` | `sources/solana.ts` | Native SOL + SPL tokens via Helius DAS; Jupiter price fallback | `HELIUS_API_KEY`, `SOLANA_WALLET` |
| `sui` | `sources/sui.ts` | Sui coins + **Bluefin Spot LP (DeFi)** from on-chain objects | keyless RPC |
| `near` | `sources/near.ts` | Native NEAR + fungible tokens via FastNear + RPC metadata | keyless |
| `static` | `sources/static.ts` | ЦФА Альфа (50 000 ₽ fixed) | hardcoded |

RUB→USD conversion uses the live CBR rate (`lib/usdRub.ts`), cached per invocation.

## DeFi coverage

- **EVM DeFi** — Zerion returns `deposited`/`staked`/`borrowed` positions, tagged
  `category: "defi"` with `protocol` and `apy` when available.
- **Sui DeFi (Bluefin Spot)** — LP positions are on-chain objects, listed via
  `suix_getOwnedObjects` filtered by the Bluefin `position::Position` type, then valued
  from the pool's current sqrt price + tick range using concentrated-liquidity math
  (`lib/clmm.ts`). This is a floating-point approximation, adequate for portfolio
  valuation. If a single position can't be valued it's still listed (value 0 with a
  note), never dropped.

## Known limitations

- **Bluefin perps** (margin/open perp positions) are **not** covered — there's no free,
  keyless way to read them; it would require an authenticated trading key.
- Sui/NEAR tokens with no CoinGecko mapping are listed at `price: 0` (visible, not
  dropped). Extend the `COIN_COINGECKO` / `FT_COINGECKO` maps in the source files to add
  more.
- CoinGecko free tier is rate-limited (~30 req/min) — fine for an on-demand single call.
- Snapshot only: no historical P&L or cost basis.

## Notes

- All diagnostic logging goes to **stderr**; stdout carries only MCP protocol frames.
