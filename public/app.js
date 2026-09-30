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
const amount = (d) => (d.amountLo == null && d.amountHi == null ? "amount n/a" : `${usdK(d.amountLo)}–${usdK(d.amountHi)}`);
const dShort = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "?");
const px = (n) => (n == null ? "n/a" : n >= 10 ? n.toFixed(2) : n.toFixed(4));
const VERDICT = { OPEN: "Open", PRICED_IN: "Priced in", REVERSED: "Reversed", UNCLEAR: "Unclear", INVALID: "Bad date" };
const inDur = (ms) => {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
};

// ---------- state ----------
const S = {
  data: [], byId: new Map(), meta: null, proof: null,
  rt: { ok: false, set: new Set(), mock: false },
  market: null, quotes: {},
  f: { win: "recent", chamber: "", side: "", verdict: "", rtoken: false, cluster: false, overlap: false, mine: false, q: "" },
  idFilter: null, sel: null, opener: null,
  watch: store.get("dd.watch", []),
  pxCache: new Map(),
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
  renderWatchlist();
  try {
    const [data, meta] = await Promise.all([getJSON("/data/disclosures.json"), getJSON("/data/meta.json")]);
    S.data = data; S.meta = meta; S.byId = new Map(data.map((d) => [d.id, d]));
  } catch {
    $("#feed").innerHTML = `<li class="empty">Could not load the dataset. Reload, or check that <code>/data/disclosures.json</code> exists.</li>`;
    return;
  }
  renderExamples();
  renderFeed();
  await refreshMarket();
  renderBanner();
  await refreshGapWatch();
  setInterval(() => { if (!document.hidden) tick(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  setInterval(renderBanner, 60000);
}

async function tick() {
  await refreshMarket();
  renderBanner();
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
  const c = $("#mkt-chip");
  const m = S.market;
  if (!m) { c.textContent = "Market status unavailable"; return; }
  const left = m.open ? "" : ` · reopens in ${inDur(new Date(m.nextOpen) - Date.now())}`;
  c.dataset.state = m.state;
  c.innerHTML = `<span class="dot" aria-hidden="true"></span>${m.open ? "US market open" : m.state === "pre" ? "Pre-market" : m.state === "post" ? "After-hours" : "US market closed"}${esc(left)}`;
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

async function refreshGapWatch() {
  const list = $("#gw-list"), sub = $("#gw-sub");
  if (!S.rt.ok) {
    sub.textContent = "";
    list.innerHTML = `<li class="gw-empty">The Bitget rToken feed is unreachable right now, so live gaps can't be shown. Everything else on the desk still works.</li>`;
    return;
  }
  const cand = gapCandidates();
  if (!cand.length) { list.innerHTML = `<li class="gw-empty">No recent disclosures involve a listed rToken.</li>`; return; }
  await fetchQuotes(cand);
  const items = cand.map((t) => S.quotes[t]).filter((q) => q && q.gap != null && fresh(q)).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 12);
  const closed = S.market && !S.market.open;
  sub.textContent = closed ? "Recently disclosed names, ranked by how far their rToken is from the last equity close." : "Recently disclosed names, rToken premium/discount to the live equity price.";
  list.innerHTML = items.length ? items.map((q) => `
    <li class="gw-item"><button class="gw-btn" data-tk="${esc(q.ticker)}" aria-label="${esc(q.ticker)}: rToken ${pct(q.gap, 2)} versus the last equity price. Open details.">
      <span class="t">r${esc(q.ticker)}</span>
      <span class="g ${cls(q.gap)}">${q.gap >= 0 ? "▲" : "▼"} ${pct(q.gap, 2)}</span>
      <span class="s">${px(mid(q.rtoken))} · spread ${q.spreadBps == null ? "n/a" : Math.round(q.spreadBps) + " bps"}</span>
    </button></li>`).join("") : `<li class="gw-empty">Loading live quotes…</li>`;
  renderFeed(true);
}

// ---------- banner ----------
function renderBanner() {
  const m = S.market, b = $("#banner");
  const mock = S.rt.mock ? `<span class="mock" title="Development data only; production reads Bitget's agent MCP">MOCK rToken data</span>` : "";
  const n = S.rt.ok ? S.rt.set.size : null;
  if (!m) { b.innerHTML = `<span class="muted">Checking market status…</span>`; return; }
  if (m.open) {
    b.innerHTML = `<div class="big"><strong>US equities are open.</strong> rTokens track their stocks closely right now.${mock}</div>
      <div class="muted">Disclosures below show what the market has already done since each trade. When the bell rings the desk switches to rToken mode: the live prices come from tokens that trade around the clock${n ? ` (${n} US stocks are listed as rTokens on Bitget)` : ""}.</div>`;
    return;
  }
  const next = new Date(m.nextOpen);
  const when = next.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  b.innerHTML = `<div class="big"><strong>US equities are closed.</strong> They reopen ${esc(when)} ET (in ${inDur(next - Date.now())}).${mock}</div>
    <div class="muted">${n ? `<strong>${n} US stocks are listed as rTokens on Bitget.</strong> ` : ""}Congress files whenever it likes; the market only reprices at the open. The gap watch below shows where the recently disclosed names are already trading, and each detail panel builds a paper-trading ticket for them.</div>`;
}

// ---------- filters + feed ----------
function visible() {
  const f = S.f, q = f.q.trim().toLowerCase(), mine = new Set(S.watch);
  let rows = S.data;
  if (S.idFilter) { const ids = new Set(S.idFilter.ids); rows = rows.filter((d) => ids.has(d.id)); return S.idFilter.ids.map((i) => S.byId.get(i)).filter(Boolean); }
  return rows.filter((d) => {
    if (f.win === "recent" && d.stale) return false;
    if (f.chamber && d.chamber !== f.chamber) return false;
    if (f.side && d.side !== f.side) return false;
    if (f.verdict && d.a.verdict !== f.verdict) return false;
    if (f.rtoken && !S.rt.set.has(d.ticker)) return false;
    if (f.cluster && !d.flags.cluster) return false;
    if (f.overlap && !d.flags.overlap.length) return false;
    if (f.mine && !mine.has(d.ticker)) return false;
    if (q && !(d.ticker.toLowerCase().includes(q) || d.member.toLowerCase().includes(q) || (d.company || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

function rowHTML(d) {
  const a = d.a, q = S.quotes[d.ticker], hasRt = S.rt.set.has(d.ticker);
  const flags = [];
  if (d.flags.cluster) flags.push(`<span class="fl" title="${d.flags.cluster + 1} members traded ${esc(d.ticker)} the same way within 30 days">Cluster ×${d.flags.cluster + 1}</span>`);
  if (d.flags.overlap.length) flags.push(`<span class="fl" title="Member sits on: ${esc(d.flags.overlap.join("; "))}">Committee</span>`);
  if (d.flags.late) flags.push(`<span class="fl" title="Filed ${d.lagDays} days after the trade; the STOCK Act limit is 45">Late ${d.lagDays}d</span>`);
  if (d.lots > 1) flags.push(`<span class="fl" title="One trade split across ${d.lots} lots or accounts; amounts are summed">${d.lots} lots</span>`);
  if (d.owner && d.owner !== "self") flags.push(`<span class="fl">${esc(d.owner)}</span>`);
  if (d.instrument === "option") flags.push(`<span class="fl">option</span>`);
  if (hasRt) flags.push(`<span class="fl rt" title="Tradable 24/7 on Bitget as r${esc(d.ticker)}">r${esc(d.ticker)}${q && q.gap != null && fresh(q) ? " " + pct(q.gap, 1) : ""}</span>`);
  const num = a.rTotal != null && (a.verdict === "OPEN" || a.verdict === "PRICED_IN" || a.verdict === "REVERSED") ? `<i>${pct(a.rTotal)}</i>` : "";
  return `<li><button class="row" type="button" data-id="${esc(d.id)}" aria-selected="${S.sel === d.id}">
    <span class="r-main">
      <span class="r-line"><span class="side ${d.side}">${d.side === "buy" ? "BUY" : "SELL"}</span><span class="tk">${esc(d.ticker)}</span><span class="co">${esc(d.company)}</span></span>
      <span class="who">${esc(d.member)}${d.party ? ` · ${esc(d.party)}-${esc(d.state)}` : ""} · ${d.chamber === "house" ? "House" : "Senate"} · ${amount(d)}</span>
    </span>
    <span class="r-dates"><span>Traded <b>${dShort(d.tradeDate)}</b> → filed <b>${dShort(d.filedDate)}</b></span><span>${d.lagDays}d lag${d.stale ? " · stale" : ""}</span></span>
    <span class="r-end"><span class="v v-${a.verdict}" title="${esc(a.why || "Change in price since the member's trade, vs SPY, in the member's direction")}">${VERDICT[a.verdict] || a.verdict}${num}</span>${flags.join("")}</span>
  </button></li>`;
}

function renderFeed(keepScroll) {
  const rows = visible();
  const feed = $("#feed");
  const stale = S.data.filter((d) => d.stale).length;
  const c = $("#count");
  if (S.idFilter) c.innerHTML = `${rows.length} results for “${esc(S.idFilter.label)}” <button type="button" id="clear-ids">Clear</button>`;
  else c.innerHTML = `${rows.length.toLocaleString()} disclosure${rows.length === 1 ? "" : "s"}${S.f.win === "recent" && stale ? ` · ${stale.toLocaleString()} older trades hidden as stale (traded more than 60 days ago, often filed in bulk)` : ""}`;
  if (!rows.length) {
    feed.innerHTML = `<li class="empty"><p>Nothing matches these filters.</p><button class="btn" type="button" id="reset-f">Reset filters</button></li>`;
    return;
  }
  const y = window.scrollY;
  feed.innerHTML = rows.slice(0, 200).map(rowHTML).join("") + (rows.length > 200 ? `<li class="empty">Showing the first 200 of ${rows.length.toLocaleString()}. Narrow the filters or ask the desk.</li>` : "");
  if (keepScroll) window.scrollTo({ top: y });
}

// ---------- price chart ----------
async function series(t) {
  if (!S.pxCache.has(t)) S.pxCache.set(t, getJSON(`/data/px/${encodeURIComponent(t)}.json`).catch(() => null));
  return S.pxCache.get(t);
}

function chartSVG(s, d, live) {
  const W = 440, H = 150, P = { l: 6, r: 6, t: 10, b: 20 };
  const n = s.c.length, lo = Math.min(...s.c), hi = Math.max(...s.c), span = hi - lo || 1;
  const x = (i) => P.l + (i * (W - P.l - P.r)) / (n - 1);
  const y = (v) => P.t + (1 - (v - lo) / span) * (H - P.t - P.b);
  const at = (day) => { const i = s.d.findIndex((z) => z >= day); return i; };
  const path = s.c.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const it = at(d.a.entryDay || d.tradeDate), iff = at(d.a.filedDay || d.filedDate);
  const mk = [];
  if (it >= 0) mk.push(`<circle class="mk-t" cx="${x(it)}" cy="${y(s.c[it])}" r="5"><title>Member traded ${esc(d.tradeDate)} near ${px(s.c[it])}</title></circle>`);
  if (iff >= 0) mk.push(`<path class="mk-f" d="M${x(iff)},${y(s.c[iff]) - 7} l6,7 l-6,7 l-6,-7z"><title>Disclosed ${esc(d.filedDate)} near ${px(s.c[iff])}</title></path>`);
  mk.push(`<circle class="mk-n" cx="${x(n - 1)}" cy="${y(s.c[n - 1])}" r="3.5"><title>Last close ${px(s.c[n - 1])}</title></circle>`);
  const label = `Price of ${d.ticker} from ${s.d[0]} to ${s.d[n - 1]}. Member traded ${d.tradeDate}; disclosed ${d.filedDate}.`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="ax" x1="${P.l}" x2="${W - P.r}" y1="${H - P.b}" y2="${H - P.b}"/>
    <path class="ln" d="${path}"/>${mk.join("")}
    <text x="${P.l}" y="${H - 5}">${esc(dShort(s.d[0]))}</text><text x="${W - P.r}" y="${H - 5}" text-anchor="end">${esc(dShort(s.d[n - 1]))}</text>
    <text x="${P.l}" y="9">high ${px(hi)}</text><text x="${W - P.r}" y="${H - 5 - 12}" text-anchor="end">low ${px(lo)}</text></svg>
    <div class="legend"><span>○ member's trade${it < 0 ? " (before this window)" : ""}</span><span>◆ disclosure</span><span>● last close</span></div>`;
}

// ---------- detail panel ----------
function explain(d) {
  const a = d.a, who = d.member, act = d.side === "buy" ? "bought" : "sold";
  if (a.verdict === "UNCLEAR" || a.verdict === "INVALID") return esc(a.why || "No verdict.");
  const tail = {
    OPEN: (a.rTotal ?? 0) >= 0
      ? "Little of the move has happened yet: someone acting today is not obviously behind the member. That says nothing about whether the trade was informed."
      : "The price has drifted against the member, but within its normal noise, so nothing has clearly been missed and nothing has clearly failed either.",
    PRICED_IN: "The market has already moved in the member's direction, so acting now means paying for a move the member already captured.",
    REVERSED: "The market moved against the member since the trade, so an entry today is at a better price than theirs (or the idea is failing).",
  }[a.verdict];
  return `${esc(who)} ${act} <b>${esc(d.ticker)}</b> on ${esc(d.tradeDate)} at about $${px(a.entry)}. It was disclosed ${d.lagDays} day${d.lagDays === 1 ? "" : "s"} later (${esc(d.filedDate)}, about $${px(a.filedPx)}). Since the trade the stock has moved <b class="${cls(a.rTotal)}">${pct(a.rTotal)}</b> versus SPY in the member's direction: ${pct(a.rBefore)} before anyone could see the filing and ${pct(a.rSince)} since. That is <b>${(a.z ?? 0).toFixed(1)}σ</b> of the stock's own typical noise over ${a.h} trading day${a.h === 1 ? "" : "s"}. <b>${VERDICT[a.verdict]}.</b> ${tail}`;
}

const mid = (rt) => (rt ? rt.mid ?? rt.last : null); // bid/ask midpoint: `last` can lag the live book on a thin token
const fresh = (q) => !!(q && q.rtoken && q.rtoken.mid != null); // a two-sided book is what "trading right now" means here

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
  else if (!rt) add("fail", "No live rToken quote yet (feed unreachable or still loading).");
  else {
    if (S.rt.mock) add("warn", "Quote is MOCK development data, not Bitget.");
    else if (rt.mid == null) add("warn", `r${d.ticker} has no two-sided book right now, so it is not really trading; the last print (${px(rt.last)}) may be stale.`);
    else add("pass", `Live rToken book: bid ${px(rt.bid)} / ask ${px(rt.ask)} USDT.`);
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
  if (d.a.verdict === "PRICED_IN" && t.side === memberSide) add("warn", "Same side as the member, but their move is already priced in.");
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
    ${blocked ? `<p class="blocked">Ticket blocked by the checks above. Nothing to copy.</p>` : cmd ? `<pre class="cmd" id="cmd">${esc(cmd)}</pre>
      <div class="copy-row"><button class="btn" type="button" id="copy-cmd">Copy command</button><span id="copied" class="copied" role="status"></span></div>
      <details><summary class="muted">Order payload</summary><pre class="cmd">${esc(body)}</pre></details>
      <p class="muted" style="font-size:.8rem">Runs against Bitget's demo environment via the official <code>bgc</code> CLI; <code>--dry-run</code> previews the exact request without sending it. Price and quantity use this pair's own precision (${p.pp} and ${p.qp} decimals). Spot market buys are sized in USDT and limit orders in base units, so this uses a limit order with your slippage allowance.</p>` : ""}`;
}

async function renderDetail(d, soft) {
  const el = $("#detail");
  S.sel = d.id;
  const a = d.a, q = S.quotes[d.ticker], rt = q && q.rtoken, m = S.market;
  const s = await series(d.ticker);
  const closed = m && !m.open;
  const rtBlock = !S.rt.set.has(d.ticker) ? `<p class="muted">Bitget has no r${esc(d.ticker)} token, so this name is not tradable 24/7 there.</p>`
    : !rt ? `<p class="muted"><span class="spin" aria-hidden="true"></span>Loading live rToken quote…</p>`
    : `<dl class="kv"><dt>r${esc(d.ticker)}USDT mid (bid/ask)</dt><dd>${px(mid(rt))}</dd>
        <dt>Last US equity price</dt><dd>${q.equity ? px(q.equity.last) : "n/a"}</dd>
        <dt>rToken vs equity</dt><dd class="${cls(q.gap)}">${pct(q.gap, 2)}</dd>
        <dt>Bid / ask (spread)</dt><dd>${px(rt.bid)} / ${px(rt.ask)} (${q.spreadBps == null ? "n/a" : Math.round(q.spreadBps) + " bps"})</dd>
        <dt>Last trade print</dt><dd>${px(rt.last)}</dd>
        <dt>24h change</dt><dd class="${cls(rt.chg24h)}">${rt.chg24h == null ? "n/a" : pct(rt.chg24h, 2)}</dd></dl>
        <p class="muted" style="font-size:.84rem;margin-top:6px">${closed ? "The equity market is closed: this gap is where the market is already pricing the name ahead of the next open." : "Equities are open, so the gap is a premium/discount rather than an off-hours move."}${S.rt.mock ? " <b>MOCK data.</b>" : ""}</p>`;
  const flags = [];
  if (d.flags.cluster) flags.push(`${d.flags.cluster + 1} members traded ${esc(d.ticker)} the same way within 30 days.`);
  if (d.flags.overlap.length) flags.push(`${esc(d.member)} sits on ${esc(d.flags.overlap.join("; "))}, which oversees ${esc(d.sector)}. A heuristic overlap, not an accusation.`);
  if (d.flags.late) flags.push(`Filed ${d.lagDays} days after the trade; the STOCK Act limit is 45.`);
  if (d.owner && d.owner !== "self") flags.push(d.owner === "joint" ? "Held jointly with a spouse." : d.owner === "child" ? "Held by a dependent child." : "Held by the member's spouse.");
  if (!d.matched) flags.push("Filer not matched to a sitting member, so committee data is unavailable.");
  el.hidden = false;
  el.innerHTML = `<div class="d-head"><div><h2 id="d-title" tabindex="-1"><span class="side ${d.side}">${d.side === "buy" ? "BUY" : "SELL"}</span> ${esc(d.ticker)} <span class="muted" style="font-weight:400">${esc(d.company)}</span></h2>
      <div class="d-sub">${esc(d.member)}${d.party ? ` (${esc(d.party)}-${esc(d.state)})` : ""} · ${d.chamber === "house" ? "House" : "Senate"} · ${amount(d)} · ${esc(d.sector || "sector n/a")}${d.industry ? ` · ${esc(d.industry)}` : ""}</div>
      <div class="d-sub"><a href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">Source filing ↗</a></div></div>
      <button class="icon-btn close" type="button" id="d-close" aria-label="Close details"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
    <section class="sec"><h3>What the market did</h3>${s ? chartSVG(s, d) : `<p class="muted">Price history unavailable.</p>`}
      <div class="why" style="margin-top:8px">${explain(d)}</div></section>
    ${flags.length ? `<section class="sec"><h3>Context</h3><ul style="margin:0;padding-left:18px">${flags.map((f) => `<li>${f}</li>`).join("")}</ul></section>` : ""}
    <section class="sec"><h3>24/7 view · r${esc(d.ticker)} on Bitget</h3>${rtBlock}</section>
    <section class="sec"><h3>Paper-trading ticket (dry run)</h3><div id="ticket">${ticketHTML(d)}</div></section>
    <p class="muted" style="font-size:.78rem;margin-top:14px">Descriptive, not a forecast. On the Proof tab we test whether verdicts predict returns; so far they do not.</p>`;
  if (!soft) {
    if (matchMedia("(max-width: 980px)").matches) document.body.style.overflow = "hidden";
    $("#d-title").focus({ preventScroll: true });
  }
  $$(".row").forEach((r) => r.setAttribute("aria-selected", String(r.dataset.id === d.id)));
  if (S.rt.set.has(d.ticker) && !rt) { await ensureQuote(d.ticker); if (S.sel === d.id) renderDetail(d, true); }
}

function closeDetail() {
  $("#detail").hidden = true; S.sel = null; document.body.style.overflow = "";
  $$(".row").forEach((r) => r.setAttribute("aria-selected", "false"));
  if (S.opener && document.contains(S.opener)) S.opener.focus();
}

function openById(id, opener) {
  const d = S.byId.get(id);
  if (!d) return;
  S.opener = opener || null; S.tk.side = null;
  renderDetail(d);
}

// ---------- ask the desk ----------
const EXAMPLES = ["What did senators buy this week that's still open?", "Which disclosed stocks are gapping as rTokens right now?", "Any tech trades by members on the committee that oversees tech?", "Brief me on my watchlist"];
function renderExamples() { $("#ask-ex").innerHTML = EXAMPLES.map((e) => `<button class="chip-btn" type="button">${esc(e)}</button>`).join(""); }

async function ask(q) {
  const go = $("#ask-go"), out = $("#answer");
  go.disabled = true; out.hidden = false;
  out.innerHTML = `<span class="spin" aria-hidden="true"></span>Reading the filings…`;
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 40000);
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, watchlist: S.watch }), signal: ac.signal });
    const j = await res.json();
    if (!res.ok) { out.innerHTML = `<p>${esc(j.error || "Something went wrong.")}</p>`; return; }
    const body = esc(j.answer).replace(/\[([HS]-[A-Za-z0-9-]+)\]/g, (_, id) => `<button class="cite" type="button" data-cite="${id}" aria-label="Open disclosure ${id}">${esc((S.byId.get(id) || {}).ticker || id)}</button>`);
    const label = q.length > 48 ? q.slice(0, 47) + "…" : q;
    out.innerHTML = `<div class="txt">${body}</div><div class="meta">
      <span>${j.ids.length === 0 ? "No match" : j.mode === "llm" ? `Summary by ${esc((j.model || "").split("/").pop())}; the rows below are computed, not generated` : "Computed numbers only (no model summary this time)"}</span>
      <span>filter by ${j.planMode === "llm" ? "the model" : "keywords"}</span><span>${j.ids.length} matched</span>
      ${j.ids.length ? `<button class="btn" type="button" id="show-ids">Show these ${j.ids.length} in the feed</button>` : ""}</div>`;
    out.dataset.ids = JSON.stringify(j.ids); out.dataset.label = label;
    if (j.mock) S.rt.mock = true;
  } catch (e) {
    out.innerHTML = `<p>${e.name === "AbortError" ? "That took too long. Try a narrower question." : "Could not reach the desk. Check your connection and retry."}</p>`;
  } finally { clearTimeout(to); go.disabled = false; }
}

// ---------- watchlist ----------
function renderWatchlist() {
  const ul = $("#wl-list");
  ul.innerHTML = S.watch.length ? S.watch.map((t) => `<li>${esc(t)}${S.rt.set.has(t) ? ` <span class="fl rt" title="rToken available">r</span>` : ""}<button type="button" data-rm="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></li>`).join("") : `<li class="muted" style="border:0;background:none;padding:0;font-family:var(--sans)">Empty. Add a ticker to get started.</li>`;
}

// ---------- proof + method ----------
const pp = (v, d = 2) => (v == null ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
async function renderProof() {
  const el = $("#view-proof");
  if (el.dataset.ready) return;
  try { S.proof = await getJSON("/data/proof.json"); } catch { el.innerHTML = `<div class="doc"><p class="muted">Proof data not built yet. Run <code>npm run proof</code>.</p></div>`; return; }
  const P = S.proof, M = S.meta || {}, cov = (M.coverage || {}), h = cov.house || {}, sn = cov.senate || {};
  const nf5 = P.naiveFollow["5d"], nf20 = P.naiveFollow["20d"], v5 = P.byVerdict["5d"], v20 = P.byVerdict["20d"], d5 = P.openMinusPricedIn["5d"], d20 = P.openMinusPricedIn["20d"];
  const vrow = (name, k) => `<tr><td>${name}</td>${["5d", "20d"].map((H) => { const s = P.byVerdict[H][k]; return s ? `<td>${pp(s.meanPct)}</td><td>${s.n.toLocaleString()}</td><td>${s.tClustered ?? "n/a"}</td>` : `<td colspan="3">n/a</td>`; }).join("")}</tr>`;
  const stale = S.data.filter((d) => d.stale).length;
  el.innerHTML = `<article class="doc">
    <h1>Proof: what the data say, including the parts that don't flatter us</h1>
    <p class="lede">Every number on this page is computed by <code>pipeline/analysis.py</code> from the same filings the desk shows. Observations are clustered by filing, and each trade is assessed on the first close <em>after</em> its filing date, so there is no look-ahead.</p>
    <div class="callout"><strong>Headline.</strong> Following a Congress disclosure the day it appears has <strong>no statistically reliable edge</strong>: ${pp(nf5.meanPct)} excess over 5 trading days (naive t = ${nf5.tNaive}, but ${nf5.tClustered} once clustered by filing, ${nf5.clusters} filings) and ${pp(nf20.meanPct)} over 20 days (clustered t = ${nf20.tClustered}, borderline and not robust to the caveats below). The desk's verdicts (Open vs Priced in) do <strong>not</strong> forecast returns either. So the desk does not emit buy/sell signals. It tells you what has already happened, what hasn't, and hands you the decision.</div>
    <h2>1. Does naively following a disclosure make money?</h2>
    <table class="t"><thead><tr><th></th><th>Mean excess</th><th>Median</th><th>Hit rate</th><th>Trades</th><th>Filings</th><th>t (naive)</th><th>t (clustered)</th></tr></thead><tbody>
      ${[["5 trading days", nf5], ["20 trading days", nf20]].map(([n, s]) => `<tr><td>${n}</td><td>${pp(s.meanPct)}</td><td>${pp(s.medianPct)}</td><td>${s.hitRatePct}%</td><td>${s.n.toLocaleString()}</td><td>${s.clusters}</td><td>${s.tNaive}</td><td>${s.tClustered}</td></tr>`).join("")}
    </tbody></table>
    <p class="muted">Direction-adjusted excess return vs SPY (positive = the member's side was right). |t| below ~2 is indistinguishable from zero. Trades inside one filing move together, so the per-trade t-stat overstates significance; the clustered one is the honest one.</p>
    <h2>2. Do the desk's verdicts separate outcomes?</h2>
    <table class="t"><thead><tr><th rowspan="2">Verdict at filing</th><th colspan="3">Next 5 days</th><th colspan="3">Next 20 days</th></tr><tr><th>Mean</th><th>n</th><th>t</th><th>Mean</th><th>n</th><th>t</th></tr></thead><tbody>
      ${vrow("Open", "OPEN")}${vrow("Priced in", "PRICED_IN")}${vrow("Reversed", "REVERSED")}</tbody></table>
    <div class="callout">Open − Priced in: <strong>${d5 ? pp(d5.diffPct) : "n/a"}</strong> at 5 days (Welch t = ${d5?.tWelch ?? "n/a"}) and <strong>${d20 ? pp(d20.diffPct) : "n/a"}</strong> at 20 days (t = ${d20?.tWelch ?? "n/a"}). Neither is significant, and the sign flips between horizons. <strong>Verdicts are an accounting of what a follower has already missed, not a prediction</strong>, and the desk labels them that way everywhere.</div>
    <h2>3. Data coverage and quality</h2>
    <div class="stats">
      <div class="stat"><div class="n">${h.markers ? (100 * h.parsed / h.markers).toFixed(1) : "?"}%</div><div class="l">of ${h.markers?.toLocaleString() ?? "?"} House transaction rows parsed from PDFs</div></div>
      <div class="stat"><div class="n">${h.scanned ?? "?"} / ${h.filings ?? "?"}</div><div class="l">House filings are scanned images with no text (not readable yet)</div></div>
      <div class="stat"><div class="n">${sn.paperReports ?? "?"} / ${sn.reports ?? "?"}</div><div class="l">Senate reports are paper scans (not readable yet)</div></div>
      <div class="stat"><div class="n">${stale.toLocaleString()}</div><div class="l">disclosed trades are over 60 days old: hidden from the default feed</div></div>
    </div>
    <p class="muted">Errors we catch instead of passing on: trade dates that fall after the filing date (a typo in the original), option trades whose call/put side isn't stated (marked Unclear rather than guessed), and filers who don't match a sitting member (no committee claim is made for them).</p>
    <h2>4. The 24/7 layer, observed live</h2>
    <div id="gap-study"><p class="muted"><span class="spin" aria-hidden="true"></span>Loading…</p></div>
    <h2>5. Limitations</h2>
    <ul>${P.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    <p class="muted">Method: ${esc(P.method.split("\n").slice(0, 1).join(" "))} Generated ${esc(P.asOf)}.</p></article>`;
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
  const intro = `<p>Every 15 minutes the desk records the rToken price and the US equity price for the recently disclosed names. That lets us test the thesis on real data instead of asserting it: <em>when the stock market is closed, does the rToken already price in where the stock will open?</em></p>`;
  const base = g.snapshots ? `<div class="stats">
      <div class="stat"><div class="n">${g.snapshots.toLocaleString()}</div><div class="l">snapshots recorded${g.first ? ` since ${new Date(g.first).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</div></div>
      <div class="stat"><div class="n">${bps(b.open.medianAbsGapBps)}</div><div class="l">median rToken-vs-stock gap while both trade (${b.open.samples.toLocaleString()} samples; spread ${bps(b.open.medianSpreadBps)})</div></div>
      <div class="stat"><div class="n">${bps(b.closed.medianAbsGapBps)}</div><div class="l">median gap while US stocks are closed (${b.closed.samples.toLocaleString()} samples; spread ${bps(b.closed.medianSpreadBps)})</div></div></div>` : "";
  if (!g.weekends.length) {
    el.innerHTML = intro + base + `<div class="callout"><strong>Collecting.</strong> No complete weekend yet. The first one (Friday Oct 2 → Monday Oct 5) will be analysed here as soon as Monday's open has happened. Until then, no claim is made about whether weekend rToken gaps predict the open.</div>`;
    return;
  }
  const w = g.weekends.map((k) => `<h3 style="margin-top:14px">${fdate(k.friday)} close → ${fdate(k.monday)} open · ${k.n} names</h3>
    <div class="stats">
      <div class="stat"><div class="n">${k.correlation == null ? "n/a" : k.correlation.toFixed(2)}</div><div class="l">correlation, weekend rToken gap vs Monday move</div></div>
      <div class="stat"><div class="n">${k.signAgreementPct == null ? "n/a" : Math.round(k.signAgreementPct) + "%"}</div><div class="l">same direction (of ${k.signAgreementN} names with a gap ≥ 0.2%)</div></div>
      <div class="stat"><div class="n">${k.meanAbsWeekendGapPct.toFixed(2)}% / ${k.meanAbsMondayMovePct.toFixed(2)}%</div><div class="l">mean |weekend gap| / mean |Monday move|</div></div></div>
    <table class="t"><thead><tr><th>Name</th><th>rToken weekend gap</th><th>Monday move</th></tr></thead><tbody>${k.pairs.slice(0, 8).map((p) => `<tr><td>${esc(p.t)}</td><td class="${cls(p.weekendGap)}">${pct(p.weekendGap, 2)}</td><td class="${cls(p.mondayMove)}">${pct(p.mondayMove, 2)}</td></tr>`).join("")}</tbody></table>`).join("");
  el.innerHTML = intro + base + w + `<p class="muted">${esc(g.note)}${g.mock ? " <b>Includes MOCK development data.</b>" : ""}</p>`;
}

function renderMethod() {
  const el = $("#view-method");
  if (el.dataset.ready) return;
  el.innerHTML = `<article class="doc">
    <h1>Method</h1>
    <p class="lede">Disclosure Desk is a human-in-the-loop research tool. The numbers are deterministic; the language model only routes your question and explains rows it was handed.</p>
    <h2>The verdict</h2>
    <p>For a disclosed trade in direction <em>d</em> (+1 buy, −1 sell) made on <em>t₀</em> and disclosed on <em>t₁</em>, with <code>excess</code> = the stock's return minus SPY's over the same window:</p>
    <ul>
      <li><b>Moved before filing</b> = d × excess(t₀→t₁): what happened before anyone could see the trade.</li>
      <li><b>Moved since filing</b> = d × excess(t₁→now).</li>
      <li><b>Missed by a follower today</b> = d × excess(t₀→now), reported in σ units: <code>z = missed / (σ·√h)</code>, where σ is the stock's own daily excess-return noise over the 60 days before the trade and h the trading days elapsed.</li>
      <li><b>Priced in</b> if z ≥ 1 and missed ≥ 1%; <b>Reversed</b> if z ≤ −1 and missed ≤ −1%; otherwise <b>Open</b>. Options are <b>Unclear</b> (the filing doesn't say call or put); trades dated after their own filing are flagged as typos.</li>
    </ul>
    <h2>Flags</h2>
    <ul><li><b>Cluster</b>: at least 3 members traded the same ticker the same way within 30 days.</li>
    <li><b>Committee</b>: the member sits on a committee whose jurisdiction covers the company's sector (a coarse, heuristic mapping; context, not an accusation).</li>
    <li><b>Late</b>: filed more than 45 days after the trade, the STOCK Act limit.</li>
    <li><b>Stale</b>: trade more than 60 days old (often bulk filings), hidden by default.</li></ul>
    <h2>The 24/7 layer</h2>
    <p>Congress files at any hour; US equities reprice only at the open. Bitget's rTokens (tokenized US stocks, <code>r&lt;TICKER&gt;USDT</code>) trade continuously, so when the equity market is closed the desk ranks recently disclosed names by the gap between their rToken price and the last equity close, and builds a <b>paper-trading ticket</b> for the official <code>bgc</code> CLI (<code>--paper-trading --dry-run</code>). Tickets pass a deterministic risk gate first: rToken must exist, spread ≤ 40 bps (hard stop at 100), order 10–250 USDT, slippage ≤ 50 bps, quote fresh. The desk never holds keys or places orders.</p>
    <h2>Role of the language model</h2>
    <ol><li><b>Planner</b>: turns a question into a JSON filter (tickers, members, party, state, sector, verdict, side, window, sort). If the model is unavailable, or its filter finds nothing, a keyword planner reads the same question.</li>
    <li><b>Summary writer</b>: writes two sentences about the rows that matched. Code then <b>rejects the text</b> if it contains any number that is not in the data, any count or number word, or any forecast or advice, and gives the model one corrected retry before falling back to no summary. The cited list of rows underneath is rendered by code with exact figures, so nothing in it is generated.</li></ol>
    <p>Model: Qwen (<code>qwen3-30b-a3b-fp8</code>) via Cloudflare Workers AI, or any OpenAI-compatible endpoint (for example the hackathon's Qwen credits).</p>
    <h2>Sources</h2>
    <ul><li>US House Clerk periodic transaction reports (official PDFs), parsed by <code>pipeline/house_parse.py</code>.</li>
    <li>US Senate eFD reports, read through a public GitHub Actions mirror because efdsearch.senate.gov blocks datacenter IPs; each row links back to the eFD filing.</li>
    <li>Prices: Yahoo Finance chart API. Sectors: Yahoo search. Members and committees: <a href="https://github.com/unitedstates/congress-legislators" rel="noopener noreferrer">unitedstates/congress-legislators</a>. rTokens: Bitget's official agent MCP (<code>crypto_market</code> for the token universe and each pair's trading rules, <code>crypto_spot_ticker</code> for live bid/ask). rToken prices use the bid/ask midpoint, because the last trade can lag the live book on a thin token.</li></ul>
    <h2>Use of the data</h2>
    <p>Disclosure reports may not be used for commercial purposes (5 U.S.C. §13107(c)). This is a non-commercial research demo; it is not investment advice.</p></article>`;
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
  try { const t = localStorage.getItem("dd.theme"); if (t) document.documentElement.dataset.theme = JSON.parse(t); } catch { /* keep pre-paint theme */ }

  document.addEventListener("click", (e) => {
    const t = e.target;
    const row = t.closest(".row"); if (row) return openById(row.dataset.id, row);
    const gw = t.closest(".gw-btn");
    if (gw) { const d = S.data.find((x) => x.ticker === gw.dataset.tk && !x.stale) || S.data.find((x) => x.ticker === gw.dataset.tk); if (d) { S.idFilter = null; openById(d.id, gw); } return; }
    const cite = t.closest(".cite"); if (cite) { const d = S.byId.get(cite.dataset.cite); if (d) openById(d.id, cite); return; }
    if (t.closest("#d-close")) return closeDetail();
    if (t.closest("#reset-f")) return resetFilters();
    if (t.closest("#clear-ids")) { S.idFilter = null; renderFeed(); return; }
    const sh = t.closest("#show-ids"); if (sh) { const o = $("#answer"); S.idFilter = { ids: JSON.parse(o.dataset.ids), label: o.dataset.label }; renderFeed(); $("#count").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const ex = t.closest("#ask-ex .chip-btn"); if (ex) { $("#ask-q").value = ex.textContent; return ask(ex.textContent); }
    const rm = t.closest("[data-rm]"); if (rm) { S.watch = S.watch.filter((x) => x !== rm.dataset.rm); store.set("dd.watch", S.watch); renderWatchlist(); if (S.f.mine) renderFeed(); return; }
    const cp = t.closest("#copy-cmd"); if (cp) return copyCmd();
    const sb = t.closest(".seg-btn");
    if (sb) { S.f[sb.dataset.f] = sb.dataset.v; $$(`.seg-btn[data-f="${sb.dataset.f}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === sb))); S.idFilter = null; return renderFeed(); }
    const tg = t.closest(".tog");
    if (tg) { const k = tg.dataset.t; S.f[k] = !S.f[k]; tg.setAttribute("aria-pressed", String(S.f[k])); S.idFilter = null; return renderFeed(); }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.sel) return closeDetail();
    const row = e.target.closest && e.target.closest(".row");
    if (row && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const rows = $$(".row"), i = rows.indexOf(row), n = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) { e.preventDefault(); n.focus(); }
    }
  });

  $("#search").addEventListener("input", (e) => { S.f.q = e.target.value; S.idFilter = null; renderFeed(); });
  $("#ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#ask-q").value.trim(); if (q.length >= 3) ask(q); });
  $("#wl-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#wl-in"), t = inp.value.trim().toUpperCase();
    if (/^[A-Z]{1,5}(-[A-Z])?$/.test(t) && !S.watch.includes(t) && S.watch.length < 20) { S.watch.push(t); store.set("dd.watch", S.watch); renderWatchlist(); if (S.f.mine) renderFeed(); }
    inp.value = "";
  });
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
  S.f = { win: "recent", chamber: "", side: "", verdict: "", rtoken: false, cluster: false, overlap: false, mine: false, q: "" };
  S.idFilter = null; $("#search").value = "";
  $$(".seg-btn").forEach((b) => b.setAttribute("aria-pressed", String(S.f[b.dataset.f] === b.dataset.v)));
  $$(".tog").forEach((b) => b.setAttribute("aria-pressed", "false"));
  renderFeed();
}

async function copyCmd() {
  const txt = $("#cmd")?.textContent || "", note = $("#copied");
  try { await navigator.clipboard.writeText(txt); note.textContent = "Copied ✓"; } catch { note.textContent = "Select the command and copy it manually."; }
  setTimeout(() => { if (note) note.textContent = ""; }, 2500);
}

boot();
