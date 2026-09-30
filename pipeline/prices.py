"""Daily prices from Yahoo Finance's public chart endpoint (no key), cached per ticker."""
import concurrent.futures as cf
import json
import time
import urllib.parse
from datetime import datetime, timezone

from common import CACHE, http_get

PX = CACHE / "px"
PX.mkdir(exist_ok=True)


def _fetch(tk, rng):
    u = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(tk)}?range={rng}&interval=1d"
    r = json.loads(http_get(u, timeout=25))["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    adj = (r["indicators"].get("adjclose") or [{}])[0].get("adjclose") or q["close"]
    days, close, aclose = [], [], []
    for ts, c, a in zip(r["timestamp"], q["close"], adj):
        if c is None or a is None:
            continue
        days.append(datetime.fromtimestamp(ts, timezone.utc).date().isoformat())
        close.append(round(c, 4))
        aclose.append(round(a, 4))
    m = r["meta"]
    return {"days": days, "close": close, "adj": aclose,
            "meta": {"price": m.get("regularMarketPrice"), "time": m.get("regularMarketTime"),
                     "name": m.get("longName") or m.get("shortName"), "type": m.get("instrumentType")},
            "fetched": int(time.time())}


def get_one(tk, rng="5y", max_age_h=8):
    p = PX / f"{tk}.json"
    if p.exists() and (time.time() - p.stat().st_mtime) < max_age_h * 3600:
        return json.loads(p.read_text(encoding="utf-8"))
    try:
        d = _fetch(tk, rng)
        p.write_text(json.dumps(d), encoding="utf-8")
        return d
    except Exception:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def get_many(tickers, rng="5y", workers=8):
    out = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for tk, d in zip(tickers, ex.map(lambda t: get_one(t, rng), tickers)):
            if d and d["days"]:
                out[tk] = d
    return out
