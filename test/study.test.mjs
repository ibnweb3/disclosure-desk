// Run: node test/study.test.mjs   (Node >= 22.18 strips TypeScript types natively)
import assert from "node:assert/strict";
import { computeStudy } from "../src/study.ts";

const utc = (iso) => Date.parse(iso);
// Friday 2026-10-02 and Monday 2026-10-05 are in EDT (UTC-4).
const snap = (iso, st, q, extra = {}) => ({ t: utc(iso), st, q, ...extra });

// Ticker: [equity last, rToken last, bid, ask]
const friClose = snap("2026-10-02T20:10:00Z", "closed", { A: [100, 100.1, 100.05, 100.15], B: [50, 50, 49.95, 50.05], C: [200, 200, 199.9, 200.1], D: [10, 10, 9.99, 10.01], E: [80, 80, 79.9, 80.1] });
const monPre = snap("2026-10-05T13:15:00Z", "pre", { A: [100, 103, 102.9, 103.1], B: [50, 49, 48.9, 49.1], C: [200, 202, 201.9, 202.1], D: [10, 10, 9.99, 10.01], E: [80, 80.8, 80.7, 80.9] });
const monOpen = snap("2026-10-05T13:50:00Z", "open", { A: [102.5, 102.5, 102.4, 102.6], B: [49.4, 49.4, 49.3, 49.5], C: [201.2, 201.2, 201.1, 201.3], D: [10.02, 10.02, 10.01, 10.03], E: [80.5, 80.5, 80.4, 80.6] });
const midweek = snap("2026-09-30T15:00:00Z", "open", { A: [100, 100.1, 100.05, 100.15] });

const r = computeStudy([friClose, monPre, monOpen, midweek, snap("2026-10-06T15:00:00Z", "open", { A: [1, 1, 1, 1] }, { mock: true })], false);

assert.equal(r.snapshots, 4, "mock snapshots are excluded by default");
assert.equal(r.weekends.length, 1, "one Friday->Monday weekend found");
const w = r.weekends[0];
assert.equal(w.friday, "2026-10-02");
assert.equal(w.monday, "2026-10-05");
assert.equal(w.n, 5);
const a = w.pairs.find((p) => p.t === "A");
assert.ok(Math.abs(a.weekendGap - 0.03) < 1e-9, "A: rToken 103 vs Friday close 100 = +3%");
assert.ok(Math.abs(a.mondayMove - 0.025) < 1e-9, "A: Monday early price 102.5 vs 100 = +2.5%");
assert.equal(w.pairs[0].t, "A", "pairs sorted by absolute weekend gap");
// A, B, C, E moved the same way as their weekend gap (D's gap is 0 so it is excluded from sign agreement)
assert.equal(w.signAgreementN, 4);
assert.equal(w.signAgreementPct, 100);
assert.ok(w.correlation > 0.95, `correlation ${w.correlation}`);
// baseline: tracking gap while open vs while closed
assert.equal(r.baseline.open.samples, 6, "open snapshots: monOpen (5) + midweek (1)");
assert.ok(r.baseline.closed.medianAbsGapBps !== null);

// no complete weekend yet -> empty, not an error
assert.equal(computeStudy([midweek], false).weekends.length, 0);
console.log("ok study.test.mjs");
