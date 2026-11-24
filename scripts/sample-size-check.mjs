#!/usr/bin/env node
// Unit checks for src/sample-size.ts (Node ≥ 23.6 loads the .ts file directly via type stripping).
//   node scripts/sample-size-check.mjs
// Reference values: z quantiles from standard normal tables; sample sizes from the formulas in
// src/sample-size.ts, cross-checked by hand (see the comments next to each case).
import { normInv, sampleSize } from "../src/sample-size.ts";

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("Inverse normal");
check(near(normInv(0.975), 1.959964, 1e-6), `z(0.975) = ${normInv(0.975).toFixed(6)} (table 1.959964)`);
check(near(normInv(0.8), 0.841621, 1e-6), `z(0.80) = ${normInv(0.8).toFixed(6)} (table 0.841621)`);
check(near(normInv(0.995), 2.575829, 1e-6), `z(0.995) = ${normInv(0.995).toFixed(6)} (table 2.575829)`);
check(near(normInv(0.9), 1.281552, 1e-6), `z(0.90) = ${normInv(0.9).toFixed(6)} (table 1.281552)`);
check(near(normInv(0.01), -2.326348, 1e-6), `z(0.01) = ${normInv(0.01).toFixed(6)} (table −2.326348)`);

console.log("Sample sizes");
const cases = [
  // (1.959964+0.841621)² = 7.848879; ·(0.21+0.2304)=0.4404 → 3.456646; /0.0036 = 960.18 → 961
  [{ test: "two_proportions", p1: 0.3, p2: 0.36 }, 961],
  // order doesn't matter
  [{ test: "two_proportions", p1: 0.36, p2: 0.3 }, 961],
  // 7.848879·(0.25+0.24)/0.01 = 384.6 → 385
  [{ test: "two_proportions", p1: 0.5, p2: 0.6 }, 385],
  // 7.848879·(0.09+0.16)/0.01 = 196.2 → 197
  [{ test: "two_proportions", p1: 0.1, p2: 0.2 }, 197],
  // d=0.5: 7.848879·2/0.25 = 62.79 → 63 (Cohen's table, normal approx.)
  [{ test: "two_means", effectSize: 0.5 }, 63],
  // d=0.2: 392.4 → 393; d=0.8: 24.5 → 25
  [{ test: "two_means", effectSize: 0.2 }, 393],
  [{ test: "two_means", effectSize: 0.8 }, 25],
  // α .05, power .9: (1.959964+1.281552)² = 10.5074; ·2/0.25 = 84.06 → 85
  [{ test: "two_means", effectSize: 0.5, power: 0.9 }, 85],
  // α .01, power .8: (2.575829+0.841621)² = 11.6790; ·2/0.25 = 93.43 → 94
  [{ test: "two_means", effectSize: 0.5, alpha: 0.01 }, 94]
];
for (const [req, want] of cases) {
  const r = sampleSize(req);
  check(r.perGroup === want && r.total === want * 2, `${JSON.stringify(req)} → ${r.perGroup ?? r.error} per group (expected ${want})`);
}
const r0 = sampleSize({ test: "two_proportions", p1: 0.3, p2: 0.36 });
check(r0.alpha === 0.05 && r0.power === 0.8, "defaults α 0.05, power 0.8");
console.log(`  explanation: ${r0.explanation}`);

console.log("Validation");
const bad = [
  { test: "two_proportions", p1: 0.3, p2: 0.3 },
  { test: "two_proportions", p1: 0, p2: 0.3 },
  { test: "two_proportions", p1: 30, p2: 36 },
  { test: "two_means", effectSize: 0 },
  { test: "two_means", effectSize: -0.5 },
  { test: "two_means", effectSize: 0.5, alpha: 0.5 },
  { test: "two_means", effectSize: 0.5, power: 1 },
  { test: "anova", effectSize: 0.5 }
];
for (const req of bad) {
  const r = sampleSize(req);
  check(typeof r.error === "string", `${JSON.stringify(req)} rejected: ${r.error}`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll sample-size checks passed");
process.exit(failed ? 1 : 0);
