"""Parse House PTR PDFs (text layer) into the shared disclosure schema.

Each transaction is a row anchored by `TYPE DATE DATE $lo -`, whose asset name and $hi may wrap onto
later lines; every record ends at the "Filing Status: New" marker (extracted as "F S : New").
Scanned filings have no text layer and are counted, not parsed.
"""
import json
import re
from pathlib import Path

import pdfplumber

from common import CACHE, us_date

TYPE = r"(?:P|S|E|S \(partial\)|s \(partial\)|S \(Partial\))"
ANCHOR = re.compile(
    rf"^(?:(?P<own>SP|DC|JT)\s+)?(?P<pre>.*?)\s?\b(?P<type>{TYPE})\s+(?P<d1>\d{{1,2}}/\d{{1,2}}/\d{{4}})\s+"
    r"(?P<d2>\d{1,2}/\d{1,2}/\d{4})\s+(?P<lo>\$[\d,]+)\s*[-–—]?\s*(?P<rest>.*)$",
    re.S,
)
MARKER = re.compile(r"^F\s+S\s*:", re.M)
KEEP_TAGS = {"ST": "stock", "OP": "option", "EF": "stock", "ET": "stock"}
OWNER = {"SP": "spouse", "JT": "joint", "DC": "child", None: "self"}


def _money(s):
    return float(s.replace("$", "").replace(",", "")) if s else None


def parse_text(text):
    """Return (rows, markers). Rows are raw dicts; markers is the number of records the PDF declares."""
    lines = text.split("\n")
    markers = len(MARKER.findall(text))
    rows, cur = [], None
    for ln in lines:
        if MARKER.match(ln):
            if cur:
                rows.append(" ".join(cur))
            cur = None
            continue
        if cur is None:
            if re.search(rf"\b{TYPE}\s+\d{{1,2}}/\d{{1,2}}/\d{{4}}\s+\d{{1,2}}/\d{{1,2}}/\d{{4}}\s+\$", ln):
                cur = [ln]
        else:
            cur.append(ln)
    out = []
    for rec in rows:
        rec = re.sub(r"\s+", " ", rec).strip()
        m = ANCHOR.match(rec)
        if not m:
            continue
        rest = m["rest"]
        hi = re.search(r"\$[\d,]+", rest)
        name = (m["pre"] + " " + re.sub(r"\$[\d,]+", "", rest)).strip()
        tag = re.search(r"\[([A-Z]{2})\]", name)
        tick = re.findall(r"\(([A-Z]{1,5}(?:[.\-][A-Z])?)\)", name)
        out.append({
            "owner": OWNER[m["own"]],
            "asset": re.sub(r"\s*\[[A-Z]{2}\]\s*", " ", name).strip(),
            "tag": tag.group(1) if tag else None,
            "ticker": tick[-1].replace(".", "-") if tick else None,
            "side": "buy" if m["type"] == "P" else ("sell" if m["type"].lower().startswith("s") else None),
            "tradeDate": us_date(m["d1"]), "notifiedDate": us_date(m["d2"]),
            "amountLo": _money(m["lo"]), "amountHi": _money(hi.group(0)) if hi else None,
        })
    return out, markers


def parse_pdf(path):
    with pdfplumber.open(path) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages).replace("\x00", "")
    if len(text.strip()) < 200:
        return None, 0, True  # scanned / no text layer
    rows, markers = parse_text(text)
    return rows, markers, False


def load(year=2026):
    idx = json.loads((CACHE / "house_index.json").read_text(encoding="utf-8"))
    rows, st = [], {"filings": 0, "scanned": 0, "missing": 0, "markers": 0, "parsed": 0, "kept": 0}
    for rec in idx:
        if rec["year"] != year:
            continue
        st["filings"] += 1
        p = CACHE / "house" / f"{rec['year']}_{rec['docId']}.pdf"
        if not p.exists():
            st["missing"] += 1
            continue
        try:
            recs, markers, scanned = parse_pdf(p)
        except Exception:
            st["missing"] += 1
            continue
        if scanned:
            st["scanned"] += 1
            continue
        st["markers"] += markers
        st["parsed"] += len(recs)
        name = " ".join(x for x in (rec["first"], rec["last"], rec["suffix"]) if x)
        filed = us_date(rec["filingDate"])
        for i, r in enumerate(recs):
            if r["tag"] not in KEEP_TAGS or not r["ticker"] or not r["side"] or not r["tradeDate"]:
                continue
            rows.append({
                "id": f"H-{rec['docId']}-{i}", "chamber": "house", "member": name,
                "first": rec["first"], "last": rec["last"], "stateDst": rec["stateDst"],
                "ticker": r["ticker"], "asset": r["asset"], "instrument": KEEP_TAGS[r["tag"]],
                "side": r["side"], "owner": r["owner"], "amountLo": r["amountLo"], "amountHi": r["amountHi"],
                "tradeDate": r["tradeDate"], "notifiedDate": r["notifiedDate"], "filedDate": filed,
                "link": f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{rec['year']}/{rec['docId']}.pdf",
            })
            st["kept"] += 1
    return rows, st


if __name__ == "__main__":
    r, s = load()
    print(s)
    for x in r[:3]:
        print(x)
