"""Senate PTRs from a public GitHub-Actions mirror of efdsearch.senate.gov.

efdsearch.senate.gov blocks datacenter / non-US IPs at the Akamai edge, so we read a mirror
(matr-co/senate-ptr, refreshed every ~2h from US runners) and keep the eFD report URL on every
row so a human can verify against the primary source. Paper filings are scanned images with no
text layer; they are counted (coverage stats) but cannot be parsed here.
"""
import re

from common import cached_json, clean_ticker

MIRROR = "https://raw.githubusercontent.com/matr-co/senate-ptr/main/senate_ptrs.json"
KEEP_TYPES = {"Stock", "Stock Option", "Other"}  # 'Other' carries ETFs/funds with tickers


def _side(t):
    t = (t or "").lower()
    if t.startswith("purchase"):
        return "buy"
    if t.startswith("sale"):
        return "sell"
    return None  # exchanges are not directional


def load():
    d = cached_json(MIRROR, "senate_ptrs.json", max_age_h=1)
    rows, stats = [], {"reports": 0, "paperReports": 0, "tradesSeen": 0, "tradesKept": 0}
    for r in d["reports"]:
        stats["reports"] += 1
        if "/paper/" in r["url"]:
            stats["paperReports"] += 1
            continue
        for i, t in enumerate(r["trades"]):
            stats["tradesSeen"] += 1
            tk, side = clean_ticker(t.get("ticker")), _side(t.get("type"))
            if not tk or not side or t.get("asset_type") not in KEEP_TYPES or not t.get("date"):
                continue
            asset = re.sub(r"\s+", " ", t.get("asset") or "").strip()
            rows.append({
                "id": f"S-{r['id'][:8]}-{i}",
                "chamber": "senate",
                "member": re.sub(r"\s+", " ", r["name"]).strip(),
                "first": r.get("first", ""), "last": r.get("last", ""),
                "ticker": tk, "asset": asset,
                "instrument": "option" if t["asset_type"] == "Stock Option" else "stock",
                "side": side,
                "owner": (t.get("owner") or "").lower() or None,
                "amountLo": t.get("lo"), "amountHi": t.get("hi"),
                "tradeDate": t["date"], "filedDate": r["filed"],
                "link": r["url"],
            })
            stats["tradesKept"] += 1
    stats["updated"] = d.get("updated")
    return rows, stats


if __name__ == "__main__":
    rows, st = load()
    print(st)
    print(rows[0])
