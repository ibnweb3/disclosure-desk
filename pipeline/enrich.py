"""Deterministic 'is it still actionable?' assessment for a disclosed trade.

Everything here is plain arithmetic on daily prices (no LLM): the desk's language model may only
*explain* these numbers, never invent them.

For a trade in direction d (+1 buy, -1 sell) by a member on trade date t0, disclosed on t1, assessed at
index N (default: the latest close):
  rBefore = d * excess(t0 -> t1)      how far the market moved in the member's favour before anyone could see it
  rSince  = d * excess(t1 -> N)       how far it has moved since the disclosure became public
  rTotal  = d * excess(t0 -> N)       what a follower entering now has already missed
  z       = rTotal / (sigma * sqrt(h))   rTotal in units of the ticker's own typical excess-return noise over
                                          the h trading days elapsed (sigma = daily stdev of excess returns, 60d pre-trade)
Verdict: PRICED_IN if z >= 1 and rTotal >= 1%, REVERSED if z <= -1 and rTotal <= -1%, else OPEN.
'excess' is the ticker's return minus SPY's over the same window.
"""
import bisect
import math
import statistics as st

Z_CUT = 1.0
MIN_MOVE = 0.01
SIGMA_FLOOR = 0.006


class Series:
    def __init__(self, d):
        self.days, self.adj, self.close = d["days"], d["adj"], d["close"]
        self.pos = {day: i for i, day in enumerate(self.days)}

    def ge(self, day):
        i = bisect.bisect_left(self.days, day)
        return i if i < len(self.days) else None

    def at_or_before(self, day):
        i = bisect.bisect_right(self.days, day) - 1
        return i if i >= 0 else None


def _ret(s, i, j):
    return s.adj[j] / s.adj[i] - 1


def _excess(px, spy, i, j, bench=True):
    r = _ret(px, i, j)
    if not bench or spy is None:
        return r
    a, b = spy.at_or_before(px.days[i]), spy.at_or_before(px.days[j])
    if a is None or b is None:
        return r
    return r - _ret(spy, a, b)


def _sigma(px, spy, i0, bench):
    lo = max(1, i0 - 60)
    xs = [_excess(px, spy, k - 1, k, bench) for k in range(lo, i0 + 1)]
    return max(st.pstdev(xs), SIGMA_FLOOR) if len(xs) >= 10 else None


def assess(row, px, spy, asof=None):
    """Return the numbers + verdict for one disclosure, or a verdict of UNCLEAR/INVALID with a reason."""
    if row["instrument"] == "option":
        return {"verdict": "UNCLEAR", "why": "Option trade: the filing does not state call vs put, so direction is unknowable."}
    if row["tradeDate"] > row["filedDate"]:
        return {"verdict": "INVALID", "why": "Trade date is after the filing date - a typo in the original filing."}
    i0 = px.ge(row["tradeDate"])
    if i0 is None:
        return {"verdict": "UNCLEAR", "why": "No price history after the trade date."}
    n = len(px.days) - 1 if asof is None else asof
    i1 = px.ge(row["filedDate"])
    i1 = n if i1 is None else min(i1, n)
    if i0 > n:
        return {"verdict": "UNCLEAR", "why": "Trade is after the assessment date."}
    bench = row["ticker"] != "SPY"
    d = 1 if row["side"] == "buy" else -1
    h = max(n - i0, 0)
    sig = _sigma(px, spy, i0, bench)
    r_before = d * _excess(px, spy, i0, min(i1, n), bench)
    r_since = d * _excess(px, spy, min(i1, n), n, bench)
    r_total = d * _excess(px, spy, i0, n, bench)
    z = r_total / (sig * math.sqrt(max(h, 1))) if sig else 0.0
    if z >= Z_CUT and r_total >= MIN_MOVE:
        v = "PRICED_IN"
    elif z <= -Z_CUT and r_total <= -MIN_MOVE:
        v = "REVERSED"
    else:
        v = "OPEN"
    return {
        "verdict": v, "z": round(z, 2), "h": h,
        "entry": px.close[i0], "entryDay": px.days[i0],
        "filedPx": px.close[i1], "filedDay": px.days[i1],
        "last": px.close[n], "lastDay": px.days[n],
        "rBefore": round(r_before, 4), "rSince": round(r_since, 4), "rTotal": round(r_total, 4),
        "sigma": round(sig, 4) if sig else None,
    }
