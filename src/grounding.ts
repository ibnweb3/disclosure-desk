/** Pure checks that keep the language model honest. No imports, so it is unit-testable outside the Workers runtime. */

const numTokens = (s: string): string[] => (s.match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, ""));
const ALLOWED_CONSTANTS = new Set(["30", "45", "60", "24", "7", "1", "2", "3"]);

/** A summary passes only if every number in it appears in the data it was given, and it makes no forecast or advice. */
export function summaryIsGrounded(text: string, payload: unknown, rowCount: number): boolean {
  const known = new Set(numTokens(JSON.stringify(payload)));
  for (const n of numTokens(text)) {
    if (known.has(n) || ALLOWED_CONSTANTS.has(n) || (/^\d+$/.test(n) && Number(n) <= rowCount)) continue;
    return false;
  }
  // number words are counts the model can get wrong and that digit-checking cannot see (a lone "one" is allowed)
  if (/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b/i.test(text)) return false;
  return !/\b(you should|i recommend|we recommend|should (buy|sell)|will (rise|fall|drop|jump|go up|go down|rally)|guaranteed|can't lose)\b/i.test(text);
}

