export interface AppEnv extends Env {
  /** dev only: synthesize rToken quotes when Bitget's API host is unreachable. Never set in production. */
  MOCK_RTOKENS?: string;
  /** optional OpenAI-compatible endpoint (e.g. the hackathon's Qwen credits); overrides Workers AI when set */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
}

export type Verdict = "OPEN" | "PRICED_IN" | "REVERSED" | "UNCLEAR" | "INVALID";

export interface Assessment {
  verdict: Verdict;
  why?: string;
  z?: number;
  h?: number;
  entry?: number;
  entryDay?: string;
  filedPx?: number;
  filedDay?: string;
  last?: number;
  lastDay?: string;
  rBefore?: number;
  rSince?: number;
  rTotal?: number;
  sigma?: number | null;
}

export interface Disclosure {
  id: string;
  chamber: "house" | "senate";
  member: string;
  party: string | null;
  state: string | null;
  matched: boolean;
  ticker: string;
  company: string;
  asset: string;
  sector: string | null;
  industry: string | null;
  etf: boolean;
  ageDays: number;
  stale: boolean;
  instrument: "stock" | "option";
  side: "buy" | "sell";
  owner: string | null;
  amountLo: number | null;
  amountHi: number | null;
  tradeDate: string;
  filedDate: string;
  lagDays: number;
  lots: number;
  flags: { late: boolean; cluster: number; overlap: string[] };
  a: Assessment;
  link: string;
}

export interface RToken {
  symbol: string; // e.g. rNVDAUSDT
  base: string; // NVDA
  last: number;
  bid: number | null;
  ask: number | null;
  chg24h: number | null; // ratio, 0.012 = +1.2%
  mid: number | null; // (bid + ask) / 2: the live reference price. `last` can lag the book badly on a thin token
  ts: number | null;
  pricePrec: number; // Bitget's price / quantity precision and minimums for this pair
  qtyPrec: number;
  minUsdt: number;
  minQty: number;
}

/** Every online Bitget rToken, keyed by underlying ticker, with its trading rules. */
export interface Universe {
  at: number;
  complete: boolean; // false when paging hit its cap or a page failed
  tokens: Record<string, { pp: number; qp: number; minUsdt: number; minQty: number }>;
}

export interface Equity {
  ticker: string;
  last: number;
  time: number | null; // epoch seconds of last regular-session print
}

export interface MarketState {
  state: "open" | "pre" | "post" | "closed";
  open: boolean;
  nextOpen: string; // ISO
  lastClose: string | null; // ISO of last regular-session end
  now: string;
}
