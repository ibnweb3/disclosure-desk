/** Pure checks that keep the language model honest. No imports, so it is unit-testable outside the Workers runtime. */

const numTokens = (s: string): string[] => (s.match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, ""));
const ALLOWED_CONSTANTS = new Set(["30", "45", "60", "24", "7", "1", "2", "3"]);
const SPECULATION = /\b(potential|opportunit(?:y|ies)|likely|unlikely|unfulfilled|suggest(?:s|ed|ing)?|signals?|intend(?:s|ed|ing)?|intent|interest(?:ed)?|bullish|bearish|conviction|insider|anticipat\w*|expect(?:s|ed|ing)?)\b/i;

/** A summary passes only if every number in it appears in the data it was given, and it makes no forecast or advice. */
export function summaryIsGrounded(text: string, payload: unknown, rowCount: number): boolean {
  const known = new Set(numTokens(JSON.stringify(payload)));
  for (const n of numTokens(text)) {
    if (known.has(n) || ALLOWED_CONSTANTS.has(n) || (/^\d+$/.test(n) && Number(n) <= rowCount)) continue;
    return false;
  }
  // number words are counts the model can get wrong and that digit-checking cannot see (a lone "one" is allowed)
  if (/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b/i.test(text)) return false;
  // the model must not guess at motives or dress the data up as a lead: the filings say what was traded, never why or what it hints at
  if (SPECULATION.test(text)) return false;
  // internal verdict keys and the old label "open verdict" must not leak into user-facing text (the UI says Still early / Too late / Went the other way)
  if (/\b(PRICED_IN|REVERSED|UNCLEAR|INVALID|OPEN)\b|\bopen verdicts?\b/.test(text)) return false;
  return !/\b(you should|i recommend|we recommend|should (buy|sell)|will (rise|fall|drop|jump|go up|go down|rally)|guaranteed|can't lose)\b/i.test(text);
}

