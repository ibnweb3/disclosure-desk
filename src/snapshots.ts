import { loadData, quotesFor, rTokenList } from "./desk";
import { getUniverse, isMock } from "./market";
import { computeStudy } from "./study";
import type { Snap } from "./study";
import type { AppEnv, Disclosure } from "./types";

/**
 * The desk records its own evidence. Every 15 minutes a cron trigger stores, for the recently disclosed names
 * that have an rToken, [equity last, rToken last, bid, ask]. A full weekend of these lets the Proof page test
 * the 24/7 thesis on real data: does the rToken's weekend gap anticipate the Monday-open move?
 */

const dayKey = (t: number) => `d:${new Date(t).toISOString().slice(0, 10)}`;

export function snapshotTickers(data: Disclosure[], rt: Set<string>, max = 24): string[] {
  const seen = new Set<string>();
  for (const d of data) {
    if (d.stale || seen.has(d.ticker) || !rt.has(d.ticker)) continue;
    seen.add(d.ticker);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export async function takeSnapshot(env: AppEnv, ctx: ExecutionContext): Promise<{ stored: number }> {
  const data = await loadData(env, "https://assets.internal");
  if (!isMock(env)) await getUniverse(env).catch(() => null); // refreshes the rToken universe when it is over 6 hours old
  const rt = await rTokenList(env, ctx);
  const tickers = snapshotTickers(data, new Set(rt.tickers));
  if (!tickers.length) return { stored: 0 };
  const { quotes, market, mock } = await quotesFor(env, ctx, tickers);
  const q: Snap["q"] = {};
  for (const [t, v] of Object.entries(quotes)) {
    if (v.equity && v.rtoken) q[t] = [v.equity.last, v.rtoken.mid ?? v.rtoken.last, v.rtoken.bid, v.rtoken.ask];
  }
  if (!Object.keys(q).length) return { stored: 0 };
  const snap: Snap = { t: Date.now(), st: market.state, q };
  if (mock) snap.mock = true;
  const key = dayKey(snap.t);
  const day = ((await env.SNAPS.get(key, "json")) as Snap[] | null) ?? [];
  day.push(snap);
  await env.SNAPS.put(key, JSON.stringify(day), { expirationTtl: 60 * 86400 });
  return { stored: Object.keys(q).length };
}

export async function gapStudy(env: AppEnv, includeMock: boolean) {
  const list = await env.SNAPS.list({ prefix: "d:", limit: 60 });
  const snaps: Snap[] = [];
  for (const k of list.keys) snaps.push(...(((await env.SNAPS.get(k.name, "json")) as Snap[] | null) ?? []));
  return computeStudy(snaps, includeMock);
}
