/**
 * The sample-size calculator (the `sample_size` tool, Data analyst only). Pure, deterministic code (no model call):
 * the model asks for it with a SampleSizeRequest and the engine records the result as a "tool" span.
 *
 * Two-sided tests, normal approximation, equal group sizes:
 *   two proportions:  n per group = (z₁₋α/₂ + z₁₋β)² · (p1(1−p1) + p2(1−p2)) / (p1 − p2)²
 *   two means:        n per group = (z₁₋α/₂ + z₁₋β)² · 2 / d²            (d = Cohen's d)
 * rounded up. Defaults: α = 0.05, power = 0.8.
 *
 * Reference values (checked in scripts/sample-size-check.mjs):
 *   z(0.975) = 1.959964, z(0.80) = 0.841621, (sum)² = 7.848879
 *   p1 0.30 vs p2 0.36 → 960.2 → 961 per group (1922 total)
 *   d 0.5 → 62.8 → 63 per group (the classic normal-approximation table value; a t-test gives 64)
 * Only `import type` here, so Node can load this file directly (type stripping) for the check script.
 */
import type { SampleSizeRequest, SampleSizeResult } from "./contract";

/** Accepted parameter ranges (outside them the calculator returns an error instead of a number). */
export const SAMPLE_SIZE_LIMITS = {
  alpha: [0.001, 0.2] as const,
  power: [0.5, 0.99] as const,
  effectSize: [0.01, 5] as const,
  maxPerGroup: 10_000_000
};

/** Inverse standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const fmt = (x: number, n = 3) => Number(x.toFixed(n)).toString();
const inRange = (x: unknown, [lo, hi]: readonly [number, number]) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;

const pct = (p: unknown) => (typeof p === "number" ? `${Number((p * 100).toFixed(2))}%` : String(p));

/** Short label for a request, e.g. "two proportions, 30% vs 36%, α 0.05, power 0.8". */
export function describeRequest(r: SampleSizeRequest): string {
  const tail = `α ${r.alpha ?? 0.05}, power ${r.power ?? 0.8}`;
  return r.test === "two_proportions" ? `two proportions, ${pct(r.p1)} vs ${pct(r.p2)}, ${tail}` : `two means, d = ${(r as { effectSize?: unknown }).effectSize}, ${tail}`;
}

/** Validates a request and returns the result, or `{ error }` (never throws). */
export function sampleSize(r: SampleSizeRequest): SampleSizeResult | { error: string } {
  if (!r || typeof r !== "object") return { error: "request must be an object" };
  const alpha = r.alpha ?? 0.05;
  const power = r.power ?? 0.8;
  if (!inRange(alpha, SAMPLE_SIZE_LIMITS.alpha)) return { error: `alpha must be a number from ${SAMPLE_SIZE_LIMITS.alpha[0]} to ${SAMPLE_SIZE_LIMITS.alpha[1]}` };
  if (!inRange(power, SAMPLE_SIZE_LIMITS.power)) return { error: `power must be a number from ${SAMPLE_SIZE_LIMITS.power[0]} to ${SAMPLE_SIZE_LIMITS.power[1]}` };
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const z2 = (za + zb) ** 2;
  let raw: number;
  let formula: string;
  if (r.test === "two_proportions") {
    const { p1, p2 } = r;
    const open = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0 && x < 1;
    if (!open(p1) || !open(p2)) return { error: "p1 and p2 must be proportions strictly between 0 and 1" };
    if (p1 === p2) return { error: "p1 and p2 must differ (no effect to detect)" };
    const v = p1 * (1 - p1) + p2 * (1 - p2);
    const diff2 = (p1 - p2) ** 2;
    raw = (z2 * v) / diff2;
    formula = `(${fmt(za)} + ${fmt(zb)})² · (${p1}·${fmt(1 - p1, 4)} + ${p2}·${fmt(1 - p2, 4)}) / (${p1} − ${p2})² = ${fmt(z2, 4)} · ${fmt(v, 4)} / ${fmt(diff2, 6)}`;
  } else if (r.test === "two_means") {
    const d = r.effectSize;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return { error: "effectSize (Cohen's d) must be greater than 0" };
    if (!inRange(d, SAMPLE_SIZE_LIMITS.effectSize)) return { error: `effectSize (Cohen's d) must be from ${SAMPLE_SIZE_LIMITS.effectSize[0]} to ${SAMPLE_SIZE_LIMITS.effectSize[1]}` };
    raw = (z2 * 2) / (d * d);
    formula = `(${fmt(za)} + ${fmt(zb)})² · 2 / ${d}² = ${fmt(z2, 4)} · 2 / ${fmt(d * d, 4)}`;
  } else {
    return { error: 'test must be "two_proportions" or "two_means"' };
  }
  // Guard against float noise just above an integer (e.g. 63.0000000001 → 63).
  const perGroup = Math.ceil(raw - 1e-9);
  if (perGroup > SAMPLE_SIZE_LIMITS.maxPerGroup) return { error: `effect too small: needs ${perGroup.toLocaleString("en-US")} per group` };
  const what = r.test === "two_proportions" ? "two-proportion" : "two-sample means";
  return {
    perGroup,
    total: perGroup * 2,
    alpha,
    power,
    explanation: `${what} test, two-sided, normal approximation: n per group = ${formula} = ${fmt(raw, 1)} → ${perGroup} per group, ${perGroup * 2} total.`
  };
}
