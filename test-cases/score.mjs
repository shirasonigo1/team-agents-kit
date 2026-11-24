#!/usr/bin/env node
// Apply the mechanical checks of a case (checks.json, mirroring expected.md) to a saved result.
//
//   node test-cases/score.mjs <case-folder> [results-dir]
//
// results-dir defaults to the newest folder in <case-folder>/results/. It reads state.json
// (the final RunState) and document.md if present. Prints pass/fail per check and exits 1 if a
// "must" check fails. These checks are keyword heuristics: they catch obvious misses, not quality.
// Read expected.md for the full rubric and judge the rest by hand.
//
// checks.json: { "allowNames": [..], "checks": [ { id, label, level: "must"|"should", where, ... } ] }
//   where: "section:<id>" (that section's bullets) | "open" (Open questions) | "document" (everything) | "spans"
//   any: [regex]        at least one matches (case-insensitive)
//   all: [regex]        every one matches
//   none: [regex]       none may match (hallucination guards)
//   minBullets: n       the section has at least n bullets
//   sources: [name]     the section's sources include at least one of these files
//   readAllFiles: true  (where "spans") every attached file has a "Read <file>" tool span
//   toolSpan: regex     (where "spans") some tool span's action matches
//   noPersonNames: true capitalised "First Last" pairs must be in allowNames or contain a [PLACEHOLDER]

import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const [caseArg, resArg] = process.argv.slice(2);
if (!caseArg) {
  console.error("usage: node test-cases/score.mjs <case-folder> [results-dir]");
  process.exit(2);
}
const caseDir = resolve(caseArg);
let resDir = resArg ? resolve(resArg) : null;
if (!resDir) {
  const all = (await readdir(join(caseDir, "results")).catch(() => [])).sort();
  if (!all.length) { console.error(`No results in ${join(caseDir, "results")}`); process.exit(2); }
  resDir = join(caseDir, "results", all.at(-1));
}
const spec = JSON.parse(await readFile(join(caseDir, "checks.json"), "utf8"));
const state = JSON.parse(await readFile(join(resDir, "state.json"), "utf8"));
const docMd = await readFile(join(resDir, "document.md"), "utf8").catch(() => "");

const sec = (id) => state.sections.find((s) => s.id === id);
const sectionText = (id) => (sec(id)?.content ?? []).join("\n");
const openText = () => [sectionText("open"), ...(state.openQuestions ?? []).map((q) => q.question)].join("\n");
const documentText = () => docMd || [state.brief ? Object.values(state.brief).join("\n") : "", ...state.sections.map((s) => s.content.join("\n")), openText()].join("\n");
const re = (p) => new RegExp(p, "i");
// Words that make a capitalised pair a role, team, place or thing rather than a person's name.
const STOP = new Set(("product lead head engineer engineers engineering manager designer design customer customers success sales " +
  "security platform team mobile backend frontend research researcher data analyst ethics reviewer review board methods " +
  "specialist principal investigator owner owners operations director qa quality assurance support beta pilot release " +
  "offline mode app apps store sync service services mdm it legal finance marketing growth committee pricing plan plans " +
  "the a an and of for to with by on in at is are be will all each per new first second week weeks month months day days " +
  "january february march april may june july august september october november december q1 q2 monday tuesday wednesday " +
  "thursday friday saturday sunday milestone milestones phase risk risks dependency dependencies goal scope timeline open " +
  "questions question hypothesis variables method sample controls measurements analysis primary secondary control treatment " +
  "group groups ios android web user users inspector inspectors account accounts").split(/\s+/));

const results = [];
for (const ch of spec.checks) {
  const [kind, id] = ch.where.split(":");
  const text = kind === "section" ? sectionText(id) : kind === "open" ? openText() : kind === "document" ? documentText() : "";
  const why = [];
  let ok = true;
  if (kind === "section" && !sec(id)) { ok = false; why.push(`no section "${id}"`); }
  if (ch.any && !ch.any.some((p) => re(p).test(text))) { ok = false; why.push(`none of ${ch.any.join(" | ")}`); }
  if (ch.all) for (const p of ch.all) if (!re(p).test(text)) { ok = false; why.push(`missing ${p}`); }
  if (ch.none) for (const p of ch.none) { const m = text.match(re(p)); if (m) { ok = false; why.push(`found "${m[0]}"`); } }
  if (ch.minBullets && (sec(id)?.content.length ?? 0) < ch.minBullets) { ok = false; why.push(`${sec(id)?.content.length ?? 0} bullets < ${ch.minBullets}`); }
  if (ch.sources) {
    const srcs = sec(id)?.sources ?? [];
    if (!srcs.some((s) => ch.sources.some((f) => s.startsWith(f)))) { ok = false; why.push(`sources: ${srcs.join("; ") || "none"}`); }
  }
  if (ch.readAllFiles) {
    const missing = (state.files ?? []).filter((f) => !state.spans.some((sp) => sp.kind === "tool" && sp.action === `Read ${f.name}`));
    if (!state.files?.length) { ok = false; why.push("run has no files"); }
    if (missing.length) { ok = false; why.push(`no Read span for ${missing.map((f) => f.name).join(", ")}`); }
  }
  if (ch.toolSpan && !state.spans.some((sp) => sp.kind === "tool" && re(ch.toolSpan).test(sp.action))) { ok = false; why.push(`no tool span matching ${ch.toolSpan}`); }
  if (ch.noPersonNames) {
    const allow = new Set((spec.allowNames ?? []).map((s) => s.toLowerCase()));
    const bad = [];
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/\b([A-Z][a-z]+) (?=([A-Z][a-z]+)\b)/g)) {
        m[0] = `${m[1]} ${m[2]}`;
        const pair = m[0].toLowerCase();
        if ([...allow].some((a) => pair.includes(a) || a.includes(pair))) continue;
        if (STOP.has(m[1].toLowerCase()) || STOP.has(m[2].toLowerCase())) continue;
        if (/\[[^\]]+\]/.test(line) && line.indexOf(m[0]) > line.indexOf("[")) continue;
        bad.push(m[0]);
      }
    }
    if (bad.length) { ok = false; why.push(`possible invented names: ${[...new Set(bad)].join(", ")}`); }
  }
  results.push({ ...ch, ok, why });
}

console.log(`Scoring ${state.runId ?? "?"} (${state.status}) from ${resDir}\n`);
for (const r of results) console.log(`  ${r.ok ? "pass" : "FAIL"} [${r.level}] ${r.id}: ${r.label}${r.ok ? "" : `  — ${r.why.join("; ")}`}`);
const must = results.filter((r) => r.level === "must");
const should = results.filter((r) => r.level !== "must");
const mp = must.filter((r) => r.ok).length, sp = should.filter((r) => r.ok).length;
console.log(`\nMust: ${mp}/${must.length} · Should: ${sp}/${should.length} · Total: ${mp + sp}/${results.length}`);
console.log("Mechanical checks only — finish the manual items in expected.md.");
process.exit(mp === must.length ? 0 : 1);
