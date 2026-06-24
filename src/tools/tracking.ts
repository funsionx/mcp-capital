import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  writeSnapshot,
  recordFlow,
  flowsBetween,
  latestSnapshot,
  snapshotAtOrBefore,
  snapshotAtOrAfter,
  listFlows,
  setFlowStatus,
  confirmAllPending,
  listManualPositions,
  upsertManualPosition,
  removeManualPosition,
  type Trigger,
  type FlowStatus,
} from "../portfolio/store.ts";
import { computeReturn, periodStart, type Period } from "../portfolio/returns.ts";
import { detectAllFlows } from "../portfolio/detect.ts";
import { ensureManualSeed } from "../sources/static.ts";

const TRIGGERS = ["month_start", "month_end", "daily", "manual", "on_chat"] as const;
const PERIODS = ["today", "7d", "30d", "mtd", "ytd", "all"] as const;
const CATEGORIES = ["stock", "bond", "crypto", "etf", "defi", "mmf", "cfa"] as const;
const NOTE = z.string().max(2000);
const ISO = z.string().max(64);

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

export function registerTrackingTools(server: McpServer): void {
  server.registerTool(
    "snapshot_portfolio",
    {
      title: "Snapshot Portfolio",
      description:
        "Captures the current portfolio and stores it as a timestamped snapshot for " +
        "return tracking. Use trigger 'on_chat' for ad-hoc calls (deduplicated to at " +
        "most one per hour); cron jobs use 'daily' / 'month_start' / 'month_end'; " +
        "'manual' is an explicit user-requested fix.",
      inputSchema: {
        trigger: z.enum(TRIGGERS).describe("What initiated this snapshot."),
      },
    },
    async ({ trigger }) => text(await writeSnapshot(trigger as Trigger)),
  );

  server.registerTool(
    "record_flow",
    {
      title: "Record Cash Flow",
      description:
        "Records an EXTERNAL deposit or withdrawal (money entering/leaving the tracked " +
        "portfolio as a whole — e.g. salary arriving, cashing out to a bank). Do NOT " +
        "record transfers between your own tracked accounts; those net to zero. Flows " +
        "are excluded from investment return so the number reflects performance, not deposits.",
      inputSchema: {
        direction: z.enum(["deposit", "withdraw"]).describe("deposit = money in, withdraw = money out"),
        amountUsd: z.number().positive().max(1e12).describe("Amount in USD (positive)."),
        source: NOTE.optional().describe("Which account it hit, e.g. 'evm_1', 'bybit'."),
        note: NOTE.optional().describe("Free-text note, e.g. 'salary' or 'sold car'."),
        ts: ISO.optional().describe("ISO-8601 time of the flow; defaults to now."),
      },
    },
    async ({ direction, amountUsd, source, note, ts }) => {
      const id = recordFlow({ direction, amountUsd, source, note, ts });
      return text({ recorded: true, id });
    },
  );

  server.registerTool(
    "get_returns",
    {
      title: "Get Portfolio Returns",
      description:
        "Computes investment return between two snapshots over a period, net of external " +
        "cash flows (Modified Dietz). Returns start/end value, net flows, gain in USD, and " +
        "return %. Requires at least two snapshots in range (see snapshot_portfolio).",
      inputSchema: {
        period: z.enum(PERIODS).optional().describe("Preset window (default 30d). Ignored if `from` is set."),
        from: ISO.optional().describe("Custom start ISO-8601 (overrides period)."),
        to: ISO.optional().describe("Custom end ISO-8601 (defaults to latest snapshot)."),
      },
    },
    async ({ period, from, to }) => {
      const end = to ? snapshotAtOrBefore(to) : latestSnapshot();
      if (!end) return text({ error: "No snapshots yet. Call snapshot_portfolio first." });

      const fromTs = from ?? periodStart((period ?? "30d") as Period);
      const start = snapshotAtOrBefore(fromTs) ?? snapshotAtOrAfter(fromTs);
      if (!start || start.id === end.id) {
        return text({ error: "Need at least two snapshots spanning the period.", haveSince: start?.ts ?? null });
      }

      const flows = flowsBetween(start.ts, end.ts);
      return text({ period: from ? "custom" : period ?? "30d", ...computeReturn(start, end, flows) });
    },
  );

  // ── Flow auto-detection + review ──────────────────────────────────────────
  server.registerTool(
    "detect_flows",
    {
      title: "Detect Cash Flows",
      description:
        "Scans EVM wallets (Zerion), Bybit (deposit/withdraw records) and T-Invest " +
        "(cash operations) for external deposits/withdrawals, recording them as PENDING " +
        "flows for review. Transfers between your own accounts/addresses are skipped; " +
        "swaps and DeFi deposits/withdrawals are not flows. Confirm pending flows (some " +
        "may be CEX↔chain internal moves or staking rewards) before they count in returns.",
      inputSchema: {
        sinceDays: z.number().int().min(1).max(365).optional().describe("How far back to scan (default 90)."),
      },
    },
    async ({ sinceDays }) => text(await detectAllFlows(sinceDays ?? 90)),
  );

  server.registerTool(
    "list_flows",
    {
      title: "List Cash Flows",
      description: "Lists recorded flows for review. Defaults to pending (auto-detected, awaiting confirmation).",
      inputSchema: {
        status: z.enum(["confirmed", "pending", "rejected"]).optional().describe("Filter by status (default: pending)."),
        limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 50)."),
      },
    },
    async ({ status, limit }) => text({ flows: listFlows((status as FlowStatus) ?? "pending", limit ?? 50) }),
  );

  server.registerTool(
    "confirm_flow",
    {
      title: "Confirm Pending Flow(s)",
      description: "Marks a pending flow as confirmed so it counts in returns. Pass id, or all=true to confirm every pending flow.",
      inputSchema: {
        id: z.number().int().positive().optional().describe("Flow id to confirm."),
        all: z.boolean().optional().describe("Confirm all pending flows."),
      },
    },
    async ({ id, all }) => {
      if (all) return text({ confirmed: confirmAllPending() });
      if (id == null) return text({ error: "Provide id or all=true." });
      return text({ confirmed: setFlowStatus(id, "confirmed") });
    },
  );

  server.registerTool(
    "reject_flow",
    {
      title: "Reject Flow",
      description: "Marks a flow as rejected (e.g. an internal transfer or reward mis-detected) so it never counts.",
      inputSchema: { id: z.number().int().positive().describe("Flow id to reject.") },
    },
    async ({ id }) => text({ rejected: setFlowStatus(id, "rejected") }),
  );

  // ── Manual positions (deposits, ЦФА, кубышка) ─────────────────────────────
  server.registerTool(
    "list_manual_positions",
    {
      title: "List Manual Positions",
      description: "Lists the manually-tracked positions (deposits, ЦФА, savings) stored in the DB.",
      inputSchema: {},
    },
    async () => {
      await ensureManualSeed();
      return text({ positions: listManualPositions() });
    },
  );

  server.registerTool(
    "upsert_manual_position",
    {
      title: "Add/Update Manual Position",
      description:
        "Creates or updates a manual position by ticker (deposits, ЦФА, кубышка — anything no API can reach). " +
        "Provide valueRub (converted to USD via the CBR rate) or value (USD).",
      inputSchema: {
        ticker: z.string().max(128).describe("Unique id, e.g. 'VTB_KUBYSHKA'."),
        name: z.string().max(512).describe("Display name, e.g. 'Кубышка ВТБ'."),
        valueRub: z.number().min(0).max(1e12).optional().describe("Value in RUB."),
        value: z.number().min(0).max(1e12).optional().describe("Value in USD (if not RUB)."),
        category: z.enum(CATEGORIES).optional().describe("Asset class (default mmf)."),
        currency: z.string().max(16).optional(),
        description: NOTE.optional(),
      },
    },
    async ({ ticker, name, valueRub, value, category, currency, description }) => {
      await ensureManualSeed(); // migrate file/env positions before mutating
      upsertManualPosition({ ticker, name, valueRub, valueUsd: value, category, currency, description });
      return text({ ok: true, ticker });
    },
  );

  server.registerTool(
    "remove_manual_position",
    {
      title: "Remove Manual Position",
      description: "Deletes a manual position by ticker.",
      inputSchema: { ticker: z.string().max(128).describe("Ticker to remove.") },
    },
    async ({ ticker }) => {
      await ensureManualSeed();
      return text({ removed: removeManualPosition(ticker) });
    },
  );
}
