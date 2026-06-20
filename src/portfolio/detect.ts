import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv, optionalEnv } from "../lib/env.ts";
import { insertAutoFlow } from "./store.ts";

/** Ignore transfers below this USD value (spam/dust). */
const MIN_FLOW_USD = 1;

interface ZerionTx {
  id?: string;
  attributes?: {
    operation_type?: string;
    mined_at?: string;
    transfers?: {
      direction?: string; // "in" | "out"
      value?: number | null;
      sender?: string;
      recipient?: string;
      fungible_info?: { symbol?: string };
    }[];
  };
}

/** The user's own addresses — transfers between these are internal, not flows. */
function ownAddresses(): Set<string> {
  const s = new Set<string>();
  for (const k of ["EVM_WALLET_1", "EVM_WALLET_2"]) {
    const v = optionalEnv(k);
    if (v) s.add(v.toLowerCase());
  }
  // Extra known-own addresses (e.g. CEX deposit addresses) to suppress as internal.
  for (const a of (optionalEnv("OWN_ADDRESSES") ?? "").split(",")) {
    const t = a.trim().toLowerCase();
    if (t) s.add(t);
  }
  return s;
}

/**
 * Detect external cash flows on the EVM wallets from Zerion transaction history.
 *
 * Only `send`/`receive` operations are real external transfers — `trade` is a swap
 * and `deposit`/`withdraw` are wallet↔protocol moves (both internal to the portfolio).
 * A transfer is a flow only if its counterparty is NOT one of the user's own
 * addresses. Detected flows are written as `pending` for review (a CEX withdrawal or
 * a staking reward can look like an external deposit — confirm before counting).
 */
export async function detectEvmFlows(sinceDays = 90): Promise<{
  scanned: number;
  candidates: number;
  inserted: number;
}> {
  const apiKey = requireEnv("ZERION_API_KEY");
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const own = ownAddresses();
  const minMs = Date.now() - sinceDays * 86_400_000;

  const wallets: [string, string][] = [];
  for (const [env, src] of [["EVM_WALLET_1", "evm_1"], ["EVM_WALLET_2", "evm_2"]] as const) {
    const a = optionalEnv(env);
    if (a) wallets.push([a, src]);
  }

  let scanned = 0;
  let candidates = 0;
  let inserted = 0;

  for (const [addr, src] of wallets) {
    const url =
      `https://api.zerion.io/v1/wallets/${addr}/transactions/` +
      `?currency=usd&filter[operation_types]=send,receive&filter[trash]=only_non_trash&page[size]=100`;
    let data: ZerionTx[] = [];
    try {
      const res = await fetchJson<{ data?: ZerionTx[] }>(
        url,
        { headers: { Authorization: auth, accept: "application/json" } },
        { retries: 3 },
      );
      data = res.data ?? [];
    } catch (e) {
      console.error(`[detect] ${src} transactions fetch failed: ${stringifyErr(e)}`);
      continue;
    }

    for (const tx of data) {
      const a = tx.attributes;
      if (!a || (a.mined_at && Date.parse(a.mined_at) < minMs)) continue;
      scanned++;
      if (a.operation_type !== "send" && a.operation_type !== "receive") continue;

      (a.transfers ?? []).forEach((t, i) => {
        const value = t.value ?? 0;
        if (value < MIN_FLOW_USD) return;
        const isIn = t.direction === "in";
        const counterparty = ((isIn ? t.sender : t.recipient) ?? "").toLowerCase();
        if (!counterparty || own.has(counterparty)) return; // internal transfer

        candidates++;
        const ok = insertAutoFlow({
          ts: a.mined_at ?? new Date().toISOString(),
          direction: isIn ? "deposit" : "withdraw",
          amountUsd: value,
          source: src,
          note: `${a.operation_type} ${t.fungible_info?.symbol ?? "?"} ${counterparty.slice(0, 10)}…`,
          extId: `${tx.id}:${i}`,
        });
        if (ok) inserted++;
      });
    }
  }

  return { scanned, candidates, inserted };
}
