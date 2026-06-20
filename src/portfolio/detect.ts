import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv, optionalEnv } from "../lib/env.ts";
import { insertAutoFlow, rejectInternalByHash } from "./store.ts";
import { isStableSymbol } from "../lib/stablecoins.ts";
import { TBANK_CA } from "../lib/tbankCa.ts";
import { quotationToNumber, type Quotation } from "../lib/money.ts";
import { getUsdRub } from "../lib/usdRub.ts";

/** Ignore transfers below this USD value (spam/dust). */
const MIN_FLOW_USD = 1;

interface ZerionTx {
  id?: string;
  attributes?: {
    operation_type?: string;
    mined_at?: string;
    hash?: string;
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
          txHash: a.hash,
        });
        if (ok) inserted++;
      });
    }
  }

  return { scanned, candidates, inserted };
}

// ── Bybit deposit/withdrawal records ────────────────────────────────────────
interface BybitRow {
  coin?: string;
  chain?: string;
  amount?: string;
  status?: string | number;
  successAt?: string;
  createTime?: string;
  updateTime?: string;
  fromAddress?: string;
  toAddress?: string;
  id?: string;
  withdrawId?: string;
  txID?: string;
}

async function bybitSigned<T>(path: string, query: string): Promise<T> {
  const key = requireEnv("BYBIT_API_KEY");
  const secret = requireEnv("BYBIT_API_SECRET");
  const ts = Date.now().toString();
  const recv = "5000";
  const sign = await hmacHex(secret, ts + key + recv + query);
  const res = await fetchJson<{ retCode: number; retMsg: string; result: T }>(
    `https://api.bybit.com${path}?${query}`,
    { headers: { "X-BAPI-API-KEY": key, "X-BAPI-SIGN": sign, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv } },
  );
  if (res.retCode !== 0) throw new Error(`Bybit ${path} retCode=${res.retCode}: ${res.retMsg}`);
  return res.result;
}

async function bybitUsd(coin: string, amount: number): Promise<number> {
  if (isStableSymbol(coin)) return amount;
  try {
    const r = await fetchJson<{ result?: { list?: { lastPrice?: string }[] } }>(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${coin.toUpperCase()}USDT`,
    );
    return Number(r.result?.list?.[0]?.lastPrice ?? 0) * amount;
  } catch {
    return 0;
  }
}

/** External deposits/withdrawals on Bybit. Transfers to/from the user's own
 * on-chain addresses are internal and skipped (e.g. Bybit→EVM_1 withdrawal). */
export async function detectBybitFlows(
  sinceDays = 90,
): Promise<{ candidates: number; inserted: number; txIds: string[] }> {
  const own = ownAddresses();
  const minMs = Date.now() - sinceDays * 86_400_000;
  let candidates = 0;
  let inserted = 0;
  const txIds: string[] = []; // all on-chain hashes seen — used to net the EVM legs

  const deposits = await bybitSigned<{ rows?: BybitRow[] }>("/v5/asset/deposit/query-record", "limit=50");
  for (const r of deposits.rows ?? []) {
    if (r.txID) txIds.push(r.txID);
    if (String(r.status) !== "3" || Number(r.successAt ?? 0) < minMs) continue;
    if ((r.fromAddress ?? "").toLowerCase() && own.has((r.fromAddress ?? "").toLowerCase())) continue;
    const usd = await bybitUsd(r.coin ?? "", Number(r.amount ?? 0));
    if (usd < MIN_FLOW_USD) continue;
    candidates++;
    if (
      insertAutoFlow({
        ts: new Date(Number(r.successAt)).toISOString(),
        direction: "deposit",
        amountUsd: usd,
        source: "bybit",
        note: `bybit deposit ${r.coin} (${r.chain}) from ${(r.fromAddress ?? "?").slice(0, 10)}…`,
        extId: `bybit-dep:${r.id ?? r.txID}`,
      })
    )
      inserted++;
  }

  const withdrawals = await bybitSigned<{ rows?: BybitRow[] }>("/v5/asset/withdraw/query-record", "limit=50");
  for (const r of withdrawals.rows ?? []) {
    if (r.txID) txIds.push(r.txID);
    const t = Number(r.updateTime ?? r.createTime ?? 0);
    if (r.status !== "success" || t < minMs) continue;
    if ((r.toAddress ?? "").toLowerCase() && own.has((r.toAddress ?? "").toLowerCase())) continue; // internal
    const usd = await bybitUsd(r.coin ?? "", Number(r.amount ?? 0));
    if (usd < MIN_FLOW_USD) continue;
    candidates++;
    if (
      insertAutoFlow({
        ts: new Date(t).toISOString(),
        direction: "withdraw",
        amountUsd: usd,
        source: "bybit",
        note: `bybit withdraw ${r.coin} (${r.chain}) to ${(r.toAddress ?? "?").slice(0, 10)}…`,
        extId: `bybit-wd:${r.withdrawId ?? r.txID}`,
      })
    )
      inserted++;
  }

  return { candidates, inserted, txIds };
}

// ── T-Invest cash operations (пополнение / вывод) ───────────────────────────
interface TinkoffOp {
  id?: string;
  operationType?: string;
  date?: string;
  payment?: Quotation;
}

/** Broker cash deposits/withdrawals (OPERATION_TYPE_INPUT/OUTPUT) — external flows. */
export async function detectTinkoffFlows(sinceDays = 90): Promise<{ candidates: number; inserted: number }> {
  const token = requireEnv("TINKOFF_TOKEN");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
  const HOST = "https://invest-public-api.tbank.ru/rest";
  const tb = <T>(path: string, body: unknown) =>
    fetchJson<T>(`${HOST}/${path}`, { method: "POST", headers, body: JSON.stringify(body) }, { caCert: TBANK_CA });

  const accounts = await tb<{ accounts?: { id: string; name?: string; status?: string }[] }>(
    "tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts",
    { status: "ACCOUNT_STATUS_UNSPECIFIED" },
  );
  const from = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const to = new Date().toISOString();
  const usdRub = await getUsdRub();
  let candidates = 0;
  let inserted = 0;

  for (const acc of (accounts.accounts ?? []).filter((a) => !a.status || a.status === "ACCOUNT_STATUS_OPEN")) {
    let ops: { operations?: TinkoffOp[] };
    try {
      ops = await tb<{ operations?: TinkoffOp[] }>(
        "tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations",
        { accountId: acc.id, from, to, state: "OPERATION_STATE_EXECUTED" },
      );
    } catch (e) {
      console.error(`[detect] tinkoff ops ${acc.id} failed: ${stringifyErr(e)}`);
      continue;
    }
    for (const o of ops.operations ?? []) {
      const type = o.operationType ?? "";
      if (type !== "OPERATION_TYPE_INPUT" && type !== "OPERATION_TYPE_OUTPUT") continue;
      const usd = Math.abs(quotationToNumber(o.payment)) / usdRub;
      if (usd < MIN_FLOW_USD) continue;
      candidates++;
      const isIn = type === "OPERATION_TYPE_INPUT";
      if (
        insertAutoFlow({
          ts: o.date ?? new Date().toISOString(),
          direction: isIn ? "deposit" : "withdraw",
          amountUsd: usd,
          source: "tinkoff",
          note: `t-invest ${isIn ? "пополнение" : "вывод"} — ${acc.name ?? acc.id}`,
          extId: `tinkoff:${o.id}`,
        })
      )
        inserted++;
    }
  }

  return { candidates, inserted };
}

/** Run every flow detector, then net the EVM legs of CEX↔chain transfers. */
export async function detectAllFlows(sinceDays = 90): Promise<Record<string, unknown>> {
  const run = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await fn();
    } catch (e) {
      return { error: stringifyErr(e) };
    }
  };

  const evm = await run(() => detectEvmFlows(sinceDays));
  const bybit = await run(() => detectBybitFlows(sinceDays));
  const tinkoff = await run(() => detectTinkoffFlows(sinceDays));

  // Reject EVM pending flows that are the on-chain leg of a Bybit transfer.
  const bybitTxIds = bybit && "txIds" in bybit ? bybit.txIds : [];
  const nettedInternal = rejectInternalByHash(bybitTxIds);
  const bybitSummary = bybit && "txIds" in bybit ? { candidates: bybit.candidates, inserted: bybit.inserted } : bybit;

  return { evm, bybit: bybitSummary, tinkoff, nettedInternal };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
