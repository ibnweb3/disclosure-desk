import type { AppEnv, Equity, MarketState, RToken, Universe } from "./types";

const UA = { "user-agent": "DisclosureDesk/0.1 (Bitget AI Hackathon S2 research)" };

/** GET json with an edge cache (per-colo) so a busy demo doesn't hammer upstreams. */
async function cachedJson<T>(url: string, ttl: number, ctx: ExecutionContext): Promise<T> {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as T;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  const body = await res.text();
  ctx.waitUntil(cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } })));
  return JSON.parse(body) as T;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// ---------- Bitget via its official agent MCP ----------
// Bitget's REST hosts answer Cloudflare Workers with 403 (edge-level block), but its official agent MCP
// (https://agent.bitget.com/mcp, the endpoint Bitget publishes for AI agents) is reachable and serves the
// same public market data. Two entries are used: crypto_market (the rToken universe + trading rules)
// and crypto_spot_ticker (live last/bid/ask for one rToken pair).

const MCP_URL = "https://agent.bitget.com/mcp";

interface McpToolResult {
  result?: { isError?: boolean; structuredContent?: { success?: boolean; data?: { results?: unknown } } };
}

class BitgetMcp {
  private headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  private ready: Promise<void> | null = null;
  private id = 1;
  lastError: string | null = null;
  errors: string[] = [];

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const r = await fetch(MCP_URL, {
        method: "POST", headers: this.headers, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "disclosure-desk", version: "0.1" } } }),
      });
      await r.text();
      if (!r.ok) throw new Error(`mcp init ${r.status}`);
      const sid = r.headers.get("mcp-session-id");
      if (sid) this.headers["mcp-session-id"] = sid;
    })();
    return this.ready;
  }

  /** Run one catalog entry; returns its `results` payload or null on any failure. */
  async query<T>(entry: string, params: Record<string, unknown>): Promise<T | null> {
    try {
      await this.init();
      const r = await fetch(MCP_URL, {
        method: "POST", headers: this.headers, signal: AbortSignal.timeout(12000),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name: "do_query", arguments: { entry_id: entry, params } } }),
      });
      const t = await r.text();
      const m = /^data:\s*(\{.*\})\s*$/m.exec(t);
      const j = JSON.parse(m ? m[1] : t) as McpToolResult;
      const sc = j.result?.structuredContent;
      if (j.result?.isError || !sc?.success) {
        this.lastError = `tool error: ${t.slice(0, 240)}`;
        this.errors.push(this.lastError);
        return null;
      }
      return (sc.data?.results ?? null) as T | null;
    } catch (e) {
      this.lastError = String(e).slice(0, 240);
      this.errors.push(this.lastError);
      return null;
    }
  }
}

interface MarketRow {
  exchange?: string; base?: string; status?: string; price_precision?: string; quantity_precision?: string; min_order_amount?: string; min_order_qty?: string;
}

const PAGE = 100;

async function buildUniverse(): Promise<Universe> {
  const mcp = new BitgetMcp();
  const tokens: Universe["tokens"] = {};
  const take = (rows: MarketRow[]) => {
    for (const m of rows) {
      const mm = /^r([A-Z]{1,5})$/.exec(m.base ?? "");
      if (!mm || m.exchange !== "bitget" || m.status !== "online") continue;
      tokens[mm[1]] = { pp: num(m.price_precision) ?? 2, qp: num(m.quantity_precision) ?? 4, minUsdt: num(m.min_order_amount) ?? 10, minQty: num(m.min_order_qty) ?? 0.0001 };
    }
  };
  const fetchPage = (page: number) => mcp.query<MarketRow[]>("crypto_market", { is_rwa: true, market_type: "spot", size: PAGE, page });
  // the server caps pages at 100 rows; fetch them in parallel batches
  const first = await fetchPage(1);
  if (!first || !first.length) return { at: Date.now(), tokens, complete: false };
  const eff = PAGE;
  take(first);
  let complete = first.length < PAGE; // page 1 was already the last page
  let page = 2;
  const MAX_PAGE = 48; // stay under the 50-subrequest limit (1 init + pages)
  while (!complete && page <= MAX_PAGE) {
    const batch = Array.from({ length: Math.min(8, MAX_PAGE - page + 1) }, (_, i) => page + i);
    const results = await Promise.all(batch.map(fetchPage));
    for (const rows of results) {
      if (rows && rows.length) take(rows);
      if (!rows || rows.length < eff) complete = true; // a short (or empty) page is the end
    }
    page += batch.length;
  }
  return { at: Date.now(), tokens, complete };
}

/** Every online Bitget rToken (underlying ticker -> trading rules). Kept in KV; rebuilt after 6 hours (5 minutes if it came back incomplete). */
export async function getUniverse(env: AppEnv, force = false): Promise<Universe | null> {
  if (!force) {
    const kv = (await env.SNAPS.get("rt:universe:v2", "json")) as Universe | null;
    if (kv && Date.now() - kv.at < (kv.complete ? 6 * 3600 * 1000 : 5 * 60 * 1000)) return kv;
  }
  const u = await buildUniverse();
  if (Object.keys(u.tokens).length < 10) return (await env.SNAPS.get("rt:universe:v2", "json")) as Universe | null; // upstream hiccup: keep the old one
  await env.SNAPS.put("rt:universe:v2", JSON.stringify(u), { expirationTtl: 14 * 86400 });
  return u;
}

interface TickerRow {
  last?: number; bid?: number; ask?: number; change_percent?: number; timestamp?: string;
}

/**
 * Public market quotes only (no user data), kept in isolate memory for 20s. The Cache API is deliberately not used per
 * ticker: on the free plan each cache lookup/write counts toward the ~50 subrequests allowed per request, and
 * 24 tickers x (match + put) would starve the quote fetches themselves.
 */
const QUOTE_TTL_MS = 20_000;
const quoteCache = new Map<string, { at: number; q: RToken }>();

/** Live rToken quotes for the given underlying tickers (one MCP session per request, fetched in small parallel batches). */
export async function fetchRTokenQuotes(_ctx: ExecutionContext, uni: Universe, tickers: string[], mcp: BitgetMcp = new BitgetMcp()): Promise<Record<string, RToken>> {
  const out: Record<string, RToken> = {};
  const now = Date.now();
  const todo: string[] = [];
  for (const t of tickers) {
    if (!uni.tokens[t]) continue;
    const hit = quoteCache.get(t);
    if (hit && now - hit.at < QUOTE_TTL_MS) out[t] = hit.q;
    else todo.push(t);
  }
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (t) => {
        const r = await mcp.query<TickerRow>("crypto_spot_ticker", { symbol: `r${t}USDT`, exchange: "bitget" });
        const last = num(r?.last);
        if (!r || last === null || last <= 0) return;
        const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
        const rules = uni.tokens[t];
        const bid = num(r.bid), ask = num(r.ask);
        const q: RToken = {
          symbol: `r${t}USDT`, base: t, last, bid, ask, mid: bid && ask && bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
          chg24h: num(r.change_percent) === null ? null : (num(r.change_percent) as number) / 100,
          ts: Number.isFinite(ts) ? ts : null,
          pricePrec: rules.pp, qtyPrec: rules.qp, minUsdt: rules.minUsdt, minQty: rules.minQty,
        };
        out[t] = q;
        quoteCache.set(t, { at: Date.now(), q });
      }),
    );
  }
  if (quoteCache.size > 2000) for (const [k, v] of quoteCache) if (Date.now() - v.at > QUOTE_TTL_MS) quoteCache.delete(k);
  return out;
}

/** Small health/debug view: universe size and one live quote, to verify the feed from Cloudflare's network. */
export async function bitgetDebug(env: AppEnv, ctx: ExecutionContext, tickers: string[] = ["NVDA"]) {
  const probe = new BitgetMcp();
  const rows = await probe.query<MarketRow[]>("crypto_market", { is_rwa: true, market_type: "spot", size: 3, page: 1 });
  if (!rows) return { ok: false, stage: "mcp crypto_market", error: probe.lastError };
  let uni: Universe | null = null;
  let uniError: string | null = null;
  try {
    uni = await getUniverse(env);
  } catch (e) {
    uniError = String(e).slice(0, 240);
  }
  if (!uni) return { ok: false, stage: "universe", mcpRows: rows.length, error: uniError ?? "universe unavailable" };
  const mcp = new BitgetMcp();
  const got = await fetchRTokenQuotes(ctx, uni, tickers, mcp);
  return { ok: true, rTokens: Object.keys(uni.tokens).length, universeAgeMin: Math.round((Date.now() - uni.at) / 60000), asked: tickers.length, got: Object.keys(got).length, sample: got.NVDA ?? null, errors: [...new Set(mcp.errors)].slice(0, 6) };
}

// ---------- US equities (Yahoo spark: many symbols per call) ----------

interface SparkEntry {
  symbol?: string; close?: Array<number | null>; timestamp?: number[]; fulldayPrice?: number;
}

export async function fetchEquities(tickers: string[], ctx: ExecutionContext): Promise<Record<string, Equity>> {
  const out: Record<string, Equity> = {};
  for (let i = 0; i < tickers.length; i += 20) {
    const chunk = tickers.slice(i, i + 20);
    try {
      const j = await cachedJson<Record<string, SparkEntry>>(
        `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(encodeURIComponent).join(",")}&range=1d&interval=1d`,
        30,
        ctx,
      );
      for (const t of chunk) {
        const e = j[t];
        const closes = (e?.close ?? []).filter((c): c is number => typeof c === "number");
        const last = num(e?.fulldayPrice) ?? (closes.length ? closes[closes.length - 1] : null);
        if (e && last !== null) out[t] = { ticker: t, last, time: e.timestamp?.length ? e.timestamp[e.timestamp.length - 1] : null };
      }
    } catch {
      /* upstream hiccup: leave these tickers out, the UI shows them as unavailable */
    }
  }
  return out;
}

// ---------- market session ----------

const NY = "America/New_York";

/** ISO instant of the next weekday 09:30 America/New_York strictly after `from` (holidays are not modelled). */
function nextOpenAfter(from: Date): Date {
  const parts = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
  const at930 = (y: number, mo: number, d: number): Date => {
    for (const off of [4, 5]) {
      const cand = new Date(Date.UTC(y, mo - 1, d, 9 + off, 30));
      const p = parts(cand);
      if (Number(p.hour) === 9 && Number(p.minute) === 30 && Number(p.day) === d) return cand;
    }
    return new Date(Date.UTC(y, mo - 1, d, 14, 30));
  };
  let probe = new Date(from.getTime());
  for (let i = 0; i < 10; i++) {
    const p = parts(probe);
    const cand = at930(Number(p.year), Number(p.month), Number(p.day));
    if (!["Sat", "Sun"].includes(p.weekday) && cand > from) return cand;
    probe = new Date(probe.getTime() + 24 * 3600 * 1000);
  }
  return new Date(from.getTime() + 24 * 3600 * 1000);
}

export async function marketState(ctx: ExecutionContext): Promise<MarketState> {
  const now = new Date();
  let state: MarketState["state"] = "closed";
  let lastClose: string | null = null;
  try {
    const j = await cachedJson<{ chart: { result?: Array<{ meta: { currentTradingPeriod?: Record<string, { start: number; end: number }> } }> } }>(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=1d",
      60,
      ctx,
    );
    const p = j.chart.result?.[0]?.meta.currentTradingPeriod;
    const t = now.getTime() / 1000;
    if (p?.regular && t >= p.regular.start && t < p.regular.end) state = "open";
    else if (p?.pre && t >= p.pre.start && t < p.pre.end) state = "pre";
    else if (p?.post && t >= p.post.start && t < p.post.end) state = "post";
    if (p?.regular && t >= p.regular.end) lastClose = new Date(p.regular.end * 1000).toISOString();
  } catch {
    /* fall back to "closed" with a calendar-derived next open */
  }
  return { state, open: state === "open", nextOpen: nextOpenAfter(now).toISOString(), lastClose, now: now.toISOString() };
}

// ---------- dev-only mock rTokens ----------

export const MOCK_TICKERS = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "JPM", "V", "UNH", "LLY", "XOM", "HD", "WMT", "NFLX", "CRM", "ORCL", "INTC", "MU", "QCOM", "AMAT", "LRCX", "ASML", "COIN", "MSTR", "PLTR", "SPY", "QQQ"];

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967295;
}

export function mockRTokens(equities: Record<string, Equity>): Record<string, RToken> {
  const out: Record<string, RToken> = {};
  const hour = Math.floor(Date.now() / 3.6e6);
  for (const t of MOCK_TICKERS) {
    const eq = equities[t];
    if (!eq) continue;
    const gap = (hash(t + hour) - 0.5) * 0.04;
    const last = +(eq.last * (1 + gap)).toFixed(3);
    const half = last * 0.0008;
    out[t] = { symbol: `r${t}USDT`, base: t, last, bid: +(last - half).toFixed(3), ask: +(last + half).toFixed(3), mid: last, chg24h: +(gap * 0.6).toFixed(4), ts: Date.now(), pricePrec: 2, qtyPrec: 4, minUsdt: 10, minQty: 0.0001 };
  }
  return out;
}

export function isMock(env: AppEnv): boolean {
  return env.MOCK_RTOKENS === "1";
}
