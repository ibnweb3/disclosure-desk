"""Download House Periodic Transaction Reports (PTRs) from the Clerk's official bulk index.

Source: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip
The zip holds an XML index; FilingType "P" rows are PTRs whose PDF lives at
public_disc/ptr-pdfs/{year}/{DocID}.pdf. PDFs are cached so re-runs are incremental.
"""
import concurrent.futures as cf
import io
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache" / "house"
UA = {"User-Agent": "DisclosureDesk/0.1 (Bitget AI Hackathon S2 research; contact via GitHub)"}


def get(url, tries=3, timeout=40):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network hiccup or 404
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def index(year):
    raw = get(f"https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip")
    z = zipfile.ZipFile(io.BytesIO(raw))
    xml = z.read(f"{year}FD.xml").decode("utf-8-sig", "ignore")
    out = []
    for m in ET.fromstring(xml).iter("Member"):
        g = lambda t: (m.findtext(t) or "").strip()
        if g("FilingType") != "P":
            continue
        out.append({
            "docId": g("DocID"), "first": g("First"), "last": g("Last"), "suffix": g("Suffix"),
            "prefix": g("Prefix"), "stateDst": g("StateDst"), "filingDate": g("FilingDate"), "year": year,
        })
    return out


def fetch_pdf(rec):
    p = CACHE / f"{rec['year']}_{rec['docId']}.pdf"
    if p.exists() and p.stat().st_size > 500:
        return rec["docId"], "cached"
    try:
        p.write_bytes(get(f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{rec['year']}/{rec['docId']}.pdf"))
        return rec["docId"], "ok"
    except Exception as e:
        return rec["docId"], f"fail {e}"


def main(years):
    CACHE.mkdir(parents=True, exist_ok=True)
    recs = []
    for y in years:
        recs += index(y)
    (ROOT / "cache" / "house_index.json").write_text(json.dumps(recs, indent=1), encoding="utf-8")
    print(f"{len(recs)} House PTR filings in index for {years}")
    counts = {}
    with cf.ThreadPoolExecutor(4) as ex:
        for _, status in ex.map(fetch_pdf, recs):
            k = status.split()[0]
            counts[k] = counts.get(k, 0) + 1
    print("download:", counts)


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or [2026])
