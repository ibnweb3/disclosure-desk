"""Shared helpers: paths, cached HTTP, date parsing."""
import datetime as dt
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
PUBLIC = ROOT.parent / "public"
DATA_OUT = PUBLIC / "data"
UA = {"User-Agent": "Mozilla/5.0 DisclosureDesk/0.1 (Bitget AI Hackathon S2 research; github.com/ibnweb3)"}

for p in (CACHE, DATA_OUT):
    p.mkdir(parents=True, exist_ok=True)


def http_get(url, headers=None, tries=3, timeout=40):
    h = dict(UA)
    h.update(headers or {})
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def cached_json(url, name, max_age_h=6, headers=None):
    """GET a JSON url, caching under cache/<name>; falls back to a stale cache if the network fails."""
    p = CACHE / name
    if p.exists() and (time.time() - p.stat().st_mtime) < max_age_h * 3600:
        return json.loads(p.read_text(encoding="utf-8"))
    try:
        raw = http_get(url, headers=headers)
        p.write_bytes(raw)
        return json.loads(raw.decode("utf-8"))
    except Exception:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        raise


def us_date(s):
    """'09/22/2026' or '9/22/2026' -> '2026-09-22' (None if unparseable)."""
    m = re.fullmatch(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*", s or "")
    if not m:
        return None
    try:
        return dt.date(int(m[3]), int(m[1]), int(m[2])).isoformat()
    except ValueError:
        return None


def days_between(a, b):
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def clean_ticker(t):
    t = (t or "").strip().upper().replace(".", "-")
    return t if re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", t) else None
