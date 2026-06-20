import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  writeSnapshot,
  recordFlow,
  flowsBetween,
  latestSnapshot,
  snapshotAtOrBefore,
  snapshotAtOrAfter,
  type Trigger,
} from "../portfolio/store.ts";
import { computeReturn, periodStart, type Period } from "../portfolio/returns.ts";

const TRIGGERS = ["month_start", "month_end", "daily", "manual", "on_chat"] as const;
const PERIODS = ["today", "7d", "30d", "mtd", "ytd", "all"] as const;

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
        amountUsd: z.number().positive().describe("Amount in USD (positive)."),
        source: z.string().optional().describe("Which account it hit, e.g. 'evm_1', 'bybit'."),
        note: z.string().optional().describe("Free-text note, e.g. 'salary' or 'sold car'."),
        ts: z.string().optional().describe("ISO-8601 time of the flow; defaults to now."),
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
        from: z.string().optional().describe("Custom start ISO-8601 (overrides period)."),
        to: z.string().optional().describe("Custom end ISO-8601 (defaults to latest snapshot)."),
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
}
