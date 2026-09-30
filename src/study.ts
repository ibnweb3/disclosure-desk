/** Pure functions for the weekend study: no imports, so they can be unit-tested outside the Workers runtime. */

export interface Snap {
  t: number; // epoch ms
  st: string; // market state when taken
  mock?: boolean;
  q: Record<string, [number, number, number | null, number | null]>; // ticker -> [equity last, rToken last, bid, ask]
}

const ET = "America/New_York";
const etParts = (t: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { date: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, mins: Number(p.hour) * 60 + Number(p.minute) };
};

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function corr(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 5) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function computeStudy(snaps: Snap[], includeMock: boolean) {
  snaps = snaps.filter((s) => includeMock || !s.mock).sort((a, b) => a.t - b.t);
  const view = snaps.map((s) => ({ ...s, ...etParts(s.t) }));

  // baseline: how tightly do rTokens track their stocks when both are trading vs when only the rToken is?
  const gaps = (state: (s: string) => boolean) =>
    view.filter((s) => state(s.st)).flatMap((s) => Object.values(s.q).map(([eq, rt]) => Math.abs(rt / eq - 1) * 1e4));
  const spreads = (state: (s: string) => boolean) =>
    view.filter((s) => state(s.st)).flatMap((s) => Object.values(s.q).flatMap(([, , b, a]) => (b && a ? [((a - b) / ((a + b) / 2)) * 1e4] : [])));
  const baseline = {
    open: { samples: gaps((s) => s === "open").length, medianAbsGapBps: median(gaps((s) => s === "open")), medianSpreadBps: median(spreads((s) => s === "open")) },
    closed: { samples: gaps((s) => s !== "open").length, medianAbsGapBps: median(gaps((s) => s !== "open")), medianSpreadBps: median(spreads((s) => s !== "open")) },
  };

  // weekends: last Friday session -> Monday open
  const fridays = [...new Set(view.filter((s) => s.wd === "Fri").map((s) => s.date))];
  const weekends = [];
  for (const fri of fridays) {
    const friSnaps = view.filter((s) => s.date === fri);
    const friClose = [...friSnaps].reverse().find((s) => s.mins >= 16 * 60 + 5); // after the 16:00 ET close
    const fd = new Date(fri + "T12:00:00Z");
    fd.setUTCDate(fd.getUTCDate() + 3);
    const mon = fd.toISOString().slice(0, 10);
    const monSnaps = view.filter((s) => s.date === mon);
    const preOpen = [...monSnaps].reverse().find((s) => s.mins < 9 * 60 + 25);
    const early = monSnaps.find((s) => s.st === "open" && s.mins >= 9 * 60 + 45);
    if (!friClose || !preOpen || !early) continue;
    const pairs = [];
    for (const t of Object.keys(friClose.q)) {
      const a = friClose.q[t], b = preOpen.q[t], c = early.q[t];
      if (!a || !b || !c) continue;
      pairs.push({ t, weekendGap: b[1] / a[0] - 1, mondayMove: c[0] / a[0] - 1 });
    }
    if (pairs.length < 3) continue;
    const g = pairs.map((p) => p.weekendGap), m = pairs.map((p) => p.mondayMove);
    const big = pairs.filter((p) => Math.abs(p.weekendGap) >= 0.002);
    weekends.push({
      friday: fri, monday: mon, n: pairs.length,
      correlation: corr(g, m),
      signAgreementPct: big.length ? (100 * big.filter((p) => Math.sign(p.weekendGap) === Math.sign(p.mondayMove)).length) / big.length : null,
      signAgreementN: big.length,
      meanAbsWeekendGapPct: (100 * g.reduce((a, b) => a + Math.abs(b), 0)) / g.length,
      meanAbsMondayMovePct: (100 * m.reduce((a, b) => a + Math.abs(b), 0)) / m.length,
      pairs: pairs.sort((x, y) => Math.abs(y.weekendGap) - Math.abs(x.weekendGap)),
    });
  }
  return {
    snapshots: snaps.length, first: snaps[0]?.t ?? null, last: snaps[snaps.length - 1]?.t ?? null, mock: includeMock,
    baseline, weekends,
    note: "Monday move = equity price ~15 minutes after the open vs the Friday close; weekend gap = last pre-open rToken price vs the Friday close. Small samples; read as observed, not proven.",
  };
}
