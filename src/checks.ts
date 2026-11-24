/**
 * Deterministic checks the engine runs on drafts before the Critic's model review.
 *
 * Sample-size guard: in a section that needs a sample size, on a team that has the sample-size
 * calculator, every participant count the draft states must be a number the calculator produced in
 * this run (per group or total, ± 1). Small models like to invent a plausible "n = 400"; this
 * catches that without a model call.
 *
 * No imports, so Node can load this file directly (scripts/checks-test.mjs).
 */

/** The `why` of the automatic review span (the UI and scripts/run-test.mjs recognise it by this text). */
export const SAMPLE_SIZE_CHECK_WHY = "Automatic check: sample size not computed by the calculator";

/** Numbers below this are never read as participant counts (keeps α 0.05, power 0.8, "2 groups" out). */
const MIN_COUNT = 5;

// A number: 1,922 · 1922 · 960.2 — not part of a longer number, not a percentage.
const NUM = String.raw`(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\d,]*\s*(?:%|percent))`;
const GROUP = String.raw`(?:group|arm|condition|variant|cohort|cell|treatment)s?`;
const QUALIFIER = String.raw`(?:about|approximately|approx\.?|around|roughly|at least|~|≈|≥|>=)?\s*`;
// "users", "new users", "eligible participants"… — only people words may sit between the number and
// "per group", so "14 days per variant" is not read as a sample size.
const PEOPLE = String.raw`(?:(?:new|active|adult|unique|eligible|additional|enrolled)\s+)?(?:users|participants|people|subjects|respondents|customers|accounts|members|students|patients)`;

/** Patterns that put a number next to a sample-size word. Each has exactly one capture group: the number. */
const PATTERNS: RegExp[] = [
  // n = 961 · N=1,922 · n ≥ 400
  new RegExp(String.raw`(?<![A-Za-z])n\s*(?:=|:|≈|~|≥|>=)\s*` + QUALIFIER + NUM, "gi"),
  // 961 per group · 961 users per arm · 961 participants in each group
  new RegExp(NUM + String.raw`\s+(?:` + PEOPLE + String.raw`\s+)?(?:per|in each|for each|each)\s+` + GROUP, "gi"),
  // per group: 961 · per arm = 961 · each group of 961
  new RegExp(String.raw`(?:per|each)\s+` + GROUP + String.raw`\s*(?:of|:|=|≈|~|is|will be)?\s*` + QUALIFIER + NUM, "gi"),
  // 1,922 participants · 400 adult participants · 300 respondents
  new RegExp(NUM + String.raw`\s+(?:(?:new|active|adult|unique|eligible|additional|enrolled|total)\s+)?(?:participants|subjects|respondents)\b`, "gi"),
  // participants: 400 · participants (n = 400) is caught by the first pattern
  new RegExp(String.raw`(?:participants|subjects|respondents)\s*(?::|=)\s*` + QUALIFIER + NUM, "gi"),
  // 1,922 total · 1,922 users in total
  new RegExp(NUM + String.raw`\s+(?:(?:users|people|participants|subjects|respondents)\s+)?(?:in\s+)?total\b`, "gi"),
  // sample size of 961 · sample size: 961 · sample size is approximately 1,000 · sample size (per group) 961
  new RegExp(String.raw`sample[\s-]+size\b[^0-9\n;.]{0,40}?` + NUM, "gi")
];

const toNumber = (s: string) => Number(s.replace(/,/g, ""));

/**
 * Participant counts / sample sizes stated in `text`, in order of first appearance, without
 * duplicates. Only numbers next to sample-size wording count ("961 per group", "n = 400",
 * "1,922 participants", "sample size of 500"); percentages and numbers below 5 are ignored.
 */
export function findSampleSizeClaims(text: string): number[] {
  const found: { at: number; n: number }[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const n = toNumber(m[1]);
      if (Number.isFinite(n) && n >= MIN_COUNT) found.push({ at: m.index + m[0].lastIndexOf(m[1]), n });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  const seen = new Set<number>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.n)
    .filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

/** A calculator result as the check needs it. */
export type ComputedSampleSize = { perGroup: number; total: number };

/**
 * The claims in `text` that match no calculator result (per group or total, within ± `tolerance`).
 * Empty = nothing to object to.
 */
export function unverifiedSampleSizes(text: string, results: ComputedSampleSize[], tolerance = 1): number[] {
  return findSampleSizeClaims(text).filter(
    (n) => !results.some((r) => Math.abs(n - r.perGroup) <= tolerance || Math.abs(n - r.total) <= tolerance)
  );
}

/** The note the automatic check sends back to the section owner. */
export function sampleSizeCheckNote(claims: number[], results: ComputedSampleSize[]): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const stated = claims.map(fmt).join(", ");
  const use = results.length
    ? `Use the calculator's result (${results.map((r) => `${fmt(r.perGroup)} per group, ${fmt(r.total)} total`).join("; or ")})`
    : "No sample size was computed by the calculator in this run, so state how the sample size will be determined";
  return `The draft states a sample size (${stated}) that was not computed by the sample-size calculator. ${use}, or remove the number.`;
}
