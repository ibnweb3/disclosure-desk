"""Sector / industry per ticker from Yahoo Finance's public search endpoint (no key), cached permanently.

(EDGAR's SIC codes would be the primary source, but the SEC's fair-access policy requires a contact
e-mail in the User-Agent, so we don't call it from a keyless hackathon build.)
"""
import concurrent.futures as cf
import json
import urllib.parse

from common import CACHE, http_get

FILE = CACHE / "sectors.json"
YAHOO_SECTOR = {
    "Technology": "Tech", "Communication Services": "Telecom", "Financial Services": "Financials",
    "Healthcare": "Health", "Energy": "Energy", "Utilities": "Utilities", "Industrials": "Industrials",
    "Consumer Cyclical": "Consumer", "Consumer Defensive": "Consumer", "Basic Materials": "Materials",
    "Real Estate": "RealEstate",
}


def bucket(sector, industry):
    ind = (industry or "").lower()
    if "aerospace" in ind or "defense" in ind:
        return "Defense"
    if any(k in ind for k in ("airline", "railroad", "trucking", "marine shipping", "airport", "integrated freight")):
        return "Transport"
    return YAHOO_SECTOR.get(sector)


def _one(t):
    try:
        u = f"https://query1.finance.yahoo.com/v1/finance/search?q={urllib.parse.quote(t)}&quotesCount=3&newsCount=0"
        qs = json.loads(http_get(u, timeout=20)).get("quotes") or []
        q = next((x for x in qs if x.get("symbol") == t), None)
        if not q:
            return t, {"sector": None, "industry": None, "bucket": None}
        sec, ind = q.get("sectorDisp") or q.get("sector"), q.get("industryDisp") or q.get("industry")
        return t, {"sector": sec, "industry": ind, "bucket": bucket(sec, ind)}
    except Exception:
        return t, None  # transient: do not cache, retry next build


def load(tickers):
    have = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {}
    need = [t for t in sorted(set(tickers)) if t not in have]
    if need:
        with cf.ThreadPoolExecutor(6) as ex:
            for t, v in ex.map(_one, need):
                if v is not None:
                    have[t] = v
        FILE.write_text(json.dumps(have), encoding="utf-8")
    return {t: have.get(t, {"sector": None, "industry": None, "bucket": None}) for t in tickers}
