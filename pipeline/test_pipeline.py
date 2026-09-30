"""Plain-assert tests (run: python pipeline/test_pipeline.py). They pin the two things a reader must be able to trust:
the House PDF row parser and the verdict arithmetic."""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import enrich  # noqa: E402
import house_parse  # noqa: E402


def test_parser_wrapped_amount_and_name():
    text = "\n".join([
        "JT Home Depot, Inc. (HD) [ST] S 07/20/2026 07/20/2026 $15,001 -",
        "$50,000",
        "F S : New",
        "Hercules Capital, Inc. Common Stock S 01/12/2026 02/01/2026 $50,001 -",
        "(HTGC) [ST] $100,000",
        "F S : New",
        "Wheaton Precious Metals Corp S (partial) 05/05/2026 05/08/2026 $15,001 -",
        "Common Shares (WPM) [ST] $50,000",
        "F S : New",
        "SP US TSY BOND DUE 02/15/36 [GS] P 02/18/2026 03/06/2026 $15,001 -",
        "$50,000",
        "F S : New",
    ])
    rows, markers = house_parse.parse_text(text)
    assert markers == 4 and len(rows) == 4, (markers, len(rows))
    hd, htgc, wpm, tsy = rows
    assert (hd["ticker"], hd["owner"], hd["side"], hd["amountLo"], hd["amountHi"]) == ("HD", "joint", "sell", 15001.0, 50000.0)
    assert (htgc["ticker"], htgc["amountHi"], htgc["tradeDate"]) == ("HTGC", 100000.0, "2026-01-12")
    assert (wpm["ticker"], wpm["side"]) == ("WPM", "sell")
    assert tsy["tag"] == "GS" and tsy["owner"] == "spouse"  # a government bond: kept out of the equity feed by tag


def test_parser_ignores_parenthetical_words_that_are_not_tickers():
    rows, _ = house_parse.parse_text("Williams Companies, Inc. (The) Common Stock (WMB) [ST] P 03/01/2026 03/02/2026 $1,001 - $15,000\nF S : New")
    assert rows[0]["ticker"] == "WMB"


def _series(closes):
    days = [f"2026-01-{i + 1:02d}" for i in range(len(closes))]
    return enrich.Series({"days": days, "adj": closes, "close": closes})


def test_verdict_priced_in_and_direction():
    # 70 flat-ish days then a +10% run; SPY flat. A member who BOUGHT before the run: their side already won.
    base = [100 + (0.2 if i % 2 else -0.2) for i in range(70)]
    run = [100 * (1 + 0.02 * k) for k in range(1, 6)]
    s, spy = _series(base + run), _series([100.0] * 75)
    row = {"instrument": "stock", "ticker": "XYZ", "side": "buy", "tradeDate": s.days[69], "filedDate": s.days[72]}
    a = enrich.assess(row, s, spy)
    assert a["verdict"] == "PRICED_IN" and a["rTotal"] > 0.09, a
    row["side"] = "sell"  # same prices, opposite direction: the member's move went the wrong way
    assert enrich.assess(row, s, spy)["verdict"] == "REVERSED"


def test_verdict_open_when_flat_and_guards():
    s, spy = _series([100.0 + (0.1 if i % 2 else 0) for i in range(80)]), _series([100.0] * 80)
    row = {"instrument": "stock", "ticker": "XYZ", "side": "buy", "tradeDate": s.days[70], "filedDate": s.days[75]}
    assert enrich.assess(row, s, spy)["verdict"] == "OPEN"
    assert enrich.assess(dict(row, instrument="option"), s, spy)["verdict"] == "UNCLEAR"
    assert enrich.assess(dict(row, tradeDate=s.days[77], filedDate=s.days[75]), s, spy)["verdict"] == "INVALID"


def test_excess_is_relative_to_spy():
    s = _series([100.0] * 60 + [110.0] * 10)
    spy = _series([100.0] * 60 + [110.0] * 10)  # the market rose just as much: no excess move
    row = {"instrument": "stock", "ticker": "XYZ", "side": "buy", "tradeDate": s.days[59], "filedDate": s.days[62]}
    a = enrich.assess(row, s, spy)
    assert math.isclose(a["rTotal"], 0.0, abs_tol=1e-9) and a["verdict"] == "OPEN", a


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok  ", name)
            except AssertionError as e:
                fails += 1
                print("FAIL", name, e)
    sys.exit(1 if fails else 0)
