"""Build the static data the desk serves: disclosures.json (feed), px/*.json (charts), meta.json."""
import collections
import datetime as dt
import json
import sys

import enrich
import house_parse
import members
import prices
import sectors
import senate_load
from common import DATA_OUT, days_between

FEED_DAYS = 90
STOCK_ACT_DAYS = 45
STALE_DAYS = 60  # a trade older than this is history, not something to act on


def main(skip_house_fetch=True):
    today = dt.datetime.now(dt.timezone.utc).date()
    s_rows, s_stats = senate_load.load()
    h_rows, h_stats = house_parse.load(today.year)
    rows = s_rows + h_rows
    print(f"senate {len(s_rows)} rows | house {len(h_rows)} rows")

    tickers = sorted({r["ticker"] for r in rows} | {"SPY"})
    px_raw = prices.get_many(tickers, rng="5y")
    print(f"prices for {len(px_raw)}/{len(tickers)} tickers")
    series = {t: enrich.Series(d) for t, d in px_raw.items()}
    spy = series.get("SPY")
    sec = sectors.load([t for t in tickers if t in px_raw])
    M = members.Members()

    feed_from = (today - dt.timedelta(days=FEED_DAYS)).isoformat()
    # cluster index: (ticker, side) -> [(tradeDate, member)]
    idx = collections.defaultdict(list)
    for r in rows:
        idx[(r["ticker"], r["side"])].append((r["tradeDate"], r["member"]))

    out, mcache = [], {}
    for r in rows:
        if r["filedDate"] < feed_from or r["ticker"] not in series:
            continue
        key = (r["chamber"], r["member"], r.get("stateDst"))
        if key not in mcache:
            mcache[key] = M.match(r)
        mi = mcache[key]
        px = series[r["ticker"]]
        meta = px_raw[r["ticker"]]["meta"]
        etf = (meta.get("type") or "").upper() in ("ETF", "MUTUALFUND")
        sc = sec.get(r["ticker"], {})
        sector = "ETF" if etf else sc.get("bucket")
        age = days_between(r["tradeDate"], today.isoformat())
        a = enrich.assess(r, px, spy)
        others = {m for d, m in idx[(r["ticker"], r["side"])]
                  if m != r["member"] and abs(days_between(d, r["tradeDate"])) <= 30}
        overlap = []
        if mi and sector and sector in mi["jurisdiction"]:
            overlap = [c["name"] for c in mi["committees"] if sector in members.JURISDICTION.get(c["id"], [])]
        lag = days_between(r["tradeDate"], r["filedDate"])
        out.append({
            "id": r["id"], "chamber": r["chamber"], "member": (mi or {}).get("name") or r["member"],
            "party": (mi or {}).get("party"), "state": (mi or {}).get("state"), "matched": bool(mi),
            "ticker": r["ticker"], "company": meta.get("name") or r["asset"][:60], "asset": r["asset"][:90],
            "sector": sector, "industry": sc.get("industry"), "etf": etf,
            "ageDays": age, "stale": age > STALE_DAYS,
            "instrument": r["instrument"], "side": r["side"], "owner": r["owner"],
            "amountLo": r["amountLo"], "amountHi": r["amountHi"],
            "tradeDate": r["tradeDate"], "filedDate": r["filedDate"], "lagDays": lag,
            "flags": {"late": lag > STOCK_ACT_DAYS, "cluster": len(others) if len(others) >= 2 else 0,
                      "overlap": overlap},
            "a": a, "link": r["link"],
        })
    # one trade split across lots/accounts is one event: merge, summing the disclosed value ranges
    merged = {}
    for o in out:
        k = (o["member"], o["ticker"], o["side"], o["tradeDate"], o["filedDate"], o["link"])
        if k not in merged:
            merged[k] = dict(o, lots=1)
            continue
        m = merged[k]
        m["lots"] += 1
        for f in ("amountLo", "amountHi"):
            m[f] = (m[f] or 0) + (o[f] or 0) if (m[f] is not None or o[f] is not None) else None
    out = sorted(merged.values(), key=lambda x: (x["filedDate"], x["tradeDate"]), reverse=True)

    # an unattended run must never replace good data with a throttled/partial one
    if len(px_raw) < 0.7 * len(tickers) or len(out) < 100:
        sys.exit(f"refusing to overwrite published data: prices {len(px_raw)}/{len(tickers)}, feed rows {len(out)}")

    # chart series for feed tickers (last ~160 trading days)
    px_dir = DATA_OUT / "px"
    px_dir.mkdir(exist_ok=True)
    for f in px_dir.glob("*.json"):
        f.unlink()
    for t in {o["ticker"] for o in out}:
        s = series[t]
        (px_dir / f"{t}.json").write_text(json.dumps(
            {"t": t, "n": px_raw[t]["meta"].get("name"), "d": s.days[-160:], "c": s.close[-160:]},
            separators=(",", ":")), encoding="utf-8")

    (DATA_OUT / "disclosures.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    verdicts = collections.Counter(o["a"]["verdict"] for o in out)
    meta = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "priceAsOf": spy.days[-1] if spy else None, "feedDays": FEED_DAYS, "count": len(out),
        "verdicts": dict(verdicts),
        "coverage": {"senate": s_stats, "house": h_stats,
                     "houseParsePct": round(100 * h_stats["parsed"] / max(1, h_stats["markers"]), 1)},
        "sources": ["disclosures-clerk.house.gov (official, PDF)", "efdsearch.senate.gov via public GitHub mirror",
                    "Yahoo Finance chart API (prices)", "Yahoo Finance search API (sector, industry)",
                    "unitedstates/congress-legislators (members, committees)"],
    }
    (DATA_OUT / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print("feed", len(out), dict(verdicts))
    return rows, series, spy, M


if __name__ == "__main__":
    main()
