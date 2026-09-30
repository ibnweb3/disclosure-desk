import { composeSummary, fallbackPlan, llmPlan, loadData, quotesFor, rowLines, rTokenList, runPlan, sanitizePlan } from "./desk";
import type { Plan, Quote } from "./desk";
import { bitgetDebug, isMock, marketState } from "./market";
import { gapStudy, takeSnapshot } from "./snapshots";
import type { AppEnv, Disclosure } from "./types";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

const TICKER = /^[A-Z]{1,5}(-[A-Z])?$/;
const cleanWatch = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toUpperCase()).filter((x) => TICKER.test(x)))].slice(0, 20) : [];

/** Fixed-window per-IP counter kept in the edge cache: cheap, no storage binding, good enough to protect a free LLM allocation. */
async function overLimit(request: Request, limit: number): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const key = new Request(`https://ratelimit.internal/ask/${encodeURIComponent(ip)}/${new Date().toISOString().slice(0, 13)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  const n = hit ? Number(await hit.text()) : 0;
  if (n >= limit) return true;
  await cache.put(key, new Response(String(n + 1), { headers: { "cache-control": "max-age=3600" } }));
  return false;
}

async function digest(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ask(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  let body: { q?: unknown; watchlist?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Send JSON: {\"q\": \"...\"}" }, 400);
  }
  const q = typeof body.q === "string" ? body.q.trim().replace(/\s+/g, " ") : "";
  if (q.length < 3 || q.length > 300) return json({ error: "Ask a question between 3 and 300 characters." }, 400);
  const watch = cleanWatch(body.watchlist);
  if (await overLimit(request, 30)) return json({ error: "Rate limit: 30 questions per hour per visitor (keeps the free demo online). Try again later." }, 429);

  const url = new URL(request.url);
  const data = await loadData(env, url.origin);
  const cacheKey = new Request(`https://answers.internal/${await digest(`${q.toLowerCase()}|${watch.join(",")}|${data.length}|${data[0]?.filedDate}`)}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return json({ ...(await hit.json() as object), cached: true });

  const rt = await rTokenList(env, ctx).catch(() => null);
  const rtSet = rt ? new Set(rt.tickers) : null;

  let plan: Plan;
  let planMode: "llm" | "keyword" = "llm";
  let planError: string | null = null;
  try {
    plan = await llmPlan(env, q, watch);
  } catch (e) {
    planError = String(e).slice(0, 160);
    log("planner_fallback", { reason: planError });
    plan = sanitizePlan(fallbackPlan(q, data, watch));
    planMode = "keyword";
  }
  if (plan.mine && watch.length && !plan.tickers.length) plan.tickers = watch;

  let rows: Disclosure[] = runPlan(plan, data, watch, rtSet);
  // the model's filter is nondeterministic and can over-constrain: if it finds nothing, try the keyword reading of the same question
  if (!rows.length && planMode === "llm") {
    const kp = sanitizePlan(fallbackPlan(q, data, watch));
    if (kp.mine && watch.length && !kp.tickers.length) kp.tickers = watch;
    const kr = runPlan(kp, data, watch, rtSet);
    if (kr.length) {
      plan = kp;
      rows = kr;
      planMode = "keyword";
    }
  }
  let relaxedFrom: number | null = null;
  if (!rows.length && plan.sinceDays !== null && plan.sinceDays < 30) {
    relaxedFrom = plan.sinceDays;
    plan.sinceDays = 30;
    rows = runPlan(plan, data, watch, rtSet);
  }
  let quotes: Record<string, Quote> = {};
  let market = await marketState(ctx);
  let mock = isMock(env);
  if (plan.sort === "gap") {
    const cand = [...new Set(rows.map((r) => r.ticker))].slice(0, 24);
    const live = await quotesFor(env, ctx, cand);
    quotes = live.quotes;
    market = live.market;
    mock = live.mock;
    const withGap = rows.filter((r) => quotes[r.ticker]?.gap != null).sort((a, b) => Math.abs(quotes[b.ticker].gap ?? 0) - Math.abs(quotes[a.ticker].gap ?? 0));
    rows = withGap.length ? withGap : rows; // live quotes unavailable: keep the matched rows rather than return nothing
  }
  rows = rows.slice(0, plan.limit);
  if (plan.sort !== "gap" && rows.length) {
    const live = await quotesFor(env, ctx, [...new Set(rows.map((r) => r.ticker))].slice(0, 8));
    quotes = live.quotes;
    market = live.market;
    mock = live.mock;
  }

  const composed = rows.length ? await composeSummary(env, q, rows, quotes, market, mock) : null;
  const summary = composed && "text" in composed ? composed : null;
  const summaryNote = composed && "note" in composed ? composed.note : null;
  const widened = relaxedFrom !== null && rows.length ? `Nothing matched in the last ${relaxedFrom} days, so this widens to 30 days.\n\n` : "";
  const closedNote = !market.open && !summary ? "US equities are closed, so rToken prices are the live reference. " : "";
  const lead = summary ? `${summary.text}\n\n` : `${closedNote}${rows.length} disclosure${rows.length === 1 ? "" : "s"} matched:\n`;
  const tail = summary ? "" : "\n\n(No language-model summary this time; these are the computed numbers.)";
  const answer = !rows.length
    ? "No disclosures matched that filter. Try a wider window (e.g. 'last 30 days') or remove the sector or member constraint."
    : widened + lead + rowLines(rows, quotes).join("\n") + tail;
  const out = {
    answer, mode: summary ? "llm" : "template", model: summary?.model ?? null, planMode, planError, summaryNote, plan,
    ids: rows.map((r) => r.id), market: { state: market.state, nextOpen: market.nextOpen }, mock,
  };
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(out), { headers: { "cache-control": "max-age=120" } })));
  log("ask", { planMode, mode: out.mode, rows: rows.length });
  return json(out);
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, mock: isMock(env), llm: env.LLM_BASE_URL ? "openai-compatible" : env.AI ? "workers-ai" : "none", model: env.LLM_MODEL ?? null });

      if (url.pathname === "/api/market" && request.method === "GET") {
        const [m, rt] = await Promise.all([marketState(ctx), rTokenList(env, ctx).catch(() => null)]);
        return json({ ...m, rTokens: rt ? rt.tickers.length : null, mock: rt?.mock ?? isMock(env) }, 200, { "cache-control": "public, max-age=30" });
      }

      if (url.pathname === "/api/rtokens" && request.method === "GET") {
        try {
          const rt = await rTokenList(env, ctx);
          return json({ ok: true, count: rt.tickers.length, tickers: rt.tickers, mock: rt.mock }, 200, { "cache-control": "public, max-age=60" });
        } catch (e) {
          log("rtokens_error", { error: String(e).slice(0, 160) });
          return json({ ok: false, error: "rToken feed unavailable", tickers: [], count: 0, mock: false }, 200);
        }
      }

      if (url.pathname === "/api/quotes" && request.method === "GET") {
        const t = (url.searchParams.get("t") ?? "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => TICKER.test(s));
        if (!t.length) return json({ error: "Pass ?t=NVDA,AAPL" }, 400);
        const r = await quotesFor(env, ctx, t);
        return json({ ok: true, ...r }, 200, { "cache-control": "public, max-age=10" });
      }

      if (url.pathname === "/api/debug/bitget" && request.method === "GET") {
        if (isMock(env)) return json({ mock: true, note: "MOCK_RTOKENS is on; no real Bitget call was made" });
        const tk = (url.searchParams.get("t") ?? "NVDA").toUpperCase().split(",").filter((s) => TICKER.test(s)).slice(0, 24);
        return json(await bitgetDebug(env, ctx, tk));
      }

      if (url.pathname === "/api/gapstudy" && request.method === "GET") {
        const mock = isMock(env) && url.searchParams.get("mock") === "1";
        return json(await gapStudy(env, mock), 200, { "cache-control": "public, max-age=300" });
      }

      if (url.pathname === "/api/ask" && request.method === "POST") return await ask(request, env, ctx);

      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      log("unhandled", { path: url.pathname, error: String(e).slice(0, 200) });
      return json({ error: "Upstream error, please retry." }, 502);
    }
  },

  /** Cron (every 15 min): record rToken vs equity prices for the recently disclosed names. */
  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      takeSnapshot(env, ctx)
        .then((r) => log("snapshot", r))
        .catch((e) => log("snapshot_error", { error: String(e).slice(0, 160) })),
    );
  },
} satisfies ExportedHandler<AppEnv>;
