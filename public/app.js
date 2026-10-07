// Disclosure Desk - single-file client. No build step; every dynamic string goes through esc().
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};

// ---------- formatting ----------
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const cls = (x) => (x == null ? "" : x >= 0 ? "up" : "down");
const usdK = (n) => (n == null ? "?" : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`);
const amount = (d) => (d.amountLo == null && d.amountHi == null ? "amount not stated" : `${usdK(d.amountLo)}–${usdK(d.amountHi)}`);
const dShort = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "?");
const px = (n) => (n == null ? "n/a" : n >= 10 ? n.toFixed(2) : n.toFixed(4));
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const inDur = (ms) => {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
};

// The same three outcomes everywhere, in plain words. Keys are the pipeline's internal names.
const VERDICT = { OPEN: "Still early", PRICED_IN: "Too late", REVERSED: "Went the other way", UNCLEAR: "Can't tell", INVALID: "Date error" };
const VERDICT_HELP = {
  "": "Each trade is labelled by what the stock has done since: still early, too late, or gone the other way.",
  OPEN: "Still early: the stock hasn't clearly moved past the member's entry, so following now wouldn't obviously be late.",
  PRICED_IN: "Too late: the stock had already moved their way, so following now means paying for a move they already got.",
  REVERSED: "Went the other way: the stock moved against the member after the trade.",
};
/** "moved 4.0% their way" / "moved 5.3% against them" (against the overall market, in the member's direction). */
const moveText = (a) => (a.rTotal == null ? "" : `moved ${Math.abs(a.rTotal * 100).toFixed(1)}% ${a.rTotal >= 0 ? "their way" : "against them"}`);
const plainVerdicts = (s) => s.replace(/\bPRICED[ _]IN\b/g, "Too late").replace(/\bREVERSED\b/g, "Went the other way").replace(/\bUNCLEAR\b/g, "Can't tell").replace(/\bOPEN\b/g, "Still early");

// ---------- state ----------
const S = {
  data: [], byId: new Map(), meta: null, proof: null,
  rt: { ok: false, set: new Set(), mock: false },
  market: null, quotes: {},
  f: { win: "recent", verdict: "", rtoken: false },
  idFilter: null, sel: null, opener: null,
  pxCache: new Map(),
  qTried: new Set(), // tickers whose rToken quote was already requested for the open panel (stops re-fetch loops when the feed is down)
  tk: { budget: 100, slip: 15, side: null },
};

// ---------- boot ----------
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

async function boot() {
  wireStatic();
  try {
    const [data, meta] = await Promise.all([getJSON("/data/disclosures.json"), getJSON("/data/meta.json")]);
    S.data = data; S.meta = meta; S.byId = new Map(data.map((d) => [d.id, d]));
  } catch {
    $("#feed").innerHTML = `<li class="empty">Could not load the data. Reload the page.</li>`;
    return;
  }
  renderExamples();
  renderFeed();
  await refreshMarket();
  renderFeed(true); // the first paint ran before the rToken list arrived; redraw so "Bitget 24/7" tags and the filter work even if live quotes fail
  await refreshGapWatch();
  setInterval(() => { if (!document.hidden) tick(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

async function tick() {
  await refreshMarket();
  await refreshGapWatch();
  if (S.sel) { const d = S.byId.get(S.sel); if (d) { await ensureQuote(d.ticker, true); renderDetail(d, true); } }
}

// ---------- market / rTokens / quotes ----------
async function refreshMarket() {
  try {
    const [m, rt] = await Promise.all([getJSON("/api/market"), getJSON("/api/rtokens")]);
    S.market = m;
    S.rt = { ok: rt.ok, set: new Set(rt.tickers || []), mock: !!rt.mock };
  } catch { /* keep last known state */ }
  const c = $("#mkt-chip"), m = S.market;
  if (!m) { c.textContent = "Market status unavailable"; return; }
  const left = m.open ? "" : ` · reopens in ${inDur(new Date(m.nextOpen) - Date.now())}`;
  c.dataset.state = m.state;
  c.innerHTML = `<span class="dot" aria-hidden="true"></span>${m.open ? "US market open" : m.state === "pre" ? "Pre-market" : m.state === "post" ? "After hours" : "US market closed"}${esc(left)}`;
}

async function fetchQuotes(tickers) {
  const t = [...new Set(tickers)].slice(0, 24);
  if (!t.length) return;
  try {
    const r = await getJSON(`/api/quotes?t=${t.join(",")}`);
    Object.assign(S.quotes, r.quotes);
    if (r.market) S.market = { ...S.market, ...r.market };
    if (r.mock) S.rt.mock = true;
  } catch { /* leave quotes as they were */ }
}
async function ensureQuote(t, force = false) { if (force || !S.quotes[t]) await fetchQuotes([t]); }

function gapCandidates() {
  const seen = new Set(), out = [];
  for (const d of S.data) {
    if (d.stale || seen.has(d.ticker) || !S.rt.set.has(d.ticker)) continue;
    seen.add(d.ticker); out.push(d.ticker);
    if (out.length >= 24) break;
  }
  return out;
}

const mid = (rt) => (rt ? rt.mid ?? rt.last : null); // bid/ask midpoint: `last` can lag the live book on a thin token
const fresh = (q) => !!(q && q.rtoken && q.rtoken.mid != null); // a two-sided book is what "trading right now" means here

/** The overnight movers strip only exists while Bitget prices are live; with the feed down the section stays hidden rather than apologising. */
async function refreshGapWatch() {
  const box = $("#gapwatch");
  if (!S.rt.ok) { box.hidden = true; return; }
  const cand = gapCandidates();
  if (!cand.length) { box.hidden = true; return; }
  await fetchQuotes(cand);
  const items = cand.map((t) => S.quotes[t]).filter((q) => q && q.gap != null && fresh(q)).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 6);
  if (!items.length) { box.hidden = true; return; }
  const closed = S.market && !S.market.open;
  $("#gw-sub").textContent = closed
    ? "A Bitget rToken is a tokenized US stock that trades around the clock. These recently reported stocks have moved most since the US market closed."
    : "A Bitget rToken is a tokenized US stock that trades around the clock. These recently reported stocks are furthest from their live stock price.";
  $("#gw-list").innerHTML = items.map((q) => `
    <li><button class="gw-btn" type="button" data-tk="${esc(q.ticker)}" aria-label="${esc(q.ticker)}: token ${pct(q.gap, 2)} versus the last stock price. Open details.">
      <span class="t">r${esc(q.ticker)}</span><span class="g ${cls(q.gap)}">${q.gap >= 0 ? "▲" : "▼"} ${pct(q.gap, 2)}</span>
    </button></li>`).join("");
  box.hidden = false;
}

// ---------- feed ----------
function visible() {
  const f = S.f;
  if (S.idFilter) return S.idFilter.ids.map((i) => S.byId.get(i)).filter(Boolean);
  return S.data.filter((d) => {
    if (f.win === "recent" && d.stale) return false;
    if (f.verdict && d.a.verdict !== f.verdict) return false;
    if (f.rtoken && !S.rt.set.has(d.ticker)) return false;
    return true;
  });
}

function rowHTML(d) {
  const a = d.a, hasRt = S.rt.set.has(d.ticker);
  const scored = a.rTotal != null && (a.verdict === "OPEN" || a.verdict === "PRICED_IN" || a.verdict === "REVERSED");
  const note = scored ? `Stock ${moveText(a)}` : a.verdict === "UNCLEAR" ? "option: call or put not stated" : a.verdict === "INVALID" ? "trade dated after the filing" : "";
  return `<li><button class="row" type="button" data-id="${esc(d.id)}" aria-selected="${S.sel === d.id}">
    <span class="r-text">
      <span class="r-title"><b>${esc(d.member)}</b> ${d.side === "buy" ? "bought" : "sold"} <b class="tk">${esc(d.ticker)}</b><span class="co">${esc(d.company)}</span></span>
      <span class="r-sub">Traded ${dShort(d.tradeDate)} · made public ${dShort(d.filedDate)}${hasRt ? ` · <span class="rt" title="Bitget lists r${esc(d.ticker)}, a token that trades 24/7">Bitget 24/7</span>` : ""}</span>
    </span>
    <span class="r-verdict"><span class="v v-${a.verdict}" title="${esc(a.why || "What the stock has done since the trade, compared with the overall market, in the member's direction")}"><i aria-hidden="true"></i>${VERDICT[a.verdict] || a.verdict}</span>${note ? `<span class="v-num" title="Compared with the overall market (SPY)">${note}</span>` : ""}</span>
  </button></li>`;
}

function renderFeed(keepScroll) {
  const rows = visible(), feed = $("#feed"), c = $("#count");
  const stale = S.data.filter((d) => d.stale).length;
  $("#vhelp").textContent = VERDICT_HELP[S.f.verdict] ?? "";
  if (S.idFilter) c.innerHTML = `${rows.length} result${rows.length === 1 ? "" : "s"} for “${esc(S.idFilter.label)}”. <button type="button" id="clear-ids">Show all trades</button>`;
  else if (S.f.win === "recent") c.innerHTML = `${rows.length.toLocaleString()} trade${rows.length === 1 ? "" : "s"} from the last 60 days.${stale ? ` <button type="button" data-win="all">Include ${stale.toLocaleString()} older ones</button>` : ""}`;
  else c.innerHTML = `${rows.length.toLocaleString()} trades, including older ones. <button type="button" data-win="recent">Only the last 60 days</button>`;
  if (!rows.length) {
    feed.innerHTML = `<li class="empty"><p>No trades match this filter.</p><button class="btn" type="button" id="reset-f">Show everything</button></li>`;
    return;
  }
  const y = window.scrollY;
  feed.innerHTML = rows.slice(0, 200).map(rowHTML).join("") + (rows.length > 200 ? `<li class="empty">Showing the first 200 of ${rows.length.toLocaleString()}. Use the filters or ask a question.</li>` : "");
  if (keepScroll) window.scrollTo({ top: y });
}

// ---------- price chart ----------
async function series(t) {
  if (!S.pxCache.has(t)) S.pxCache.set(t, getJSON(`/data/px/${encodeURIComponent(t)}.json`).catch(() => null));
  return S.pxCache.get(t);
}

function chartSVG(s, d) {
  const W = 440, H = 150, P = { l: 6, r: 6, t: 10, b: 20 };
  const n = s.c.length, lo = Math.min(...s.c), hi = Math.max(...s.c), span = hi - lo || 1;
  const x = (i) => P.l + (i * (W - P.l - P.r)) / (n - 1);
  const y = (v) => P.t + (1 - (v - lo) / span) * (H - P.t - P.b);
  const at = (day) => s.d.findIndex((z) => z >= day);
  const path = s.c.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const it = at(d.a.entryDay || d.tradeDate), iff = at(d.a.filedDay || d.filedDate);
  const mk = [];
  if (it >= 0) mk.push(`<circle class="mk-t" cx="${x(it)}" cy="${y(s.c[it])}" r="5"><title>Member traded ${esc(d.tradeDate)} near ${px(s.c[it])}</title></circle>`);
  if (iff >= 0) mk.push(`<path class="mk-f" d="M${x(iff)},${y(s.c[iff]) - 7} l6,7 l-6,7 l-6,-7z"><title>Made public ${esc(d.filedDate)} near ${px(s.c[iff])}</title></path>`);
  mk.push(`<circle class="mk-n" cx="${x(n - 1)}" cy="${y(s.c[n - 1])}" r="3.5"><title>Last close ${px(s.c[n - 1])}</title></circle>`);
  const label = `Price of ${d.ticker} from ${s.d[0]} to ${s.d[n - 1]}. Member traded ${d.tradeDate}; made public ${d.filedDate}.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="ax" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/>
    <path class="ln" d="${path}"/>${mk.join("")}
    <text x="${P.l}" y="${H - 5}">${esc(dShort(s.d[0]))}</text><text x="${W - P.r}" y="${H - 5}" text-anchor="end">${esc(dShort(s.d[n - 1]))}</text>
    <text x="${P.l}" y="9">high ${px(hi)}</text><text x="${W - P.r}" y="${H - 5 - 12}" text-anchor="end">low ${px(lo)}</text></svg>
    <div class="legend"><span>○ the member's trade${it < 0 ? " (before this window)" : ""}</span><span>◆ made public</span><span>● latest close</span></div>`;
}

// ---------- detail drawer ----------
/** The full calculation, for the people who want it. */
function explain(d) {
  const a = d.a, act = d.side === "buy" ? "bought" : "sold";
  if (a.verdict === "UNCLEAR" || a.verdict === "INVALID") return esc(a.why || "No verdict.");
  return `${esc(d.member)} ${act} ${esc(d.ticker)} on ${esc(d.tradeDate)} at about $${px(a.entry)}. It was made public ${d.lagDays} day${d.lagDays === 1 ? "" : "s"} later (${esc(d.filedDate)}, about $${px(a.filedPx)}). Since the trade the stock has moved ${pct(a.rTotal)} versus SPY in the member's direction: ${pct(a.rBefore)} before anyone could see the filing and ${pct(a.rSince)} since. That is ${(a.z ?? 0).toFixed(1)}σ of the stock's own typical noise over ${a.h} trading day${a.h === 1 ? "" : "s"}. "Too late" means at least 1σ and at least 1% their way; "Went the other way" means the same against them; anything else is "Still early".`;
}

function verdictCard(d) {
  const a = d.a;
  const chip = `<div class="v v-${a.verdict}"><i aria-hidden="true"></i>${VERDICT[a.verdict] || a.verdict}</div>`;
  if (a.verdict === "UNCLEAR" || a.verdict === "INVALID") return `<div class="verdict-card">${chip}<p>${esc(a.why || "No verdict.")}</p></div>`;
  const mv = `Since the trade, the stock has ${moveText(a)} (compared with the overall market).`;
  const body = {
    OPEN: `${mv} That isn't enough to say the news is already priced in, so following now wouldn't clearly be late.`,
    PRICED_IN: `${mv} The move has already happened, so following now means paying for it.`,
    REVERSED: `${mv} Someone following today would get a better price than the member did, or the idea is failing.`,
  }[a.verdict];
  return `<div class="verdict-card">${chip}<p>${body}</p>
    <p class="fine">Before the filing was public: ${pct(a.rBefore)}. Since: ${pct(a.rSince)}. (Positive means their way.) This describes the past; it is not a forecast.</p></div>`;
}

/** Size a limit order the way Bitget will accept it: its own price/quantity precision and minimums. */
function planOrder(rt, t) {
  if (!rt) return null;
  const ref = t.side === "buy" ? rt.ask ?? rt.last : rt.bid ?? rt.last;
  const pp = rt.pricePrec ?? (ref >= 10 ? 2 : 4), qp = rt.qtyPrec ?? 4;
  const price = +(ref * (1 + (t.side === "buy" ? 1 : -1) * (t.slip / 1e4))).toFixed(pp);
  const qf = 10 ** qp, qty = Math.floor((t.budget / price) * qf) / qf;
  return { price, qty, pp, qp, notional: price * qty };
}

function gates(d, q, t) {
  const g = [], rt = q && q.rtoken, memberSide = d.side;
  const add = (lvl, txt) => g.push({ lvl, txt });
  if (!S.rt.set.has(d.ticker)) add("fail", `Bitget lists no r${d.ticker}USDT pair, so there is nothing to trade 24/7.`);
  else if (!rt) add("fail", "No live token quote yet (feed unreachable or still loading).");
  else {
    if (S.rt.mock) add("warn", "Quote is MOCK development data, not Bitget.");
    else if (rt.mid == null) add("warn", `r${d.ticker} has no two-sided book right now, so it is not really trading; the last print (${px(rt.last)}) may be stale.`);
    else add("pass", `Live token book: bid ${px(rt.bid)} / ask ${px(rt.ask)} USDT.`);
    const sp = q.spreadBps;
    if (sp == null) add("warn", "No bid/ask available to judge liquidity.");
    else if (sp > 100) add("fail", `Spread is ${Math.round(sp)} bps: too thin to trade sensibly.`);
    else if (sp > 40) add("warn", `Spread is ${Math.round(sp)} bps: wider than usual.`);
    else add("pass", `Spread ${Math.round(sp)} bps.`);
  }
  const minUsdt = rt?.minUsdt ?? 10, p = planOrder(rt, t);
  if (t.budget > 250) add("fail", "Order size is capped at 250 USDT on this desk.");
  else if (t.budget < minUsdt) add("fail", `Bitget's minimum order for this pair is ${minUsdt} USDT.`);
  else if (p && (p.qty < (rt.minQty ?? 0) || p.notional < minUsdt)) add("fail", `Rounds to ${p.qty} ${d.ticker}: below Bitget's minimum (${rt.minQty} ${d.ticker} / ${minUsdt} USDT). Raise the budget.`);
  else add("pass", `Order size ${t.budget} USDT is inside the 250 USDT cap and above Bitget's ${minUsdt} USDT minimum.`);
  if (t.slip > 50) add("fail", "Slippage allowance is capped at 50 bps.");
  if (d.stale) add("warn", `The member's trade is ${d.ageDays} days old.`);
  if (d.a.verdict === "PRICED_IN" && t.side === memberSide) add("warn", "Same side as the member, but their move has already happened.");
  if (t.side !== memberSide) add("info", "You chose the opposite side of the member's trade.");
  if (t.side === "sell") add("info", `A sell needs an existing r${d.ticker} balance in the demo account.`);
  add("info", "Paper trading only. This desk holds no keys and never sends an order.");
  return g;
}

function ticketHTML(d) {
  const q = S.quotes[d.ticker], rt = q && q.rtoken, t = S.tk;
  if (!t.side) t.side = d.side;
  const g = gates(d, q, t), blocked = g.some((x) => x.lvl === "fail");
  let cmd = "", body = "";
  const p = planOrder(rt, t);
  if (rt && p && !blocked) {
    const oid = "dd" + d.id.replace(/[^A-Za-z0-9]/g, "").slice(-14);
    const o = { category: "SPOT", symbol: rt.symbol, side: t.side, orderType: "limit", price: p.price.toFixed(p.pp), qty: p.qty.toFixed(p.qp), timeInForce: "gtc", clientOid: oid };
    cmd = `bgc --paper-trading order --action place --category SPOT --symbol ${o.symbol} --side ${o.side} --orderType limit --price ${o.price} --qty ${o.qty} --timeInForce gtc --clientOid ${oid} --dry-run`;
    body = JSON.stringify(o, null, 2);
  }
  return `<div class="tk-form">
      <label>Budget (USDT)<input id="tk-budget" type="number" inputmode="decimal" min="${rt?.minUsdt ?? 10}" max="250" step="5" value="${t.budget}"></label>
      <label>Side<select id="tk-side"><option value="buy"${t.side === "buy" ? " selected" : ""}>Buy</option><option value="sell"${t.side === "sell" ? " selected" : ""}>Sell</option></select></label>
      <label>Slippage (bps)<input id="tk-slip" type="number" inputmode="decimal" min="1" max="50" step="1" value="${t.slip}"></label>
    </div>
    <ul class="gates">${g.map((x) => `<li><span class="gt gt-${x.lvl}">${x.lvl.toUpperCase()}</span><span>${esc(x.txt)}</span></li>`).join("")}</ul>
    ${blocked ? `<p class="blocked">Practice order blocked by the checks above. Nothing to copy.</p>` : cmd ? `<pre class="cmd" id="cmd">${esc(cmd)}</pre>
      <div class="copy-row"><button class="btn" type="button" id="copy-cmd">Copy command</button><span id="copied" class="copied" role="status"></span></div>
      <p class="fine" style="margin-top:10px">Runs against Bitget's demo environment with the official <code>bgc</code> tool; <code>--dry-run</code> previews the request without sending it. Sizes follow this pair's own price and quantity rules.</p>
      <details><summary class="fine">Order payload</summary><pre class="cmd">${esc(body)}</pre></details>` : ""}`;
}

function bitgetBlock(d, q, rt) {
  if (!S.rt.set.has(d.ticker)) return "";
  const closed = S.market && !S.market.open;
  const body = !rt
    ? (S.qTried.has(d.ticker)
      ? `<p class="muted">Bitget's price feed isn't responding right now, so there is no live price to show. We never show stale prices. Try again in a few minutes.</p>`
      : `<p class="muted"><span class="spin" aria-hidden="true"></span>Loading the live price…</p>`)
    : `<dl class="kv"><dt>r${esc(d.ticker)} price now</dt><dd>${px(mid(rt))} USDT</dd>
        <dt>Last US stock price</dt><dd>${q.equity ? px(q.equity.last) : "n/a"}</dd>
        <dt>Difference</dt><dd class="${cls(q.gap)}">${pct(q.gap, 2)}</dd>
        <dt>Gap between buy and sell price</dt><dd>${q.spreadBps == null ? "n/a" : Math.round(q.spreadBps) + " bps"}</dd></dl>
      <p class="fine" style="margin-top:8px">${closed ? "US stocks are closed, so this difference is where the market is already pricing the stock ahead of the next open." : "US stocks are open, so the difference is a small premium or discount."} 100 bps = 1%.${S.rt.mock ? " <b>MOCK data.</b>" : ""}</p>`;
  return `<section class="sec"><h3>Also trades around the clock on Bitget</h3>
    <p class="muted">Bitget lists this stock as a token, r${esc(d.ticker)}, that trades even when Wall Street is closed.</p>${body}
    <details class="more"><summary>Make a practice order (paper trading, nothing is sent)</summary><div id="ticket">${ticketHTML(d)}</div></details></section>`;
}

async function renderDetail(d, soft) {
  const el = $("#detail");
  S.sel = d.id;
  const q = S.quotes[d.ticker], rt = q && q.rtoken;
  const s = await series(d.ticker);
  const keep = soft ? { top: el.scrollTop, open: $$("details", el).map((x) => x.open) } : null;
  const facts = [];
  facts.push(`${esc(d.member)}${d.party ? ` (${esc(d.party)}-${esc(d.state)})` : ""}, ${d.chamber === "house" ? "House" : "Senate"}. Reported amount: ${amount(d)}. Sector: ${esc(d.sector || "n/a")}${d.industry ? ` (${esc(d.industry)})` : ""}.`);
  if (d.flags.cluster) facts.push(`${d.flags.cluster + 1} members traded ${esc(d.ticker)} the same way within 30 days.`);
  if (d.flags.overlap.length) facts.push(`${esc(d.member)} sits on ${esc(d.flags.overlap.join("; "))}, which oversees ${esc(d.sector)}. A rough match, not an accusation.`);
  if (d.flags.late) facts.push(`Reported ${d.lagDays} days after the trade; the legal limit is 45.`);
  if (d.owner && d.owner !== "self") facts.push(d.owner === "joint" ? "Held jointly with a spouse." : d.owner === "child" ? "Held by a dependent child." : "Held by the member's spouse.");
  if (d.instrument === "option") facts.push("This was an option trade.");
  if (!d.matched) facts.push("The filer isn't matched to a sitting member, so committee data is unavailable.");
  el.hidden = false; $("#scrim").hidden = false;
  el.innerHTML = `<div class="d-head"><div><h2 id="d-title" tabindex="-1">${esc(d.member)} ${d.side === "buy" ? "bought" : "sold"} <span class="mono">${esc(d.ticker)}</span></h2>
      <p class="d-sub">${esc(d.company)} · traded ${dShort(d.tradeDate)} · made public ${dShort(d.filedDate)} (${d.lagDays} day${d.lagDays === 1 ? "" : "s"} later)</p>
      <p class="d-sub"><a href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">Read the original filing ↗</a></p></div>
      <button class="icon-btn close" type="button" id="d-close" aria-label="Close details"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
    ${verdictCard(d)}
    <section class="sec"><h3>What the stock did</h3>${s ? chartSVG(s, d) : `<p class="muted">Price history unavailable.</p>`}</section>
    ${bitgetBlock(d, q, rt)}
    <details class="more"><summary>More details and how this was calculated</summary>
      <ul>${facts.map((f) => `<li>${f}</li>`).join("")}</ul>
      <p class="why">${explain(d)}</p></details>`;
  if (keep) { keep.open.forEach((o, i) => { const x = $$("details", el)[i]; if (x) x.open = o; }); el.scrollTop = keep.top; }
  else { document.body.style.overflow = "hidden"; $("#d-title").focus({ preventScroll: true }); }
  $$(".row").forEach((r) => r.setAttribute("aria-selected", String(r.dataset.id === d.id)));
  if (S.rt.set.has(d.ticker) && !rt && !S.qTried.has(d.ticker)) {
    S.qTried.add(d.ticker); // one attempt per panel; the 30s tick retries and a recovered feed clears this
    await fetchQuotes([d.ticker]);
    if (S.sel === d.id) renderDetail(d, true);
  }
}

function closeDetail() {
  $("#detail").hidden = true; $("#scrim").hidden = true; S.sel = null; document.body.style.overflow = "";
  $$(".row").forEach((r) => r.setAttribute("aria-selected", "false"));
  if (S.opener && document.contains(S.opener)) S.opener.focus();
}

function openById(id, opener) {
  const d = S.byId.get(id);
  if (!d) return;
  S.opener = opener || null; S.tk.side = null; S.qTried.delete(d.ticker);
  renderDetail(d);
}

// ---------- ask ----------
const EXAMPLES = ["What did senators buy this week that's still open?", "Which recent trades are already too late to follow?", "Any tech trades by members on the committee that oversees tech?"];
function renderExamples() { $("#ask-ex").innerHTML = `<span class="muted">Try:</span> ${EXAMPLES.map((e) => `<button type="button">${esc(e)}</button>`).join("")}`; }

async function ask(q) {
  const go = $("#ask-go"), out = $("#answer");
  go.disabled = true; out.hidden = false;
  out.innerHTML = `<span class="spin" aria-hidden="true"></span>Reading the filings…`;
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 40000);
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }), signal: ac.signal });
    const j = await res.json();
    if (!res.ok) { out.innerHTML = `<p>${esc(j.error || "Something went wrong.")}</p>`; return; }
    const body = plainVerdicts(esc(j.answer)).replace(/\[([HS]-[A-Za-z0-9-]+)\]/g, (_, id) => `<button class="cite" type="button" data-cite="${id}" aria-label="Open trade ${id}">${esc((S.byId.get(id) || {}).ticker || id)}</button>`);
    const label = q.length > 48 ? q.slice(0, 47) + "…" : q;
    out.innerHTML = `<div class="txt">${body}</div><div class="meta">
      ${j.ids.length ? `<button class="btn" type="button" id="show-ids">Show these ${j.ids.length} in the list</button>` : "<span>No match</span>"}
      <span>${j.mode === "llm" ? `Summary written by an AI model (${esc((j.model || "").split("/").pop())}) from the matching filings. The list's numbers are computed, not generated.` : "No AI summary this time; these are the computed numbers."}</span></div>`;
    out.dataset.ids = JSON.stringify(j.ids); out.dataset.label = label;
    if (j.mock) S.rt.mock = true;
  } catch (e) {
    out.innerHTML = `<p>${e.name === "AbortError" ? "That took too long. Try a narrower question." : "Could not reach the desk. Check your connection and retry."}</p>`;
  } finally { clearTimeout(to); go.disabled = false; }
}

// ---------- proof ----------
const pp = (v, d = 2) => (v == null ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
async function renderProof() {
  const el = $("#view-proof");
  if (el.dataset.ready) return;
  try { S.proof = await getJSON("/data/proof.json"); } catch { el.innerHTML = `<div class="doc"><p class="muted">Proof data not built yet. Run <code>npm run proof</code>.</p></div>`; return; }
  const P = S.proof, M = S.meta || {}, cov = (M.coverage || {}), h = cov.house || {}, sn = cov.senate || {};
  const nf5 = P.naiveFollow["5d"], nf20 = P.naiveFollow["20d"], d5 = P.openMinusPricedIn["5d"], d20 = P.openMinusPricedIn["20d"];
  const vrow = (name, k) => `<tr><td>${name}</td>${["5d", "20d"].map((H) => { const s = P.byVerdict[H][k]; return s ? `<td>${pp(s.meanPct)}</td><td>${s.n.toLocaleString()}</td><td>${s.tClustered ?? "n/a"}</td>` : `<td colspan="3">n/a</td>`; }).join("")}</tr>`;
  const stale = S.data.filter((d) => d.stale).length;
  el.innerHTML = `<article class="doc">
    <h1>Proof: what the data say, including the parts that don't flatter us</h1>
    <p class="lede">Every number here is computed by <code>pipeline/analysis.py</code> from the same filings the desk shows. Each trade is judged from the first close <em>after</em> it became public, so nothing looks into the future.</p>
    <div class="findings">
      <div class="finding"><span class="k">Does copying Congress work?</span><span class="big">No reliable edge</span><p>${pp(nf5.meanPct)} average gain over the market after 5 trading days. It looks significant per trade (t = ${nf5.tNaive}) but isn't once trades from the same filing are grouped (t = ${nf5.tClustered}; ${nf5.n.toLocaleString()} trades, ${nf5.clusters} filings).</p></div>
      <div class="finding"><span class="k">Do our labels predict anything?</span><span class="big">No, and we say so</span><p>"Still early" minus "Too late" is ${d5 ? pp(d5.diffPct) : "n/a"} at 5 days (t = ${d5?.tWelch ?? "n/a"}) and ${d20 ? pp(d20.diffPct) : "n/a"} at 20 days (t = ${d20?.tWelch ?? "n/a"}). They describe the past; they don't forecast.</p></div>
      <div class="finding"><span class="k">How much do we read?</span><span class="big">${h.markers ? (100 * h.parsed / h.markers).toFixed(1) : "?"}% of House rows</span><p>${h.parsed?.toLocaleString() ?? "?"} of ${h.markers?.toLocaleString() ?? "?"} transaction rows parsed. Scanned filings aren't read yet (${h.scanned ?? "?"} House, ${sn.paperReports ?? "?"} Senate).</p></div>
      <div class="finding" id="f-247"><span class="k">Does 24/7 trading help?</span><span class="big">…</span><p>Loading the live token study.</p></div>
    </div>
    <h2>1. Does naively following a disclosure make money?</h2>
    <div class="table-wrap"><table class="t"><thead><tr><th></th><th>Mean excess</th><th>Median</th><th>Hit rate</th><th>Trades</th><th>Filings</th><th>t (naive)</th><th>t (grouped)</th></tr></thead><tbody>
      ${[["5 trading days", nf5], ["20 trading days", nf20]].map(([n, s]) => `<tr><td>${n}</td><td>${pp(s.meanPct)}</td><td>${pp(s.medianPct)}</td><td>${s.hitRatePct}%</td><td>${s.n.toLocaleString()}</td><td>${s.clusters}</td><td>${s.tNaive}</td><td>${s.tClustered}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted">Gain over SPY in the member's direction (positive = the member was right). A t value below about 2 is indistinguishable from zero. Trades inside one filing move together, so the per-trade t overstates significance; the grouped one is the honest one.</p>
    <h2>2. Do the desk's labels separate outcomes?</h2>
    <div class="table-wrap"><table class="t"><thead><tr><th rowspan="2">Label at filing</th><th colspan="3">Next 5 days</th><th colspan="3">Next 20 days</th></tr><tr><th>Mean</th><th>n</th><th>t</th><th>Mean</th><th>n</th><th>t</th></tr></thead><tbody>
      ${vrow("Still early", "OPEN")}${vrow("Too late", "PRICED_IN")}${vrow("Went the other way", "REVERSED")}</tbody></table></div>
    <div class="callout">"Still early" minus "Too late": <strong>${d5 ? pp(d5.diffPct) : "n/a"}</strong> at 5 days (Welch t = ${d5?.tWelch ?? "n/a"}) and <strong>${d20 ? pp(d20.diffPct) : "n/a"}</strong> at 20 days (t = ${d20?.tWelch ?? "n/a"}). Neither is significant and the sign flips. <strong>The labels are an accounting of what a follower has already missed, not a prediction.</strong></div>
    <h2>3. Data coverage and quality</h2>
    <div class="stats">
      <div class="stat"><div class="n">${h.markers ? (100 * h.parsed / h.markers).toFixed(1) : "?"}%</div><div class="l">of ${h.markers?.toLocaleString() ?? "?"} House transaction rows parsed from PDFs</div></div>
      <div class="stat"><div class="n">${h.scanned ?? "?"} / ${h.filings ?? "?"}</div><div class="l">House filings are scanned images (not readable yet)</div></div>
      <div class="stat"><div class="n">${sn.paperReports ?? "?"} / ${sn.reports ?? "?"}</div><div class="l">Senate reports are paper scans (not readable yet)</div></div>
      <div class="stat"><div class="n">${stale.toLocaleString()}</div><div class="l">trades are over 60 days old and hidden by default</div></div>
    </div>
    <p class="muted">Errors we catch instead of passing on: trade dates after the filing date (a typo in the original), option trades whose call or put isn't stated (labelled "Can't tell" rather than guessed), and filers who don't match a sitting member (no committee claim is made for them).</p>
    <h2>4. The 24/7 layer, observed live</h2>
    <div id="gap-study"><p class="muted"><span class="spin" aria-hidden="true"></span>Loading…</p></div>
    <h2>5. Limitations</h2>
    <ul>${P.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    <p class="muted">Generated ${esc(P.asOf)}.</p></article>`;
  el.dataset.ready = "1";
  renderGapStudy();
}

const fdate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
async function renderGapStudy() {
  const el = $("#gap-study");
  if (!el) return;
  let g;
  try { g = await getJSON("/api/gapstudy"); } catch { el.innerHTML = `<p class="muted">Live study unavailable right now.</p>`; return; }
  const bps = (v) => (v == null ? "n/a" : `${v.toFixed(1)} bps`);
  const b = g.baseline;
  const card = $("#f-247");
  if (card) card.innerHTML = g.snapshots
    ? `<span class="k">Does 24/7 trading help?</span><span class="big">${bps(b.closed.medianAbsGapBps)}</span><p>Typical gap between a token and its stock while US stocks are closed, against ${bps(b.open.medianAbsGapBps)} while both trade. Observed over ${g.snapshots.toLocaleString()} snapshots. Overnight the buy-sell spread is also wider (${bps(b.closed.medianSpreadBps)} vs ${bps(b.open.medianSpreadBps)}).</p>`
    : `<span class="k">Does 24/7 trading help?</span><span class="big">Collecting</span><p>The desk records token and stock prices every 15 minutes. Results appear here as they accumulate.</p>`;
  const intro = `<p>Every 15 minutes the desk records the token price and the US stock price for recently reported names. That lets us test the idea on real data instead of asserting it: <em>when the stock market is closed, does the token already price in where the stock will open?</em></p>`;
  const md = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const stalled = !!g.last && Date.now() - g.last > 3 * 3600e3;
  const lastTxt = g.last ? `${md(g.last)}, ${new Date(g.last).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC` : "";
  const base = g.snapshots ? `<div class="stats">
      <div class="stat"><div class="n">${g.snapshots.toLocaleString()}</div><div class="l">snapshots recorded${g.first ? (stalled ? `, ${md(g.first)} to ${md(g.last)}` : ` since ${md(g.first)}`) : ""}</div></div>
      <div class="stat"><div class="n">${bps(b.open.medianAbsGapBps)}</div><div class="l">typical token-vs-stock gap while both trade (${b.open.samples.toLocaleString()} samples; spread ${bps(b.open.medianSpreadBps)})</div></div>
      <div class="stat"><div class="n">${bps(b.closed.medianAbsGapBps)}</div><div class="l">typical gap while US stocks are closed (${b.closed.samples.toLocaleString()} samples; spread ${bps(b.closed.medianSpreadBps)})</div></div></div>` : "";
  if (!g.weekends.length) {
    el.innerHTML = intro + base + `<div class="callout"><strong>No complete weekend captured.</strong> ${stalled
      ? `The recorder has stored nothing since ${esc(lastTxt)}: Bitget's price feed stopped answering (it returns "service unavailable"), so the Friday-close to Monday-open test could not be completed. The open-versus-closed numbers above are real and come from the period the feed was up. No claim is made about whether weekend token gaps predict the open.`
      : `The next full weekend (Friday close to Monday open) will be analysed here once Monday's open has happened. Until then, no claim is made about whether weekend token gaps predict the open.`}</div>`;
    return;
  }
  const w = g.weekends.map((k) => `<h3 style="margin-top:16px">${fdate(k.friday)} close → ${fdate(k.monday)} open · ${k.n} names</h3>
    <div class="stats">
      <div class="stat"><div class="n">${k.correlation == null ? "n/a" : k.correlation.toFixed(2)}</div><div class="l">correlation, weekend token gap vs Monday move</div></div>
      <div class="stat"><div class="n">${k.signAgreementPct == null ? "n/a" : Math.round(k.signAgreementPct) + "%"}</div><div class="l">same direction (of ${k.signAgreementN} names with a gap of 0.2% or more)</div></div>
      <div class="stat"><div class="n">${k.meanAbsWeekendGapPct.toFixed(2)}% / ${k.meanAbsMondayMovePct.toFixed(2)}%</div><div class="l">average weekend gap / average Monday move</div></div></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Token weekend gap</th><th>Monday move</th></tr></thead><tbody>${k.pairs.slice(0, 8).map((p) => `<tr><td>${esc(p.t)}</td><td class="${cls(p.weekendGap)}">${pct(p.weekendGap, 2)}</td><td class="${cls(p.mondayMove)}">${pct(p.mondayMove, 2)}</td></tr>`).join("")}</tbody></table></div>`).join("");
  el.innerHTML = intro + base + w + `<p class="muted">${esc(g.note)}${g.mock ? " <b>Includes MOCK development data.</b>" : ""}</p>`;
}

// ---------- how it works ----------
function renderMethod() {
  const el = $("#view-method");
  if (el.dataset.ready) return;
  el.innerHTML = `<article class="doc">
    <h1>How it works</h1>
    <p class="lede">US lawmakers have to publish their stock trades, but only after the fact, often weeks later. By the time you read a report, the stock may have already moved. Disclosure Desk checks that for you.</p>
    <div class="points">
      <div class="point"><span class="n" aria-hidden="true">1</span><div><b>We read the official reports</b><span>Every House and Senate stock disclosure, straight from the filings, each one linked back to its source.</span></div></div>
      <div class="point"><span class="n" aria-hidden="true">2</span><div><b>We check what the stock did since</b><span>Compared with the overall market, from the day of the trade. Each trade gets one label: <b style="display:inline">Still early</b>, <b style="display:inline">Too late</b> or <b style="display:inline">Went the other way</b>.</span></div></div>
      <div class="point"><span class="n" aria-hidden="true">3</span><div><b>We add the 24/7 view</b><span>Bitget lists many US stocks as tokens (rTokens) that trade around the clock. When Wall Street is closed, you can see where these tokens already trade, and try a practice order. The desk never holds keys or sends a real order.</span></div></div>
    </div>
    <div class="callout">We tested the popular idea of copying Congress's trades on the real filings, and it doesn't reliably work (see the Proof tab). So the desk doesn't sell signals. It tells you what has already happened and leaves the decision to you.</div>

    <h2>The labels, precisely</h2>
    <p>For a trade in direction <em>d</em> (+1 buy, −1 sell) made on <em>t₀</em> and made public on <em>t₁</em>, with <code>excess</code> = the stock's return minus SPY's over the same window:</p>
    <ul>
      <li><b>Before it was public</b> = d × excess(t₀→t₁): what happened before anyone could see the trade.</li>
      <li><b>Since it was public</b> = d × excess(t₁→now).</li>
      <li><b>Missed by a follower today</b> = d × excess(t₀→now), measured in σ units: <code>z = missed / (σ·√h)</code>, where σ is the stock's own daily noise over the 60 days before the trade and h the trading days elapsed.</li>
      <li><b>Too late</b> (internally "priced in") if z ≥ 1 and missed ≥ 1%. <b>Went the other way</b> ("reversed") if z ≤ −1 and missed ≤ −1%. Otherwise <b>Still early</b> ("open"). Option trades are <b>Can't tell</b>, because the filing doesn't say call or put. Trades dated after their own filing are flagged as typos.</li>
    </ul>
    <h2>The 24/7 layer</h2>
    <p>Congress files at any hour; US stocks only reprice at the open. Bitget's rTokens (<code>r&lt;TICKER&gt;USDT</code>) trade continuously, so when stocks are closed the desk ranks recently reported names by the gap between their token and the last stock close, and builds a <b>practice order</b> for the official <code>bgc</code> tool (<code>--paper-trading --dry-run</code>). Each ticket first passes fixed checks: the token must exist, spread ≤ 40 bps (hard stop at 100), order 10–250 USDT, slippage ≤ 50 bps, quote fresh. If Bitget's price feed is unavailable, the desk says so and shows no price rather than a stale one.</p>
    <h2>The AI's job</h2>
    <ol><li><b>Understand the question</b>: turns "which senators bought tech this month?" into a filter. If the model is unavailable, a keyword reader does it.</li>
    <li><b>Write two sentences</b> about the trades that matched. Code then <b>rejects the text</b> if it contains any number that isn't in the data, any count or number word, or any forecast or advice, and gives the model one corrected retry. The list underneath is rendered by code with exact figures, so nothing in it is generated.</li></ol>
    <p>Model: Qwen (<code>qwen3-30b-a3b-fp8</code>) on Cloudflare Workers AI.</p>
    <h2>Sources</h2>
    <ul><li>US House Clerk periodic transaction reports (official PDFs).</li>
    <li>US Senate eFD reports, read through a public GitHub mirror because efdsearch.senate.gov blocks datacenter traffic; each row links back to the eFD filing.</li>
    <li>Prices: Yahoo Finance. Sectors: Yahoo search. Members and committees: <a href="https://github.com/unitedstates/congress-legislators" rel="noopener noreferrer">unitedstates/congress-legislators</a>. Tokens: Bitget's official agent MCP (token list and trading rules, live bid and ask). Token prices use the midpoint of bid and ask, because the last trade can lag the live book.</li></ul>
    <h2>Use of the data</h2>
    <p>Disclosure reports may not be used for commercial purposes (5 U.S.C. §13107(c)). This is a non-commercial research demo and not investment advice.</p></article>`;
  el.dataset.ready = "1";
}

// ---------- events ----------
function setView(v) {
  for (const n of ["desk", "proof", "method"]) $(`#view-${n}`).hidden = n !== v;
  $$(".tab").forEach((t) => (t.getAttribute("data-view") === v ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current")));
  if (v === "proof") { renderProof(); renderGapStudy(); } if (v === "method") renderMethod();
  if (v !== "desk") closeDetail();
  history.replaceState(null, "", v === "desk" ? location.pathname : `#${v}`);
  window.scrollTo({ top: 0 });
}

function wireStatic() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  const hv = location.hash.slice(1); if (["proof", "method"].includes(hv)) setView(hv);
  // back/forward and pasted links keep working
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); setView(["proof", "method"].includes(v) ? v : "desk"); });

  $("#theme").addEventListener("click", () => {
    const root = document.documentElement, next = root.dataset.theme === "dark" ? "light" : "dark";
    root.classList.add("no-transitions"); root.dataset.theme = next; store.set("dd.theme", next);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-transitions")));
  });

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t.id === "scrim") return closeDetail();
    const row = t.closest(".row"); if (row) return openById(row.dataset.id, row);
    const gw = t.closest(".gw-btn");
    if (gw) { const d = S.data.find((x) => x.ticker === gw.dataset.tk && !x.stale) || S.data.find((x) => x.ticker === gw.dataset.tk); if (d) { S.idFilter = null; openById(d.id, gw); } return; }
    const cite = t.closest(".cite"); if (cite) { const d = S.byId.get(cite.dataset.cite); if (d) openById(d.id, cite); return; }
    if (t.closest("#d-close")) return closeDetail();
    if (t.closest("#reset-f")) return resetFilters();
    if (t.closest("#clear-ids")) { S.idFilter = null; renderFeed(); return; }
    const wn = t.closest("[data-win]"); if (wn) { S.f.win = wn.dataset.win; S.idFilter = null; return renderFeed(); }
    const sh = t.closest("#show-ids"); if (sh) { const o = $("#answer"); S.idFilter = { ids: JSON.parse(o.dataset.ids), label: o.dataset.label }; renderFeed(); $("#feed-title").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const ex = t.closest("#ask-ex button"); if (ex) { $("#ask-q").value = ex.textContent; return ask(ex.textContent); }
    if (t.closest("#copy-cmd")) return copyCmd();
    const pl = t.closest(".pill");
    if (pl) {
      if (pl.dataset.f) { S.f[pl.dataset.f] = pl.dataset.v; $$(`.pill[data-f="${pl.dataset.f}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === pl))); }
      else if (pl.dataset.t) { S.f[pl.dataset.t] = !S.f[pl.dataset.t]; pl.setAttribute("aria-pressed", String(S.f[pl.dataset.t])); }
      S.idFilter = null; return renderFeed();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.sel) return closeDetail();
    const row = e.target.closest && e.target.closest(".row");
    if (row && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const rows = $$(".row"), i = rows.indexOf(row), n = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) { e.preventDefault(); n.focus(); }
    }
  });

  $("#ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#ask-q").value.trim(); if (q.length >= 3) ask(q); });
  $("#detail").addEventListener("input", (e) => {
    const id = e.target.id; if (!["tk-budget", "tk-slip"].includes(id)) return;
    const d = S.byId.get(S.sel); if (!d) return;
    S.tk.budget = Number($("#tk-budget").value) || 0; S.tk.slip = Number($("#tk-slip").value) || 0;
    $("#ticket").innerHTML = ticketHTML(d);
    const inp = $(`#${id}`); if (inp) { inp.focus(); inp.setSelectionRange?.(inp.value.length, inp.value.length); }
  });
  $("#detail").addEventListener("change", (e) => {
    if (e.target.id !== "tk-side") return;
    const d = S.byId.get(S.sel); if (!d) return; S.tk.side = e.target.value; $("#ticket").innerHTML = ticketHTML(d); $("#tk-side").focus();
  });
}

function resetFilters() {
  S.f = { win: "recent", verdict: "", rtoken: false };
  S.idFilter = null;
  $$(".pill").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f ? S.f[b.dataset.f] === b.dataset.v : false)));
  renderFeed();
}

async function copyCmd() {
  const txt = $("#cmd")?.textContent || "", note = $("#copied");
  try { await navigator.clipboard.writeText(txt); note.textContent = "Copied ✓"; } catch { note.textContent = "Select the command and copy it manually."; }
  setTimeout(() => { if (note) note.textContent = ""; }, 2500);
}

boot();
