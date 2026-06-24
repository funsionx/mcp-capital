# portfolio-mcp

An MCP server that returns a normalized snapshot of a personal investment portfolio
(brokers, crypto exchange, blockchains) and tracks returns via SQLite snapshots and
cash flows.

**Full documentation:** [DOC.md](DOC.md) (architecture, security, deploy, all tools).

## Stack

- **Bun** runtime
- `@modelcontextprotocol/sdk` over Streamable HTTP (`Bun.serve`) or stdio
- TypeScript (strict), `zod` for tool schemas
- SQLite (`bun:sqlite`) for snapshots, flows, manual positions

## Setup

```bash
bun install
cp .env.example .env   # fill in your keys/addresses
```

Keyless sources: MOEX ISS, CBR FX, CoinGecko, Jupiter, Sui/NEAR RPC, Hyperliquid info API.

## Run

```bash
bun run start          # HTTP on PORT (default 3000), MCP endpoint /mcp
bun run start:stdio    # stdio transport (Cursor / local spawn)
bun run dev            # watch mode (HTTP)
bun run typecheck      # tsc --noEmit
bun run test:smoke     # protocol smoke test (stdio)
bun run inspector      # MCP Inspector over stdio
```

**HTTP mode requires auth** — set `AUTH_TOKEN` and/or OAuth (`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + `OAUTH_REDIRECT_URIS`). See [DOC.md § Auth](DOC.md#6-аутентификация).

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`.

For **Perplexity** or **ngrok**, use stateless HTTP (default). Point ngrok at the local port, then add `https://<subdomain>.ngrok-free.dev/mcp`.

## MCP Tools (11)

| Tool | Purpose |
|------|---------|
| `get_portfolio_summary` | Live portfolio snapshot (all sources) |
| `snapshot_portfolio` | Save timestamped snapshot for returns |
| `record_flow` | Log external deposit/withdrawal |
| `get_returns` | Modified Dietz return between snapshots |
| `detect_flows` | Auto-detect pending flows (EVM/Bybit/T-Invest) |
| `list_flows` | List flows by status |
| `confirm_flow` / `reject_flow` | Review pending flows |
| `list_manual_positions` | List manual holdings |
| `upsert_manual_position` / `remove_manual_position` | Manage manual holdings |

Details and schemas: [DOC.md § Tools](DOC.md#5-mcp-tools-reference).

## `get_portfolio_summary`

```ts
{
  includeSources?: ("tinkoff"|"bybit"|"moex"|"evm"|"solana"|"sui"|"near"|"hyperliquid"|"static")[],
  minValueUsd?: number   // default 1; pass 0 for everything
}
```

Output: `totalValueUsd`, `totalValueRub`, `sourceBreakdown`, `allocation`, `positions[]`, `errors[]`.

- Sources run in parallel with an **18s timeout** per source.
- Compact JSON, sub-threshold dust hidden from listing but counted in totals.

## Sources

| Filter | Module | Auth |
|--------|--------|------|
| `tinkoff` | T-Invest, all accounts | `TINKOFF_TOKEN` |
| `bybit` | Wallet + perps + Earn | `BYBIT_API_KEY`/`SECRET` |
| `moex` | AKMM via ISS | keyless |
| `evm` | 2 wallets + DeFi (Zerion) | `ZERION_API_KEY`, `EVM_WALLET_1/2` |
| `solana` | SOL + SPL (Helius) | `HELIUS_API_KEY`, `SOLANA_WALLET` |
| `sui` | Spot coins | keyless RPC |
| `near` | NEAR + FT + staking | keyless |
| `hyperliquid` | Perps + spot + vaults | keyless (`HYPERLIQUID_WALLET`) |
| `static` | Manual positions (DB/file/env) | local |

## Return tracking

1. **`snapshot_portfolio`** — periodic snapshots (`on_chat` deduped ≤1/hour).
2. **`detect_flows`** — scan for external deposits/withdrawals → pending.
3. **`confirm_flow`** / **`reject_flow`** — review before flows count in returns.
4. **`get_returns`** — Modified Dietz gain/return % net of confirmed flows.

Workflow details: [DOC.md § Return tracking](DOC.md#return-tracking-workflow).

## Auth

- **Static bearer** — `AUTH_TOKEN`; clients send `Authorization: Bearer <token>`.
- **OAuth 2.1** — `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` + **`OAUTH_REDIRECT_URIS`** (whitelist). Consent page on `/authorize`. Refresh tokens rotate with 90-day TTL.

Both schemes work in parallel on `/mcp`. **Never expose HTTP without auth** — it reveals your net worth.

## Deploy

Recommended VPS: **1 vCPU, 1 GB RAM, 10 GB disk**. Behind HTTPS reverse proxy (Caddy/nginx/Cloudflare Tunnel).

### Docker Compose + Traefik (recommended)

```bash
cp .env.example .env   # AUTH_TOKEN, TRAEFIK_HOST, source keys
docker compose up -d --build
```

Requires external Docker network `proxy-net` (same as your Traefik container). MCP URL: `https://<TRAEFIK_HOST>/mcp`.

| Service | Role |
|---------|------|
| `app` | MCP HTTP :3000 behind Traefik |
| `cron` | UTC scheduler (internal only) |
| volume `pfdata` | SQLite at `/data/portfolio.db` |

Local debug without Traefik: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`

Details: [DOC.md § Deploy](DOC.md#docker-compose--traefik).

## Manual positions

For holdings no API can reach (VTB savings, ЦФА):

1. [`positions.local.json`](positions.local.example.json) (gitignored) — see example file.
2. **`MANUAL_POSITIONS`** env — JSON array of the same shape.

## Adding a source

```ts
// src/sources/<name>.ts
export async function fetchPositions(): Promise<PositionItem[]> { ... }
```

Register in [`src/sources/index.ts`](src/sources/index.ts) — one line. Tool enum updates automatically.

## Known limitations

- **Sui AlphaLend** DeFi not valued yet.
- **Hyperliquid** spot without liquid USD pair → $0.
- **MOEX** quantity hardcoded in `moex.ts`.
- CoinGecko free tier ~30 req/min.

## Notes

- **T-Invest TLS:** Russian Trusted Root CA pinned in [`src/lib/tbankCa.ts`](src/lib/tbankCa.ts).
- Logging to **stderr** only; stdout carries MCP protocol frames.
