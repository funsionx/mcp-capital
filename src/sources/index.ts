import type { FetchPositions } from "../lib/types.ts";
import { fetchPositions as tinkoff } from "./tinkoff.ts";
import { fetchPositions as bybit } from "./bybit.ts";
import { fetchPositions as moex } from "./moex.ts";
import { fetchPositions as evm } from "./evm.ts";
import { fetchPositions as solana } from "./solana.ts";
import { fetchPositions as sui } from "./sui.ts";
import { fetchPositions as near } from "./near.ts";
import { fetchPositions as hyperliquid } from "./hyperliquid.ts";
import { fetchPositions as staticSrc } from "./static.ts";

/**
 * The one place that wires sources into the server.
 *
 * To add a source: create `src/sources/<name>.ts` exporting
 * `fetchPositions(): Promise<PositionItem[]>`, then add a single line here.
 * The tool's `includeSources` enum and the `SourceFilter` type derive from this
 * array automatically — no other file needs to change.
 */
export const SOURCES = [
  { id: "tinkoff", fetch: tinkoff },
  { id: "bybit", fetch: bybit },
  { id: "moex", fetch: moex },
  { id: "evm", fetch: evm },
  { id: "solana", fetch: solana },
  { id: "sui", fetch: sui },
  { id: "near", fetch: near },
  { id: "hyperliquid", fetch: hyperliquid },
  { id: "static", fetch: staticSrc },
] as const satisfies readonly { id: string; fetch: FetchPositions }[];

/** Coarse source token accepted by the tool's `includeSources` filter. */
export type SourceFilter = (typeof SOURCES)[number]["id"];

export const SOURCE_IDS = SOURCES.map((s) => s.id) as [SourceFilter, ...SourceFilter[]];

const BY_ID = new Map<SourceFilter, FetchPositions>(SOURCES.map((s) => [s.id, s.fetch]));

export function fetchFor(id: SourceFilter): FetchPositions {
  return BY_ID.get(id)!;
}
