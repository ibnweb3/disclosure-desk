// Run: node test/grounding.test.mjs
import assert from "node:assert/strict";
import { summaryIsGrounded } from "../src/grounding.ts";

const payload = [
  { id: "H-20035491-0", verdict: "PRICED_IN", missedSinceTrade: "+8.6%", traded: "2026-09-14", filed: "2026-09-25", size: "$15K-$50K", rtoken: { price: 287.13, vsLastEquityClose: "-1.32%", spreadBps: 4 } },
  { id: "S-0632f542-0", verdict: "OPEN", missedSinceTrade: "+0.0%", traded: "2026-08-27", filed: "2026-09-11", size: "$1K-$15K", rtoken: null },
];

// grounded: every number is in the data (or a count of the rows, or a known rule constant)
assert.ok(summaryIsGrounded("One name is priced in (+8.6% since the trade), the other is still open. The rToken sits -1.32% from the stock.", payload, 2));
assert.ok(summaryIsGrounded("Disclosures arrive about 30 days late; this one was filed on 2026-09-25.", payload, 2));

// an invented or rounded number is rejected
assert.equal(summaryIsGrounded("The stock already moved +9% in the member's favour.", payload, 2), false, "8.6 rounded to 9 must fail");
assert.equal(summaryIsGrounded("About 12.4% of the move is left.", payload, 2), false, "invented figure must fail");
assert.equal(summaryIsGrounded("A $500K position.", payload, 2), false);

// forecasts and advice are rejected even when numbers are fine
assert.equal(summaryIsGrounded("It is +8.6% priced in, so you should sell.", payload, 2), false);
assert.equal(summaryIsGrounded("NVDA will rise after this. +8.6%.", payload, 2), false);
assert.equal(summaryIsGrounded("I recommend waiting. +8.6%.", payload, 2), false);

// number words are counts the model can miscount: rejected (a lone "one" is fine)
assert.equal(summaryIsGrounded("Three of them are already priced in.", payload, 2), false);
assert.equal(summaryIsGrounded("A dozen names moved.", payload, 2), false);
assert.ok(summaryIsGrounded("One name is priced in, the rest are open.", payload, 2));

// guesses about motive or interest are rejected (the live Qwen once wrote exactly this)
assert.equal(summaryIsGrounded("John Boozman bought three stocks, all with open verdicts. These trades remain unfulfilled, showing potential interest.", payload, 2), false);
assert.equal(summaryIsGrounded("The purchase suggests a bullish view.", payload, 2), false);
assert.equal(summaryIsGrounded("A good opportunity given the +8.6% move.", payload, 2), false);
assert.equal(summaryIsGrounded("It was an insider-style trade.", payload, 2), false);

// internal keys and the old "open verdict" wording must not reach users
assert.equal(summaryIsGrounded("This one is PRICED_IN at +8.6%.", payload, 2), false);
assert.equal(summaryIsGrounded("Most have open verdicts.", payload, 2), false);

// plain labels are fine
assert.ok(summaryIsGrounded("Most of these are Still early; one is Too late (+8.6% since the trade).", payload, 2));
assert.ok(summaryIsGrounded("The rToken sits -1.32% from the stock, so the market is already pricing it ahead of the open.", payload, 2));

// text with no numbers at all is fine
assert.ok(summaryIsGrounded("One name is already priced in and the other is still open.", payload, 2));
console.log("ok grounding.test.mjs");
