# Disclosure Desk

**A 24/7 research desk for US Congress trade disclosures, tied to Bitget rTokens.**
It reads every House PDF and Senate report, tells you what the market has *already* done since each trade, and, when US stocks are closed, shows where the disclosed names are trading right now as rTokens and drafts a paper-trading ticket. A human makes the call.

> Bitget AI Hackathon S2 · Track: **AI Trading Desk** · Sub-theme: *Information Extraction & Signal Generation*
> **Live demo (no login): https://disclosure-desk.ibnweb3lab.workers.dev** · Proof page: [/#proof](https://disclosure-desk.ibnweb3lab.workers.dev/#proof) · Method: [/#method](https://disclosure-desk.ibnweb3lab.workers.dev/#method)

## The idea in 10 seconds

Congress files late (median **30 days** after the trade), and a follower who acts on a filing arrives after the move. We measured whether following disclosures pays: **it doesn't, reliably** (see [Proof](#what-the-data-say)). So this is not a signal seller. It is an honest desk that answers three questions a Congress-follower actually has:

1. **What did they trade, and is it already priced in?** Per-trade accounting versus SPY, in units of the stock's own noise.
2. **Is there context?** Multiple members on the same name, a committee that oversees the company's sector, a filing past the 45-day STOCK Act limit.
3. **What can I do about it right now?** Congress files at any hour; stocks reprice only at the open. Bitget rTokens trade continuously, so when equities are closed the desk ranks the disclosed names by how far their rToken has already moved from the last equity close, then builds a **paper-trading ticket** (`bgc --paper-trading … --dry-run`) behind a deterministic risk gate.

## What's in the box

| Piece | What it does |
|---|---|
| `pipeline/` (Python) | House Clerk PDFs → rows (99.7 % of declared transaction rows parsed); Senate reports via a public mirror; Yahoo prices; sectors; members and committees; verdicts; validation study |
| `src/` (Cloudflare Worker, TypeScript) | Live rToken quotes and the 2,800-token rToken universe (via Bitget's official agent MCP), market session, the natural-language desk, a 15-minute cron that records rToken-vs-equity snapshots |
| `public/` (static, no build step) | The desk: feed, filters, per-trade chart, 24/7 panel, ticket, Proof and Method tabs |

### The verdict (deterministic, no LLM)

For a trade in direction *d* on *t₀*, disclosed *t₁*, with `excess` = stock return − SPY return:

- `missed = d × excess(t₀ → now)`; `z = missed / (σ·√h)` with σ the stock's own 60-day pre-trade daily excess-return noise and *h* the trading days elapsed.
- **Priced in** if z ≥ 1 and missed ≥ 1 %; **Reversed** if z ≤ −1 and missed ≤ −1 %; else **Open**.
- Options are **Unclear** (the filing doesn't say call or put); trades dated after their own filing are flagged as typos (we found one: a House filing dated 12/26/2026 inside a report filed 2/9/2026).

### The role of the language model (Qwen)

1. **Planner**: turns a question into a JSON filter (tickers, members, party, state, sector, verdict, side, window, sort). A keyword planner takes over if the model is unavailable or its filter finds nothing.
2. **Summary writer**: two sentences about the matched rows. **Code rejects the text** if it contains a number that is not in the data, a count or number word, or a forecast or advice (`src/grounding.ts`, unit-tested), with one corrected retry. The cited rows underneath are rendered by code, so no figure in them is generated.

Default model `@cf/qwen/qwen3-30b-a3b-fp8` on Cloudflare Workers AI (fits the free daily allocation). Set `LLM_BASE_URL` + `LLM_API_KEY` (and `LLM_MODEL`) to use any OpenAI-compatible endpoint, e.g. the hackathon's Qwen credits.

## A complete research task (question → insight → action)

1. **Ask**: "Which disclosed stocks are gapping as rTokens right now?" The planner turns it into a filter (rToken-tradable, sort by gap); the desk pulls live Bitget quotes for the matching names and ranks them by distance from the last stock price.
2. **Read**: open one, e.g. Rep. Kevin Hern's sale of **HD**. He sold on Sep 14 near $310.87 and it was disclosed 11 days later (Sep 25, about $293.20). Versus SPY the stock moved **+8.6 % in his direction** (+7.3 % before the filing was public, +1.4 % since), which is **1.6σ** of HD's own typical noise over 12 trading days: **Priced in**. Someone copying today is paying for a move he already captured. The panel also shows the price chart with his trade, the disclosure, and today; the source filing is one click away.
3. **Act (or don't)**: the 24/7 panel shows `rHDUSDT` within a few basis points of the stock at a tight spread, and the ticket builds the paper-trading command with Bitget's own precision and minimums behind risk gates (one of them warns: "same side as the member, but their move is already priced in"). Nothing is sent; you paste it into Bitget's demo environment.

## What the data say

Computed by `pipeline/analysis.py` on every filing we hold (Senate 2023-26 via mirror, House 2026): each trade is assessed on the first close *after* its filing date (no look-ahead), observations are clustered by filing.

| | mean excess vs SPY | t (naive) | t (clustered) |
|---|---|---|---|
| Follow a disclosure, 5 trading days | +0.22 % | 2.96 | **0.67** |
| Follow a disclosure, 20 trading days | +0.18 % | 1.18 | **1.94** |
| Open − Priced in, 5 days | +0.18 pp | | 0.52 |
| Open − Priced in, 20 days | −0.39 pp | | −0.61 |

(5,462 trades from 563 filings.) No reliable edge, and the verdicts don't forecast either, so the desk labels them as *accounting of what a follower has missed*, never as predictions. The naive t-stat of 2.96 is the trap most trackers fall into: trades inside one filing move together.

The live **24/7 study** on the Proof tab tests whether a weekend rToken gap anticipates Monday's open; it fills in as real weekends are recorded.

## Run it

```bash
npm install
python -m pip install -r pipeline/requirements.txt

python pipeline/house_fetch.py 2026     # download House PTR PDFs (cached)
python pipeline/analysis.py             # build public/data/* (feed, charts, meta) + proof.json
npm test                                # 5 pipeline tests + weekend-study test
npm run dev                             # http://localhost:8787 (mock rTokens; no Cloudflare account touched)
```

`npm run dev` uses `wrangler.dev.jsonc`: no AI binding, and **MOCK rToken data** because some networks cannot resolve Bitget's API host. The UI labels mock data loudly; production never sets `MOCK_RTOKENS`.

### Deploy

```bash
npx wrangler deploy        # static assets + Worker + cron + KV (id auto-provisioned)
```

`.github/workflows/refresh.yml` rebuilds the data every 6 hours and commits it (and redeploys if a `CLOUDFLARE_API_TOKEN` secret exists). It refuses to overwrite published data with a throttled or partial run.

## Data sources and use

- **House**: [Clerk's official disclosure index and PDFs](https://disclosures-clerk.house.gov/FinancialDisclosure).
- **Senate**: efdsearch.senate.gov blocks datacenter IPs, so rows come from a public GitHub Actions mirror ([matr-co/senate-ptr](https://github.com/matr-co/senate-ptr)); every row links back to its eFD filing.
- **Prices / sectors**: Yahoo Finance chart and search endpoints. **Members / committees**: [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators). **rTokens**: Bitget's official agent MCP (`agent.bitget.com/mcp`: `crypto_market` for the rToken universe and each pair's precision and minimum order, `crypto_spot_ticker` for live bid/ask). Bitget's REST hosts answer Cloudflare Workers with a 403, so the MCP, the endpoint Bitget publishes for AI agents, is the route that works from a Worker.
- Disclosure reports may not be used for commercial purposes (5 U.S.C. §13107(c)). This is a non-commercial research demo and not investment advice.

## Known limitations (we'd rather you read them here)

- **Scanned filings are not read yet**: 47 of 403 House filings and 59 of 544 Senate reports are images with no text layer.
- The committee-overlap flag uses a coarse committee→sector map: context, not an accusation.
- The study samples are small and prices exist only for currently listed tickers (survivorship bias); no trading costs are modelled.
- The desk never holds keys and never places orders; tickets are for Bitget's demo environment via the official `bgc` CLI.

MIT licensed.
