#!/usr/bin/env node
// Run one test case end to end against a running app (wrangler dev or a deployment).
//
//   node test-cases/run-case.mjs <case-folder> [baseUrl] [--dry-run] [--version n] [--timeout-min m]
//
//   <case-folder>   e.g. test-cases/01-product-offline-mode (must contain case.json)
//   baseUrl         default http://localhost:8788
//   --dry-run       only validate case.json and its files; no server is called
//   --version n     run with that saved version of the case's team (default: latest)
//   --timeout-min m give up waiting after m minutes (default 30)
//
// Flow: POST /api/files for each file → POST /api/runs { task, title, teamId, fileIds } →
// poll GET /agents/run-agent/<id> until awaiting_approval → POST …/approve → poll until
// completed / stopped / failed → save state.json, spans.json, document.md and summary.txt in
// <case-folder>/results/<timestamp>/, then score the result with score.mjs if checks.json exists.
// Auth: if ACCESS_PASSCODE is set, every request sends `Authorization: Bearer <passcode>`.
// Unlike scripts/run-test.mjs (engine consistency checks), this saves the result and scores the
// document's content against the case's checks.json; it has no dependencies on src/.

import { readFile, stat, mkdir, writeFile, access } from "node:fs/promises";
import { resolve, join, basename, extname, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED_EXT = new Set(["pdf", "docx", "xlsx", "csv", "txt", "md", "markdown", "html", "htm"]);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_TASK = 4000;
const TEAM_OUTPUT = { squad: "work-plan", "ux-research": "lab-experiment" };
const TERMINAL = ["completed", "stopped", "failed"];

const args = process.argv.slice(2);
const takeFlag = (name, hasValue = true) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = hasValue ? args[i + 1] : true;
  args.splice(i, hasValue ? 2 : 1);
  return v;
};
const dryRun = !!takeFlag("--dry-run", false);
const teamVersion = takeFlag("--version");
const timeoutMin = Number(takeFlag("--timeout-min") ?? 30);
const [caseArg, baseArg] = args;
if (!caseArg) {
  console.error("usage: node test-cases/run-case.mjs <case-folder> [baseUrl] [--dry-run] [--version n] [--timeout-min m]");
  process.exit(2);
}
const caseDir = resolve(caseArg);
const base = (baseArg ?? "http://localhost:8788").replace(/\/$/, "");
const AUTH = process.env.ACCESS_PASSCODE ? { authorization: `Bearer ${process.env.ACCESS_PASSCODE}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function validate() {
  const problems = [];
  const warnings = [];
  let c;
  try {
    c = JSON.parse(await readFile(join(caseDir, "case.json"), "utf8"));
  } catch (e) {
    return { problems: [`case.json unreadable: ${e.message}`], warnings, c: null, files: [] };
  }
  for (const k of ["id", "title", "teamId", "output", "task", "files"]) if (c[k] === undefined) problems.push(`case.json: missing "${k}"`);
  if (typeof c.task !== "string" || !c.task.trim()) problems.push("task must be a non-empty string");
  else if (c.task.length > MAX_TASK) problems.push(`task is ${c.task.length} chars (max ${MAX_TASK})`);
  if (!["work-plan", "lab-experiment"].includes(c.output)) problems.push(`output "${c.output}" is not work-plan or lab-experiment`);
  if (TEAM_OUTPUT[c.teamId] && TEAM_OUTPUT[c.teamId] !== c.output) problems.push(`team "${c.teamId}" produces ${TEAM_OUTPUT[c.teamId]}, not ${c.output}`);
  if (!TEAM_OUTPUT[c.teamId]) warnings.push(`team "${c.teamId}" is not a seeded team; it must exist on the server`);
  if (c.repo !== null && c.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) problems.push(`repo "${c.repo}" is not owner/name`);
  if (c.title && c.title.length > 200) warnings.push("title is long (> 200 chars)");
  const files = [];
  if (!Array.isArray(c.files)) problems.push("files must be an array");
  else {
    if (c.files.length > MAX_FILES) problems.push(`${c.files.length} files (max ${MAX_FILES})`);
    for (const rel of c.files) {
      const p = resolve(caseDir, rel);
      const ext = extname(p).slice(1).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) problems.push(`${rel}: extension ".${ext}" not allowed`);
      try {
        const st = await stat(p);
        if (!st.isFile()) problems.push(`${rel}: not a file`);
        else if (st.size === 0) problems.push(`${rel}: empty`);
        else if (st.size > MAX_BYTES) problems.push(`${rel}: ${st.size} bytes (max ${MAX_BYTES})`);
        else {
          const head = (await readFile(p)).subarray(0, 5).toString("latin1");
          if (ext === "pdf" && !head.startsWith("%PDF-")) problems.push(`${rel}: not a PDF (no %PDF- header)`);
          if (["docx", "xlsx"].includes(ext) && !head.startsWith("PK")) problems.push(`${rel}: not a zip-based Office file`);
          files.push({ rel, path: p, bytes: st.size, ext });
        }
      } catch {
        problems.push(`${rel}: missing`);
      }
    }
  }
  return { problems, warnings, c, files };
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? { ...AUTH } : { ...AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function upload(f) {
  const form = new FormData();
  form.append("file", new Blob([await readFile(f.path)]), basename(f.path));
  const res = await fetch(base + "/api/files", { method: "POST", headers: { ...AUTH }, body: form });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  return { status: res.status, data };
}

async function waitFor(runId, pred, label) {
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const { status, data } = await call("GET", `/agents/run-agent/${runId}`);
    if (status !== 200) throw new Error(`GET run → ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const line = `  … ${data.status} · ${data.spans?.length ?? 0} spans · active ${data.activeRole ?? "-"} · ${data.totals?.turns ?? 0} turns · ${data.totals?.sectionsApproved ?? 0} approved`;
    if (line !== last) { console.log(line); last = line; }
    if (pred(data)) return data;
    await sleep(2000);
  }
  throw new Error(`Timed out after ${timeoutMin} min waiting for ${label}`);
}

function summarize(s, c) {
  const L = [];
  const t = s.totals ?? {};
  L.push(`Case: ${c.id} — ${c.title}`);
  L.push(`Run: ${s.runId} · ${s.status}${s.stopReason ? ` (${s.stopReason})` : ""} · team ${s.team?.name} ${s.team?.version} · output ${s.output}`);
  L.push(`Totals: ${t.turns} turns · ${t.inputTokens} in + ${t.outputTokens} out tokens · ${t.sectionsApproved} sections approved · ${t.reviewRoundsUsed} send-backs`);
  L.push(`Files: ${(s.files ?? []).map((f) => `${f.name} (${f.chars} chars${f.truncated ? ", truncated" : ""}, ${f.status})`).join(", ") || "none"}`);
  const reads = (s.spans ?? []).filter((x) => x.kind === "tool").map((x) => `${x.role}: ${x.action}`);
  L.push(`Tool spans: ${reads.join(" | ") || "none"}`);
  for (const sec of s.sections ?? []) {
    L.push(`\n## ${sec.name} — ${sec.owner} · ${sec.status} · ${sec.rounds} draft(s)${sec.consulted?.length ? ` · consulted ${sec.consulted.join(", ")}` : ""}`);
    for (const b of sec.content ?? []) L.push(`  - ${b}`);
    for (const r of sec.reviews ?? []) L.push(`  [review ${r.round}: ${r.verdict}] ${r.note}`);
    for (const src of sec.sources ?? []) L.push(`  (source) ${src}`);
  }
  L.push("\nOpen questions");
  for (const q of s.openQuestions ?? []) L.push(`  - [${q.raisedBy}] ${q.question}`);
  if (!s.openQuestions?.length) L.push("  (none)");
  return L.join("\n");
}

async function main() {
  const { problems, warnings, c, files } = await validate();
  console.log(`Case folder: ${caseDir}`);
  if (c) console.log(`Case: ${c.id} — ${c.title} · team ${c.teamId} · output ${c.output} · task ${c.task?.length ?? 0} chars`);
  for (const f of files) console.log(`  file ${f.rel} · ${f.ext} · ${f.bytes} bytes`);
  for (const w of warnings) console.log(`  warn ${w}`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  if (problems.length) process.exit(1);
  if (dryRun) {
    console.log(`Dry run OK: ${files.length} file(s), task ${c.task.length}/${MAX_TASK} chars. No server called.`);
    return;
  }

  console.log(`\nBase URL: ${base}${AUTH.authorization ? " (with access passcode)" : ""}`);
  const fileIds = [];
  for (const f of files) {
    const up = await upload(f);
    const ok = up.status === 201 && up.data.status === "ready";
    console.log(`  upload ${f.rel} → ${up.status} ${up.data.status ?? up.data.error} (${up.data.chars ?? 0} chars${up.data.truncated ? ", truncated" : ""})`);
    if (!ok) throw new Error(`Upload failed for ${f.rel}: ${up.data.error ?? up.status}`);
    fileIds.push(up.data.fileId);
  }

  const body = { task: c.task, title: c.title, teamId: c.teamId, fileIds, ...(c.repo ? { repo: c.repo } : {}), ...(teamVersion ? { teamVersion: Number(teamVersion) } : {}) };
  const created = await call("POST", "/api/runs", body);
  if (created.status !== 201) throw new Error(`POST /api/runs → ${created.status} ${JSON.stringify(created.data)}`);
  const runId = created.data.runId;
  console.log(`\nRun ${runId} created; waiting for the brief`);

  let s = await waitFor(runId, (d) => d.status !== "drafting_brief", "the brief");
  if (s.status === "awaiting_approval") {
    console.log("\nBrief");
    for (const [k, v] of Object.entries(s.brief ?? {})) console.log(`  ${k}: ${v}`);
    const ap = await call("POST", `/agents/run-agent/${runId}/approve`, {});
    if (ap.status !== 200) throw new Error(`approve → ${ap.status} ${JSON.stringify(ap.data)}`);
    console.log("\nApproved; running");
    s = await waitFor(runId, (d) => TERMINAL.includes(d.status), "the run to end");
  }
  if (s.output && s.output !== c.output) console.log(`  warn run output is ${s.output}, case expects ${c.output}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(caseDir, "results", stamp);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "state.json"), JSON.stringify(s, null, 2));
  const spans = await call("GET", `/agents/run-agent/${runId}/spans`);
  if (spans.status === 200) await writeFile(join(out, "spans.json"), JSON.stringify(spans.data, null, 2));
  const doc = await call("GET", `/agents/run-agent/${runId}/document`);
  if (doc.status === 200 && typeof doc.data === "string") await writeFile(join(out, "document.md"), doc.data);
  else console.log(`  warn GET …/document → ${doc.status}`);
  const summary = summarize(s, c);
  await writeFile(join(out, "summary.txt"), summary + "\n");
  console.log("\n" + summary);
  console.log(`\nSaved to ${out}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const hasChecks = await access(join(caseDir, "checks.json")).then(() => true, () => false);
  if (hasChecks) {
    console.log("\nScore");
    spawnSync(process.execPath, [join(here, "score.mjs"), caseDir, out], { stdio: "inherit" });
  }
  process.exit(s.status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
