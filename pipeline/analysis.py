"""Validation numbers for the 'Proof' page. Two questions, answered on all history we hold
(Senate 2023-26 via mirror + House 2026), and reported whatever the answer is:

  1. Does naively following a disclosure make money?          (the tracker-app premise)
  2. Does the desk's verdict (OPEN vs PRICED_IN) separate outcomes?   (the desk's premise)

Method: assess each trade as a follower would see it - on the first close AFTER the filing date, so there
is no look-ahead - then measure direction-adjusted excess return over SPY for the next 5 / 20 trading days.
Observations are clustered by filing (one filing = one observation) because a member's trades inside one
filing are not independent; the naive per-trade t-stat is shown next to it to make the inflation visible.
"""
import collections
import datetime as dt
import json
import math
import statistics as st

import build
import enrich
from common import DATA_OUT

HORIZONS = (5, 20)


def tstat(x):
    if len(x) < 8:
        return None
    sd = st.stdev(x)
    return st.mean(x) / (sd / math.sqrt(len(x))) if sd else None


def welch(a, b):
    if len(a) < 8 or len(b) < 8:
        return None
    va, vb = st.variance(a) / len(a), st.variance(b) / len(b)
    return (st.mean(a) - st.mean(b)) / math.sqrt(va + vb) if va + vb else None


def summarize(obs, key):
    """obs: list of (cluster_id, value). Returns naive and clustered stats."""
    vals = [v for _, v in obs]
    cl = collections.defaultdict(list)
    for c, v in obs:
        cl[c].append(v)
    cm = [st.mean(v) for v in cl.values()]
    r = lambda x: None if x is None else round(x, 2)
    return {"n": len(vals), "clusters": len(cl),
            "meanPct": round(100 * st.mean(vals), 2) if vals else None,
            "medianPct": round(100 * st.median(vals), 2) if vals else None,
            "hitRatePct": round(100 * sum(v > 0 for v in vals) / len(vals), 1) if vals else None,
            "tNaive": r(tstat(vals)), "tClustered": r(tstat(cm)),
            "clusterMeans": cm}


def main():
    rows, series, spy, _ = build.main()
    by_v = {H: collections.defaultdict(list) for H in HORIZONS}
    allv = {H: [] for H in HORIZONS}
    for r in rows:
        px = series.get(r["ticker"])
        if not px or r["instrument"] != "stock" or r["tradeDate"] > r["filedDate"]:
            continue
        i1 = px.ge(r["filedDate"])
        if i1 is None:
            continue
        asof = i1 + 1
        if asof + min(HORIZONS) >= len(px.days):  # too recent to have any forward return
            continue
        cid = r["id"].rsplit("-", 1)[0]
        a = enrich.assess(r, px, spy, asof=asof)
        if a["verdict"] not in ("OPEN", "PRICED_IN", "REVERSED"):
            continue
        d = 1 if r["side"] == "buy" else -1
        for H in HORIZONS:
            if asof + H >= len(px.days):
                continue
            f = d * enrich._excess(px, spy, asof, asof + H, r["ticker"] != "SPY")
            by_v[H][a["verdict"]].append((cid, f))
            allv[H].append((cid, f))
    out = {"asOf": dt.date.today().isoformat(), "method": __doc__.strip(), "naiveFollow": {}, "byVerdict": {}, "openMinusPricedIn": {}}
    for H in HORIZONS:
        s = summarize(allv[H], H)
        cm = s.pop("clusterMeans")
        out["naiveFollow"][f"{H}d"] = s
        out["byVerdict"][f"{H}d"] = {}
        cms = {}
        for v, obs in by_v[H].items():
            s2 = summarize(obs, H)
            cms[v] = s2.pop("clusterMeans")
            out["byVerdict"][f"{H}d"][v] = s2
        if "OPEN" in cms and "PRICED_IN" in cms:
            out["openMinusPricedIn"][f"{H}d"] = {
                "diffPct": round(100 * (st.mean(cms["OPEN"]) - st.mean(cms["PRICED_IN"])), 2),
                "tWelch": None if welch(cms["OPEN"], cms["PRICED_IN"]) is None else round(welch(cms["OPEN"], cms["PRICED_IN"]), 2)}
    out["caveats"] = [
        "Prices exist only for tickers Yahoo still lists, so delisted names are missing (survivorship bias).",
        "No trading costs, spreads or slippage are modelled.",
        "Excess return is vs SPY only (no factor/beta adjustment).",
        "A few prolific filers supply most trades; clustering by filing reduces but does not remove that.",
        "Senate history 2023-26 + House 2026 only; short samples, wide error bars.",
    ]
    (DATA_OUT / "proof.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


if __name__ == "__main__":
    o = main()
    for H in ("5d", "20d"):
        print(f"\n== {H} ==")
        print("naive follow:", {k: v for k, v in o["naiveFollow"][H].items()})
        for v, s in o["byVerdict"][H].items():
            print(f"  {v:10s}", s)
        print("  OPEN - PRICED_IN:", o["openMinusPricedIn"].get(H))
