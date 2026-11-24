#!/usr/bin/env node
// Unit tests for the pure helpers that need no server or model:
//   - src/checks.ts  the sample-size guard (findSampleSizeClaims, unverifiedSampleSizes, sampleSizeCheckNote)
//   - src/llm.ts     reading model replies (replyContent, replyUsage, jsonCandidates, coerceReply, modelRequest)
//
//   node scripts/checks-test.mjs        (or: npm run test:checks)
//
// Node ≥ 22.18 / 23.6 loads the .ts files directly (type stripping). Exits 1 if a check fails.
import { findSampleSizeClaims, unverifiedSampleSizes, sampleSizeCheckNote, SAMPLE_SIZE_CHECK_WHY } from "../src/checks.ts";
import { replyContent, replyUsage, jsonCandidates, coerceReply, coerceDraft, coerceReview, modelRequest } from "../src/llm.ts";
import { MODELS, modelInfo, DEFAULT_MODEL_ID } from "../src/contract.ts";

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("findSampleSizeClaims: numbers next to sample-size wording");
const claims = [
  ["Recruit 961 per group (1,922 total).", [961, 1922]],
  ["We need n = 400 users.", [400]],
  ["N=1,922 across both arms", [1922]],
  ["Target 500 users per arm, randomised 1:1", [500]],
  ["300 participants in each group", [300]],
  ["About 1,200 participants will be recruited", [1200]],
  ["Sample size of 961 per group", [961]],
  ["Sample size: approximately 2,000", [2000]],
  ["Per group: 385, from the calculator", [385]],
  ["per arm = 63", [63]],
  ["Participants: 250 new sign-ups", [250]],
  ["n ≥ 128 per condition", [128]],
  ["Enrol 80 eligible participants", [80]],
  ["n per group = 960.2 → 961", [960.2]],
  ["1,922 users in total", [1922]]
];
for (const [text, want] of claims) {
  const got = findSampleSizeClaims(text);
  check(same(got, want), `"${text}" → [${got}] (expected [${want}])`);
}

console.log("findSampleSizeClaims: no false positives");
const clean = [
  "Week-1 retention is about 30% (150 of 500 users in the cohort).",
  "Two-sided test, α 0.05, power 0.8, 2 groups.",
  "Run for 14 days per variant.",
  "Primary metric: week-1 retention; 7-day window.",
  "Baseline 30% vs target 36% retention.",
  "Sample size will be computed with the calculator before launch.",
  "The team has 4 engineers and 1 designer.",
  "Randomise 50% per group.",
  "Q1 2026 launch with 3 releases per quarter."
];
for (const text of clean) {
  const got = findSampleSizeClaims(text);
  check(got.length === 0, `"${text}" → [${got}]`);
}

console.log("unverifiedSampleSizes: ± 1 against the run's calculator results");
const results = [{ perGroup: 961, total: 1922 }];
check(same(unverifiedSampleSizes("961 per group, 1,922 total", results), []), "per group and total from the calculator → nothing to object to");
check(same(unverifiedSampleSizes("960 per group", results), []), "960 is within ± 1 of 961");
check(same(unverifiedSampleSizes("1,923 participants", results), []), "1,923 is within ± 1 of the total 1,922");
check(same(unverifiedSampleSizes("n = 1,000 per group", results), [1000]), "1,000 does not match → flagged");
check(same(unverifiedSampleSizes("400 participants", []), [400]), "no calculator result in the run → any stated count is flagged");
check(same(unverifiedSampleSizes("Retention 30% vs 36%", []), []), "no stated count → nothing flagged");
check(same(unverifiedSampleSizes("63 per group", [{ perGroup: 961, total: 1922 }, { perGroup: 63, total: 126 }]), []), "matches any result of the run");

console.log("sampleSizeCheckNote");
const note1 = sampleSizeCheckNote([1000], results);
check(note1.includes("1,000") && note1.includes("961 per group, 1,922 total") && /remove the number/.test(note1), `with a result: ${note1}`);
const note2 = sampleSizeCheckNote([400], []);
check(note2.includes("400") && /No sample size was computed/.test(note2) && /remove the number/.test(note2), `without a result: ${note2}`);
check(SAMPLE_SIZE_CHECK_WHY === "Automatic check: sample size not computed by the calculator", "SAMPLE_SIZE_CHECK_WHY text");

console.log("replyContent / replyUsage: every reply shape");
check(replyContent({ response: '{"a":1}' }) === '{"a":1}', "Workers AI { response: string }");
check(same(replyContent({ response: { a: 1 } }), { a: 1 }), "Workers AI { response: object } (JSON mode)");
check(replyContent({ choices: [{ message: { content: '{"a":1}', reasoning_content: "thinking {x}" } }] }) === '{"a":1}', "Chat Completions choices[0].message.content (reasoning ignored)");
check(replyContent({ choices: [{ message: { content: [{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }] } }] }) === '{"a":1}', "Chat Completions content parts");
check(replyContent({ output: [{ type: "reasoning", content: [{ text: "hmm {" }] }, { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }] }) === '{"a":1}', "Responses API output[] (reasoning item ignored)");
check(replyContent({ output_text: '{"a":1}' }) === '{"a":1}', "Responses API output_text");
check(same(replyUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { input: 10, output: 5 }), "usage prompt/completion_tokens");
check(same(replyUsage({ usage: { input_tokens: 7, output_tokens: 3 } }), { input: 7, output: 3 }), "usage input/output_tokens");
check(same(replyUsage({}), { input: 0, output: 0 }), "missing usage → 0");

console.log("jsonCandidates / coerceReply: JSON wrapped in reasoning or fences");
check(same(jsonCandidates('```json\n{"a":1}\n```'), [{ a: 1 }]), "code fence");
const reasoning = 'analysis: the user wants {bullets}. Let me think about {"draft": true} first.\nassistantfinal{"bullets":["One"],"why":"w","openQuestions":[]}';
check(same(coerceReply(reasoning, coerceDraft), { bullets: ["One"], why: "w", openQuestions: [] }), "gpt-oss style: reasoning text with braces, answer last");
check(same(coerceReply('<think>{"verdict":"maybe"}</think>{"verdict":"approved","note":"ok","why":"fine"}', coerceReview)?.verdict, "approved"), "<think> block dropped");
check(same(coerceReply('{"verdict":"approved","note":"a } b","why":"x"} trailing', coerceReview)?.note, "a } b"), "brace inside a JSON string");
check(coerceReply("no json here", coerceDraft) === null, "no JSON → null");
check(same(coerceReply({ bullets: ["x"], why: "", openQuestions: [] }, coerceDraft)?.bullets, ["x"]), "object reply used as is");

console.log("modelRequest: JSON mode per model");
const schema = { type: "object" };
const msgs = [{ role: "user", content: "hi" }];
const scout = modelRequest(modelInfo(DEFAULT_MODEL_ID), msgs, schema, true);
check(same(scout.response_format, { type: "json_schema", json_schema: schema }) && scout.max_tokens === 500, "default model: Workers AI json_schema, 500 tokens");
check(!("response_format" in modelRequest(modelInfo(DEFAULT_MODEL_ID), msgs, schema, false)), "retry attempt: no response_format");
const gemma = modelRequest(modelInfo("@cf/google/gemma-4-26b-a4b-it"), msgs, schema, true);
check(same(gemma.response_format, { type: "json_schema", json_schema: { name: "reply", schema } }) && gemma.chat_template_kwargs?.enable_thinking === false, "Gemma 4: OpenAI-style json_schema { name, schema }, thinking off");
check(!("response_format" in modelRequest(modelInfo("@cf/mistralai/mistral-small-3.1-24b-instruct"), msgs, schema, true)), "Mistral (jsonMode false): no response_format");
check(modelRequest(modelInfo("@cf/openai/gpt-oss-20b"), msgs, schema, true).max_tokens === 1500, "gpt-oss: room for reasoning (1500 tokens)");
check(modelInfo("@cf/no/such-model").id === DEFAULT_MODEL_ID && modelInfo(undefined).id === DEFAULT_MODEL_ID, "unknown or missing model id → default model");
check(new Set(MODELS.map((m) => m.id)).size === MODELS.length && MODELS.some((m) => m.id === DEFAULT_MODEL_ID), "MODELS ids are unique and include the default");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
