"""Member metadata + committee assignments from github.com/unitedstates/congress-legislators (public domain)."""
import re

from common import cached_json

BASE = "https://unitedstates.github.io/congress-legislators/"
SUFFIX = {"jr", "sr", "ii", "iii", "iv", "md", "phd"}

# Which sector buckets each top-level committee has jurisdiction over (deliberately coarse).
JURISDICTION = {
    # Senate
    "SSAS": ["Defense"], "SSBK": ["Financials"], "SSEG": ["Energy", "Utilities"],
    "SSHR": ["Health"], "SSFI": ["Health"], "SSCM": ["Tech", "Telecom", "Transport"],
    "SSAF": ["Consumer"], "SSEV": ["Energy", "Utilities", "Materials"], "SSVA": ["Health"],
    # House
    "HSAS": ["Defense"], "HSBA": ["Financials"], "HSIF": ["Health", "Energy", "Utilities", "Tech", "Telecom"],
    "HSWM": ["Health"], "HSAG": ["Consumer"], "HSSY": ["Tech", "Defense"],
    "HSHM": ["Defense"], "HSVR": ["Health"], "HSPW": ["Transport", "Industrials"],
}


def norm(s):
    toks = re.sub(r"[^a-z\s]", " ", (s or "").lower()).split()
    return " ".join(t for t in toks if t not in SUFFIX)


class Members:
    def __init__(self):
        legs = cached_json(BASE + "legislators-current.json", "legislators.json", max_age_h=24)
        coms = cached_json(BASE + "committees-current.json", "committees.json", max_age_h=24)
        mem = cached_json(BASE + "committee-membership-current.json", "membership.json", max_age_h=24)
        names = {c["thomas_id"]: c["name"] for c in coms}
        self.by_bio = {}
        for tid, lst in mem.items():
            if len(tid) != 4:  # subcommittees carry a numeric suffix
                continue
            for m in lst:
                self.by_bio.setdefault(m["bioguide"], []).append(
                    {"id": tid, "name": names.get(tid, tid), "title": m.get("title")})
        self.legs = []
        for l in legs:
            t = l["terms"][-1]
            self.legs.append({
                "bio": l["id"]["bioguide"], "name": l["name"].get("official_full") or l["name"]["last"],
                "first": norm(l["name"].get("first")), "nick": norm(l["name"].get("nickname")),
                "last": norm(l["name"].get("last")), "type": t["type"], "state": t["state"],
                "district": t.get("district"), "party": (t.get("party") or "?")[0],
            })

    def match(self, row):
        last = norm(row.get("last"))
        if not last:
            return None
        if row["chamber"] == "house":
            sd = row.get("stateDst") or ""
            state, dist = sd[:2], sd[2:]
            for l in self.legs:
                if l["type"] == "rep" and l["state"] == state and str(l["district"]) == str(int(dist or -1)) \
                        and (l["last"] in last or last in l["last"]):
                    return self._info(l)
            return None
        cands = [l for l in self.legs if l["type"] == "sen" and (l["last"] == last or l["last"] in last)]
        # a shared surname is not enough: some given-name initial must agree, or we would attach the
        # wrong person's committees to a filer who is not a sitting senator
        inits = {t[:1] for t in norm(row.get("first")).split()}
        cands = [c for c in cands if inits & {c["first"][:1], c["nick"][:1]}]
        return self._info(cands[0]) if len(cands) == 1 else None

    def _info(self, l):
        coms = self.by_bio.get(l["bio"], [])
        juris = sorted({s for c in coms for s in JURISDICTION.get(c["id"], [])})
        return {"bioguide": l["bio"], "name": l["name"], "party": l["party"], "state": l["state"],
                "committees": coms, "jurisdiction": juris}


if __name__ == "__main__":
    M = Members()
    print(len(M.legs), "legislators")
    print(M.match({"chamber": "senate", "first": "Thomas H", "last": "Tuberville"}))
    print(M.match({"chamber": "house", "last": "Sessions", "stateDst": "TX17"}))
