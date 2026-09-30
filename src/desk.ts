import { summaryIsGrounded } from "./grounding";
import { chat } from "./llm";
import { fetchEquities, fetchRTokenQuotes, getUniverse, isMock, marketState, mockRTokens, MOCK_TICKERS } from "./market";
import type { AppEnv, Disclosure, Equity, MarketState, RToken, Verdict } from "./types";

// ---------- dataset (public, immutable between deploys/pipeline runs) ----------

let cache: { at: number; rows: Disclosure[] } | null = null;

export async function loadData(env: AppEnv, origin: string): Promise<Disclosure[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.rows;
  const res = await env.ASSETS.fetch(new Request(new URL("/data/disclosures.json", origin)));
  if (!res.ok) throw new Error("dataset unavailable");
  const rows = (await res.json()) as Disclosure[];
  cache = { at: Date.now(), rows };
  return rows;
}

// ---------- live quotes: the 24/7 layer ----------

export interface Quote {
  ticker: string;
  equity: Equity | null;
  rtoken: RToken | null;
  gap: number | null; // rToken last / last regular-session equity price - 1
  spreadBps: number | null;
}

export async function rTokenList(env: AppEnv, _ctx: ExecutionContext): Promise<{ tickers: string[]; mock: boolean }> {
  if (isMock(env)) return { tickers: MOCK_TICKERS, mock: true };
  const uni = await getUniverse(env);
  if (!uni) throw new Error("rToken universe unavailable");
  return { tickers: Object.keys(uni.tokens), mock: false };
}

export async function quotesFor(env: AppEnv, ctx: ExecutionContext, tickers: string[]): Promise<{ quotes: Record<string, Quote>; market: MarketState; mock: boolean }> {
  const uniq = [...new Set(tickers.filter((t) => /^[A-Z]{1,5}(-[A-Z])?$/.test(t)))].slice(0, 24);
  const mock = isMock(env);
  const [equities, market, uni] = await Promise.all([
    fetchEquities(uniq, ctx),
    marketState(ctx),
    mock ? Promise.resolve(null) : getUniverse(env).catch(() => null),
  ]);
  const rt: Record<string, RToken> = mock ? mockRTokens(equities) : uni ? await fetchRTokenQuotes(ctx, uni, uniq).catch(() => ({}) as Record<string, RToken>) : {};
  const quotes: Record<string, Quote> = {};
  for (const t of uniq) {
    const eq = equities[t] ?? null;
    const r = rt[t] ?? null;
    quotes[t] = {
      ticker: t,
      equity: eq,
      rtoken: r,
      gap: eq && r ? (r.mid ?? r.last) / eq.last - 1 : null,
      spreadBps: r && r.bid && r.ask ? ((r.ask - r.bid) / ((r.ask + r.bid) / 2)) * 1e4 : null,
    };
  }
  return { quotes, market, mock };
}

// ---------- question -> filter plan ----------

const SECTORS = ["Tech", "Telecom", "Financials", "Health", "Energy", "Utilities", "Industrials", "Consumer", "Materials", "RealEstate", "Defense", "Transport", "ETF"];
const VERDICTS: Verdict[] = ["OPEN", "PRICED_IN", "REVERSED"];
const FLAGS = ["cluster", "overlap", "late"] as const;

export interface Plan {
  tickers: string[];
  members: string[];
  sectors: string[];
  side: "buy" | "sell" | null;
  verdicts: Verdict[];
  chamber: "house" | "senate" | null;
  party: "D" | "R" | "I" | null;
  states: string[];
  sinceDays: number | null;
  flags: Array<(typeof FLAGS)[number]>;
  rtokenOnly: boolean;
  includeStale: boolean;
  mine: boolean;
  sort: "recent" | "amount" | "missed" | "gap";
  limit: number;
}

const emptyPlan = (): Plan => ({ tickers: [], members: [], sectors: [], side: null, verdicts: [], chamber: null, party: null, states: [], sinceDays: null, flags: [], rtokenOnly: false, includeStale: false, mine: false, sort: "recent", limit: 8 });

const strs = (v: unknown, max = 8): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max) : []);

export function sanitizePlan(raw: unknown): Plan {
  const o = (raw ?? {}) as Record<string, unknown>;
  const p = emptyPlan();
  p.tickers = strs(o.tickers).map((t) => t.toUpperCase().replace(/^\$/, "")).filter((t) => /^[A-Z]{1,5}(-[A-Z])?$/.test(t));
  p.members = strs(o.members).map((m) => m.slice(0, 40));
  p.sectors = strs(o.sectors).filter((s) => SECTORS.includes(s));
  p.side = o.side === "buy" || o.side === "sell" ? o.side : null;
  p.verdicts = strs(o.verdicts).filter((v): v is Verdict => (VERDICTS as string[]).includes(v));
  p.chamber = o.chamber === "house" || o.chamber === "senate" ? o.chamber : null;
  p.party = o.party === "D" || o.party === "R" || o.party === "I" ? o.party : null;
  p.states = strs(o.states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
  p.sinceDays = typeof o.sinceDays === "number" && o.sinceDays > 0 ? Math.min(Math.round(o.sinceDays), 120) : null;
  p.flags = strs(o.flags).filter((f): f is (typeof FLAGS)[number] => (FLAGS as readonly string[]).includes(f));
  p.rtokenOnly = o.rtokenOnly === true;
  p.includeStale = o.includeStale === true;
  p.mine = o.mine === true;
  p.sort = o.sort === "amount" || o.sort === "missed" || o.sort === "gap" ? o.sort : "recent";
  p.limit = typeof o.limit === "number" ? Math.max(1, Math.min(Math.round(o.limit), 12)) : 8;
  return p;
}

/** Deterministic keyword planner: keeps the desk working when the LLM is unavailable or rate-limited. */
export function fallbackPlan(q: string, data: Disclosure[], watch: string[]): Plan {
  const p = emptyPlan();
  const ql = q.toLowerCase();
  const known = new Set(data.map((d) => d.ticker));
  for (const tok of q.match(/\$?\b[A-Z]{1,5}\b/g) ?? []) {
    const t = tok.replace("$", "");
    if (known.has(t)) p.tickers.push(t);
  }
  const lastNames = new Map<string, string>();
  for (const d of data) {
    const ln = d.member.replace(/,.*$/, "").trim().split(/\s+/).pop()?.toLowerCase();
    if (ln && ln.length > 3) lastNames.set(ln, d.member);
  }
  for (const [ln, full] of lastNames) if (new RegExp(`\\b${ln}\\b`).test(ql)) p.members.push(full);
  if (/\b(bought|buy|buys|purchase|purchased|buying)\b/.test(ql)) p.side = "buy";
  if (/\b(sold|sell|sells|sale|selling)\b/.test(ql)) p.side = "sell";
  if (/priced.?in|already moved|too late/.test(ql)) p.verdicts.push("PRICED_IN");
  if (/still open|open|not moved|hasn.?t moved/.test(ql)) p.verdicts.push("OPEN");
  if (/revers|against them|went down after/.test(ql)) p.verdicts.push("REVERSED");
  if (/\bsenat/.test(ql)) p.chamber = "senate";
  if (/\bhouse\b|\brepresentative/.test(ql)) p.chamber = "house";
  if (/democrat/.test(ql)) p.party = "D";
  if (/republican|gop/.test(ql)) p.party = "R";
  if (/independent/.test(ql)) p.party = "I";
  if (/cluster|several members|multiple members|multiple politicians/.test(ql)) p.flags.push("cluster");
  if (/committee|conflict|oversee|jurisdiction/.test(ql)) p.flags.push("overlap");
  if (/\blate\b|overdue|45 day/.test(ql)) p.flags.push("late");
  if (/rtoken|24\/7|weekend|after.?hours|gapping|reopen|monday/.test(ql)) { p.rtokenOnly = true; if (/gap|reopen|monday|moving/.test(ql)) p.sort = "gap"; }
  if (/\bmy\b|watchlist|holdings|portfolio/.test(ql) && watch.length) { p.mine = true; }
  if (/biggest|largest|most money/.test(ql)) p.sort = "amount";
  const dm = /(\d+)\s*(day|week|month)/.exec(ql);
  if (dm) p.sinceDays = Math.min(120, Number(dm[1]) * (dm[2] === "week" ? 7 : dm[2] === "month" ? 30 : 1));
  else if (/today|yesterday/.test(ql)) p.sinceDays = 2;
  else if (/this week|past week|last week/.test(ql)) p.sinceDays = 7;
  else if (/this month|past month|last month/.test(ql)) p.sinceDays = 30;
  for (const [w, s] of [["semiconductor", "Tech"], ["chip", "Tech"], ["tech", "Tech"], ["bank", "Financials"], ["financ", "Financials"], ["pharma", "Health"], ["health", "Health"], ["biotech", "Health"], ["energy", "Energy"], ["oil", "Energy"], ["defense", "Defense"], ["etf", "ETF"]] as const)
    if (ql.includes(w) && !p.sectors.includes(s)) p.sectors.push(s);
  return p;
}

export async function llmPlan(env: AppEnv, q: string, watch: string[]): Promise<Plan> {
  const today = new Date().toISOString().slice(0, 10);
  const system = `You translate a trader's question about US Congress stock-trade disclosures into ONE JSON filter object. Output only the JSON, no prose, no markdown.
Optional fields: tickers (string[] of uppercase US tickers), members (string[] surnames or full names), sectors (subset of ${SECTORS.join("|")}), side ("buy"|"sell"), verdicts (subset of OPEN|PRICED_IN|REVERSED), chamber ("house"|"senate"), party ("D"|"R"|"I": Democrats, Republicans, independents), states (string[] of two-letter US state codes for the member's state), sinceDays (int, disclosed within the last N days), flags (subset of cluster|overlap|late), rtokenOnly (bool), includeStale (bool), mine (bool: the question is about my watchlist/holdings), sort ("recent"|"amount"|"missed"|"gap"), limit (1-12).
Meanings: verdict OPEN = the price has not yet moved in the member's favour since their trade; PRICED_IN = it already has; REVERSED = it moved against them. "gapping", "moving now", "reopen", "weekend" => rtokenOnly true and sort "gap". Today is ${today}.`;
  const r = await chat(env, [{ role: "system", content: system }, { role: "user", content: `Question: ${q}${watch.length ? `\nMy watchlist: ${watch.join(", ")}` : ""}` }], { maxTokens: 220, temperature: 0 });
  const m = /\{[\s\S]*\}/.exec(r.text);
  if (!m) throw new Error("planner returned no json");
  return sanitizePlan(JSON.parse(m[0]));
}

// ---------- execution ----------

export function runPlan(plan: Plan, data: Disclosure[], watch: string[], rtokens: Set<string> | null): Disclosure[] {
  const names = plan.members.map((m) => m.toLowerCase());
  const mineSet = new Set(watch);
  let rows = data.filter((d) => {
    if (!plan.includeStale && d.stale && !plan.sinceDays) return false;
    if (plan.tickers.length && !plan.tickers.includes(d.ticker)) return false;
    if (names.length && !names.some((n) => d.member.toLowerCase().includes(n))) return false;
    if (plan.sectors.length && !(d.sector && plan.sectors.includes(d.sector))) return false;
    if (plan.side && d.side !== plan.side) return false;
    if (plan.verdicts.length && !plan.verdicts.includes(d.a.verdict)) return false;
    if (plan.chamber && d.chamber !== plan.chamber) return false;
    if (plan.party && d.party !== plan.party) return false;
    if (plan.states.length && !(d.state && plan.states.includes(d.state))) return false;
    if (plan.sinceDays !== null) {
      const cutoff = new Date(Date.now() - plan.sinceDays * 86400000).toISOString().slice(0, 10);
      if (d.filedDate < cutoff) return false;
    }
    if (plan.flags.includes("cluster") && !d.flags.cluster) return false;
    if (plan.flags.includes("overlap") && !d.flags.overlap.length) return false;
    if (plan.flags.includes("late") && !d.flags.late) return false;
    if (plan.rtokenOnly && rtokens && !rtokens.has(d.ticker)) return false;
    if (plan.mine && mineSet.size && !mineSet.has(d.ticker)) return false;
    return true;
  });
  const amt = (d: Disclosure) => d.amountHi ?? d.amountLo ?? 0;
  if (plan.sort === "amount") rows = rows.sort((a, b) => amt(b) - amt(a));
  else if (plan.sort === "missed") rows = rows.sort((a, b) => (b.a.rTotal ?? -9) - (a.a.rTotal ?? -9));
  else rows = rows.sort((a, b) => (a.filedDate < b.filedDate ? 1 : a.filedDate > b.filedDate ? -1 : b.tradeDate.localeCompare(a.tradeDate)));
  return rows;
}

// ---------- answer ----------

const pct = (x: number | undefined | null, d = 1) => (x === undefined || x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const usd = (n: number | null) => (n === null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `$${Math.round(n / 1000)}K`);

export function compact(d: Disclosure, q?: Quote) {
  const notes: string[] = [];
  if (d.flags.cluster) notes.push(`cluster: ${d.flags.cluster + 1} members ${d.side === "buy" ? "bought" : "sold"} it within 30 days`);
  if (d.flags.overlap.length) notes.push(`member sits on ${d.flags.overlap[0]} (oversees ${d.sector})`);
  if (d.flags.late) notes.push(`filed ${d.lagDays} days after the trade (STOCK Act limit is 45)`);
  if (d.stale) notes.push(`trade is ${d.ageDays} days old (stale)`);
  return {
    id: d.id, member: `${d.member}${d.party ? ` (${d.party}-${d.state})` : ""}`, chamber: d.chamber,
    action: `${d.side} ${d.ticker}${d.company ? ` (${d.company})` : ""}`, sector: d.sector,
    size: `${usd(d.amountLo)}-${usd(d.amountHi)}${d.lots > 1 ? ` (summed over ${d.lots} lots)` : ""}`, traded: d.tradeDate, filed: d.filedDate,
    verdict: d.a.verdict, verdictWhy: d.a.why,
    movedBeforeFiling: pct(d.a.rBefore), movedSinceFiling: pct(d.a.rSince), missedSinceTrade: pct(d.a.rTotal),
    notes,
    rtoken: q?.rtoken ? { symbol: q.rtoken.symbol, price: q.rtoken.mid ?? q.rtoken.last, vsLastEquityClose: pct(q.gap, 2), spreadBps: q.spreadBps === null ? null : Math.round(q.spreadBps) } : null,
  };
}

/** The cited, fully deterministic part of every answer: numbers come from code, never from the model. */
export function rowLines(rows: Disclosure[], quotes: Record<string, Quote>): string[] {
  return rows.map((d) => {
    const q = quotes[d.ticker];
    const rt = q?.rtoken ? ` ${q.rtoken.symbol} ${(q.rtoken.mid ?? q.rtoken.last).toFixed(2)} (${pct(q.gap, 2)} vs the stock).` : "";
    const lots = d.lots > 1 ? ` (${d.lots} lots)` : "";
    return `- ${d.member} ${d.side === "buy" ? "bought" : "sold"} ${d.ticker}${lots} on ${d.tradeDate}, disclosed ${d.filedDate} (${d.lagDays}d lag): ${d.a.rTotal === undefined ? `${d.a.verdict}: ${d.a.why ?? "no verdict"}` : `${d.a.verdict.replace("_", " ")}, ${pct(d.a.rTotal)} vs SPY since the trade.`}${rt} [${d.id}]`;
  });
}

export async function composeSummary(env: AppEnv, q: string, rows: Disclosure[], quotes: Record<string, Quote>, market: MarketState, mock: boolean): Promise<{ text: string; model: string } | { note: string }> {
  const payload = rows.map((d) => compact(d, quotes[d.ticker]));
  const system = `You are the analyst inside Disclosure Desk, a research tool for US Congress stock-trade disclosures and Bitget rTokens (tokenized US stocks).
Write a read of the disclosures below for a retail trader: 2 or 3 sentences, at most 60 words, plain text.
Rules:
- Use only facts and numbers that appear in the JSON rows. Do not round or compute new numbers.
- Do NOT list the rows one by one; they are listed separately below your text. Do not add citations. Do not state how many rows there are and do not use number words (one, two, three...) for quantities: the count is shown separately. Say "these names" or "most of them" instead.
- Say what stands out: how many are already priced in vs still open, any cluster, committee overlap or late filing, and what the rToken gap shows if present.
- Never predict prices and never tell the user to buy or sell.
- ${market.open ? "US equities are open now." : "US equities are CLOSED now, so the rToken price is the only live reference."}${mock ? " The rToken quotes are MOCK development data; say so." : ""}`;
  let note = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const nudge = attempt ? String.fromCharCode(10) + "Your previous text was rejected because it used a count or a number that is not in the rows. Rewrite it with no counts, no number words and no figures except ones copied from the rows." : "";
      const r = await chat(env, [{ role: "system", content: system }, { role: "user", content: `Question: ${q}` + String.fromCharCode(10) + `Rows: ${JSON.stringify(payload)}` + nudge }], { maxTokens: 300, temperature: attempt ? 0 : 0.2 });
      const text = r.text.replace(/\[[HS]-[A-Za-z0-9-]+\]/g, "").trim();
      if (!text) { note = "empty summary"; continue; }
      if (!summaryIsGrounded(text, payload, rows.length)) { note = `rejected as ungrounded (attempt ${attempt + 1}): ${text.slice(0, 160)}`; continue; }
      return { text, model: r.model };
    } catch (e) {
      note = `model error: ${String(e).slice(0, 160)}`;
    }
  }
  return { note };
}
