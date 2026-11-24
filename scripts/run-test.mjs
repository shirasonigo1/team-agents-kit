#!/usr/bin/env node
// End-to-end test against a running app (wrangler dev or a deployment). Uses the Workers AI allowance.
//
//   ACCESS_PASSCODE=… node scripts/run-test.mjs [baseUrl] [--repo owner/name] [--team id] [--version n]
//                                              [--file path]… [--task "…"] [--stop-after N] [--errors-only]
//
//   baseUrl             default http://localhost:8788 (start it with `npm run dev -- --port 8788`)
//   --team / --version  run with that saved team version (default: latest "squad"); --team ux-research
//                       runs the Research lab (Lab experiment design). Checks follow the team's output.
//   --task "…"          the task (default: a Work plan or a Lab experiment task, by the team's output)
//   --repo owner/name   link a public GitHub repo (teams with an Engineer only)
//   --file path         upload the file (POST /api/files) and attach it to the run; repeatable
//   --stop-after N      press Stop once N spans exist after approval (tests Stop mid-run)
//   --errors-only       only the cheap error-case checks (no model calls except one brief)
//
// Runs the API error cases, creates a run, waits for the brief, approves it, polls until the run
// ends, prints the trace / totals / sections, and runs consistency checks. Exits 1 if a check fails.
// ACCESS_PASSCODE (from .dev.vars locally) is sent as `Authorization: Bearer …`.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const repo = flag("--repo");
const teamId = flag("--team");
const teamVersion = flag("--version");
const filePaths = [];
for (let f = flag("--file"); f; f = flag("--file")) filePaths.push(f);
const stopAfter = flag("--stop-after");
const taskArg = flag("--task");
const errorsOnlyIdx = args.indexOf("--errors-only");
const errorsOnly = errorsOnlyIdx >= 0;
if (errorsOnly) args.splice(errorsOnlyIdx, 1);
const base = (args[0] ?? "http://localhost:8788").replace(/\/$/, "");

const TASKS = {
  "work-plan": "Plan the launch of offline mode for our field-notes app. Target: beta by end of Q1. The team is 4 engineers and 1 designer.",
  "lab-experiment": "Design an experiment to test whether an onboarding checklist increases week-1 retention of a note-taking app. Current week-1 retention is about 30%."
};
// The same pure functions the engine uses (Node ≥ 22.18 loads the .ts files directly).
const { sampleSize } = await import("../src/sample-size.ts");
const { unverifiedSampleSizes, SAMPLE_SIZE_CHECK_WHY } = await import("../src/checks.ts");
const { MODELS, DEFAULT_MODEL_ID } = await import("../src/contract.ts");
const SIZING_SECTIONS = ["sample", "analysis"];
const TERMINAL = ["completed", "stopped", "failed"];
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Access control: the Worker accepts `Authorization: Bearer <passcode>` from scripts.
// Set ACCESS_PASSCODE in the environment (for local dev it's in .dev.vars).
const AUTH = process.env.ACCESS_PASSCODE ? { authorization: `Bearer ${process.env.ACCESS_PASSCODE}` } : {};

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? { ...AUTH } : { ...AUTH, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function waitFor(runId, pred, label, timeoutMs = 15 * 60_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const { data } = await call("GET", `/agents/run-agent/${runId}`);
    const n = data.spans?.length ?? 0;
    const line = `  … ${data.status} · ${n} spans · active ${data.activeRole ?? "-"} · ${data.totals?.turns ?? 0} turns`;
    if (line !== last) {
      process.stdout.write(line + "\n");
      last = line;
    }
    if (pred(data)) return data;
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function upload(path) {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const form = new FormData();
  form.append("file", new Blob([await readFile(path)]), basename(path));
  const res = await fetch(base + "/api/files", { method: "POST", headers: { ...AUTH }, body: form });
  return { status: res.status, data: await res.json() };
}

async function errorCases() {
  console.log("\nError cases");
  let r = await call("POST", "/api/runs", "not json");
  check(r.status === 400, `invalid JSON body → 400 (${r.status})`);
  r = await call("POST", "/api/runs", { title: "x" });
  check(r.status === 400, `missing task → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/runs", { task: "x".repeat(4001) });
  check(r.status === 400, `task over 4000 chars → 400 (${r.status})`);
  r = await call("POST", "/api/runs", { task: "t", repo: "not a repo" });
  check(r.status === 400, `bad repo → 400 (${r.status}: ${r.data.error})`);
  r = await call("GET", "/agents/run-agent/doesnotexist");
  check(r.status === 404, `unknown run → 404 (${r.status})`);
  r = await call("PUT", "/api/runs");
  check(r.status === 405, `PUT /api/runs → 405 (${r.status})`);
  r = await call("GET", "/api/team");
  check(r.status === 200 && r.data.sections?.length === 8 && r.data.roles?.PL, `GET /api/team → 200 with 8 sections`);
  r = await call("GET", "/api/health");
  check(r.status === 200 && r.data.ok, "GET /api/health still works");
  // Run request validation (no run is created by any of these).
  r = await call("POST", "/api/runs", { task: "t", teamId: "no-such-team" });
  check(r.status === 400, `unknown teamId → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/runs", { task: "t", teamVersion: 999 });
  check(r.status === 400, `unknown teamVersion → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/runs", { task: "t", fileIds: ["nope"] });
  check(r.status === 400, `unknown fileId → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/runs", { task: "t", fileIds: ["a", "b", "c", "d", "e", "f"] });
  check(r.status === 400, `6 fileIds → 400 (${r.status}: ${r.data.error})`);
  r = await call("GET", "/api/teams");
  check(r.status === 200 && r.data.some((t) => t.teamId === "squad"), "GET /api/teams lists squad");
  // Templates, seeded teams, template-bound validation (no runs, no model calls).
  const ux = r.data.find((t) => t.teamId === "ux-research");
  check(!!ux && ux.templateId === "research-lab" && ux.outputId === "lab-experiment" && ux.coordinator === "PI" && ux.members?.join() === "PI,MS,DA,ER,C",
    "GET /api/teams seeds ux-research (research-lab, PI, PI/MS/DA/ER/C)");
  check(r.data.every((t) => t.templateId && t.outputId && t.coordinator && Array.isArray(t.members)), "every TeamSummary has templateId, outputId, coordinator, members");
  r = await call("GET", "/api/templates");
  check(r.status === 200 && r.data.length === 2 && r.data.every((t) => t.roles?.length === t.members.length && t.sections?.length && t.outputName),
    `GET /api/templates → ${r.data.map?.((t) => `${t.templateId} (${t.outputName}, ${t.sections.length} sections)`).join(", ")}`);
  r = await call("POST", "/api/teams/ux-research/versions", { note: "x", members: [{ role: "E" }] });
  check(r.status === 400, `squad role on a lab team → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/teams/ux-research/versions", { note: "x", consultRules: [{ a: "PI", b: "DA", what: "x" }] });
  check(r.status === 400, `consult pair not in the template → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/teams/ux-research/versions", { note: "x", members: [{ role: "MS", tools: ["sample_size"] }] });
  check(r.status === 400, `sample_size given to MS → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/teams", { name: "x", templateId: "nope" });
  check(r.status === 400, `unknown templateId → 400 (${r.status}: ${r.data.error})`);
  r = await call("POST", "/api/runs", { task: "t", teamId: "ux-research", repo: "cloudflare/agents" });
  check(r.status === 400, `repo on a team without an Engineer → 400 (${r.status}: ${r.data.error})`);
  // Models: the list, and per-member model validation (no version is created).
  r = await call("GET", "/api/models");
  check(r.status === 200 && Array.isArray(r.data) && r.data.length === MODELS.length && r.data.some((m) => m.id === DEFAULT_MODEL_ID) &&
    r.data.every((m) => m.id && m.label && typeof m.jsonMode === "boolean" && typeof m.verified === "boolean"),
    `GET /api/models → ${r.data.length} models (${r.data.map?.((m) => `${m.label}${m.jsonMode ? "" : " (no JSON mode)"}`).join(", ")})`);
  r = await call("POST", "/api/teams/squad/versions", { note: "x", members: [{ role: "R", model: "@cf/no/such-model" }] });
  check(r.status === 400 && /model/.test(r.data.error), `unknown member model → 400 (${r.status}: ${r.data.error})`);
  // Member routes (no model calls).
  r = await call("GET", "/api/teams/squad/members");
  check(r.status === 200 && Array.isArray(r.data) && r.data.map((v) => v.role).join() === "PL,R,D,E,C" &&
    r.data.every((v) => v.agentName === `squad--${v.role}` && v.teamId === "squad" && v.stats && Array.isArray(v.memories) && v.memories.length <= 5),
    `GET /api/teams/squad/members → 5 MemberViews (${r.data.map?.((v) => `${v.agentName}: ${v.stats.turns} turns, ${v.memories.length} mem`).join(", ")})`);
  r = await call("GET", "/api/teams/ux-research/members/DA");
  check(r.status === 200 && r.data.agentName === "ux-research--DA" && Array.isArray(r.data.recentInbox) && r.data.memories.length <= 100 && r.data.recentInbox.length <= 20,
    `GET /api/teams/ux-research/members/DA → MemberView (${r.data.memories?.length} memories, ${r.data.recentInbox?.length} inbox)`);
  r = await call("GET", "/api/teams/no-such-team/members");
  check(r.status === 404, `members of an unknown team → 404 (${r.status})`);
  r = await call("GET", "/api/teams/squad/members/PI");
  check(r.status === 404, `role not in the team → 404 (${r.status}: ${r.data.error})`);
  r = await call("DELETE", "/api/teams/squad/members/PI/memory");
  check(r.status === 404, `DELETE memory of a role not in the team → 404 (${r.status})`);
  r = await call("GET", "/api/teams/squad/members/R/memory");
  check(r.status === 405, `GET …/memory → 405 (${r.status})`);
  r = await call("GET", "/agents/member-agent/squad--R");
  check(r.status === 404, `/agents/member-agent/* is not exposed → 404 (${r.status})`);
}

function printRun(s) {
  console.log(`\nStatus: ${s.status}${s.stopReason ? ` (${s.stopReason})` : ""}`);
  const runMs = s.endedAt && s.startedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null;
  if (runMs !== null) console.log(`Run time after approval: ${(runMs / 1000).toFixed(1)}s`);

  console.log("\nTrace");
  for (const sp of s.spans) {
    const t = `${(sp.startMs / 1000).toFixed(1).padStart(6)}s +${(sp.durMs / 1000).toFixed(1).padStart(4)}s`;
    const tok = sp.model ? ` ${sp.inputTokens}/${sp.outputTokens} tok` : "";
    const indent = "  ".repeat(Math.min(sp.depth, 6));
    console.log(`  #${String(sp.id).padStart(2)} ${t} ${sp.role.padEnd(2)} ${sp.kind.padEnd(6)} ${indent}${sp.action} [${sp.status}]${tok}`);
  }

  const t = s.totals;
  console.log(
    `\nTotals: ${t.turns} turns · ${t.inputTokens} in + ${t.outputTokens} out = ${t.inputTokens + t.outputTokens} tokens · ` +
      `${t.sectionsApproved} sections approved · ${t.reviewRoundsUsed} send-backs`
  );

  console.log("\nSections");
  for (const sec of s.sections) {
    console.log(
      `\n## ${sec.name} — ${sec.owner} · ${sec.status} · ${sec.rounds} draft(s)` +
        `${sec.consulted.length ? ` · consulted ${sec.consulted.join(", ")}` : ""} · ${sec.tokens} tok`
    );
    for (const b of sec.content) console.log(`  - ${b}`);
    for (const rv of sec.reviews) console.log(`  [review ${rv.round}: ${rv.verdict}] ${rv.note}`);
    for (const src of sec.sources) console.log(`  (source) ${src}`);
  }

  console.log("\nOpen questions");
  if (!s.openQuestions.length) console.log("  (none)");
  for (const q of s.openQuestions) console.log(`  - [${q.raisedBy}] ${q.question}`);
}

async function checks(s, team, cfg, files, tpl) {
  console.log("\nConsistency checks");
  // Output-aware: sections, owners and roles follow the team's template.
  check(s.output === cfg.outputId, `run output is the team's output (${s.output})`);
  check(s.sections.map((x) => x.id).join() === tpl.sections.map((x) => x.id).join(), `sections follow OUTPUTS[${cfg.outputId}] (${s.sections.length})`);
  check(s.sections.every((x) => x.owner === tpl.sections.find((p) => p.id === x.id).owner), "section owners come from the template");
  const coord = cfg.coordinator;
  const coordOnly = s.spans.filter((x) => /^(Draft brief|Split brief|Assign |Compile open|Merge open|Assemble )/.test(x.action));
  check(coordOnly.length > 0 && coordOnly.every((x) => x.role === coord), `brief / split / assign / compile / assemble spans are by the coordinator ${coord} (${coordOnly.length})`);
  check(s.spans.filter((x) => x.kind === "review").every((x) => x.role === "C"), "every review span is by the Critic (C)");
  check(s.spans.every((x) => cfg.members.some((m) => m.role === x.role)), "every span is by a member of the team");
  const toolOf = (sp) => sp.action.startsWith("Read GitHub repo") ? "github_repo" : sp.action.startsWith("Sample size:") ? "sample_size" : sp.action.startsWith("Read ") ? "read_files" : null;
  const toolSpans = s.spans.filter((x) => x.kind === "tool");
  check(toolSpans.every((x) => { const t = toolOf(x); const m = cfg.members.find((mm) => mm.role === x.role); return t && m && m.tools.includes(t); }),
    `tool spans only by members that have the tool (${toolSpans.map((x) => `${x.role}:${toolOf(x)}`).join(", ") || "none"})`);
  const sizeSpans = toolSpans.filter((x) => x.action.startsWith("Sample size:"));
  for (const sp of sizeSpans) {
    const full = (await call("GET", `/agents/run-agent/${s.runId}/spans`)).data.find((x) => x.id === sp.id);
    let req = null;
    try { req = JSON.parse(full.input); } catch {}
    const want = req ? sampleSize(req) : { error: "unparseable request" };
    if (sp.status === "done") {
      let got = null;
      try { got = JSON.parse(full.output); } catch {}
      check(!!got && JSON.stringify(got) === JSON.stringify(want) && sp.model === null && sp.inputTokens + sp.outputTokens === 0,
        `#${sp.id} ${sp.action} → ${got?.perGroup} per group == sampleSize() ${want.perGroup ?? want.error} (model null, 0 tokens)`);
      const head = `Sample size: ${want.perGroup.toLocaleString("en-US")} per group, ${want.total.toLocaleString("en-US")} total`;
      const cited = s.sections.some((x) => x.sources.some((src) => src.startsWith(head) && src.includes(`span #${sp.id}`)));
      check(cited, `#${sp.id}'s result is cited as a source ("${head} …")`);
    } else {
      check("error" in want && full.output.includes(want.error), `#${sp.id} ${sp.action} failed with the validation error (${want.error})`);
    }
  }
  await sampleSizeGuardChecks(s, cfg);
  if (cfg.outputId === "lab-experiment") console.log(`  info sample-size tool spans: ${sizeSpans.length} (${sizeSpans.map((x) => `#${x.id} ${x.status}`).join(", ") || "the Data analyst chose not to use it"})`);
  const spans = s.spans;
  const turns = spans.filter((x) => x.model !== null).length;
  const inT = spans.reduce((a, x) => a + x.inputTokens, 0);
  const outT = spans.reduce((a, x) => a + x.outputTokens, 0);
  check(s.totals.turns === turns, `totals.turns (${s.totals.turns}) == model spans (${turns})`);
  check(s.totals.inputTokens === inT && s.totals.outputTokens === outT, `totals tokens == sum over spans (${inT}/${outT})`);
  const approved = s.sections.filter((x) => x.status === "approved").length;
  check(s.totals.sectionsApproved === approved, `totals.sectionsApproved (${s.totals.sectionsApproved}) == approved sections (${approved})`);
  const sendBacks = s.sections.reduce((a, x) => a + x.reviews.filter((r) => r.verdict === "sent_back").length, 0);
  check(s.totals.reviewRoundsUsed === sendBacks, `totals.reviewRoundsUsed (${s.totals.reviewRoundsUsed}) == send-backs (${sendBacks})`);
  const ids = new Set(spans.map((x) => x.id));
  check(spans.every((x) => x.parentId === null || ids.has(x.parentId)), "every span's parent exists");
  check(
    spans.every((x) => x.parentId === null ? x.depth === 0 : x.depth === spans.find((p) => p.id === x.parentId).depth + 1),
    "depth == parent depth + 1"
  );
  check(spans.every((x) => x.parentId === null || x.parentId < x.id), "parents come before children");
  check(!spans.some((x) => x.status === "running") || !TERMINAL.includes(s.status), "no span left running after the run ended");
  // The run used the requested team version, and its rules / guardrails.
  check(s.teamRef?.teamId === cfg.teamId && s.teamRef?.version === cfg.version, `run used ${cfg.teamId} v${cfg.version} (teamRef ${JSON.stringify(s.teamRef)})`);
  check(s.teamConfig?.version === cfg.version && s.team.version === cfg.versionLabel, `teamConfig snapshot and team label are ${cfg.versionLabel}`);
  check(JSON.stringify(s.guardrails) === JSON.stringify(cfg.guardrails), `guardrails come from the version (${JSON.stringify(s.guardrails)})`);
  const canMessage = (from, to) =>
    from !== to && cfg.rules.some((r) => (r.from === from || r.from === "*") && (r.to === to || r.to === "*"));
  const consultsOk = s.sections.every((sec) => sec.consulted.every((r) => sec.consults.includes(r) && canMessage(sec.owner, r) && canMessage(r, sec.owner)));
  check(consultsOk, "every consult is listed for its section and obeys canMessage both ways");
  const effOk = s.sections.every((sec) => sec.consults.every((r) => canMessage(sec.owner, r) && canMessage(r, sec.owner)));
  check(effOk, `section plan consults == effectiveConsults under ${cfg.versionLabel}'s rules`);
  const asks = spans.filter((x) => x.kind === "msg" && x.action.startsWith("Ask "));
  check(asks.every((x) => { const to = Object.values(team.roles).find((r) => x.action.startsWith(`Ask ${r.name}:`)); return to && canMessage(x.role, to.id) && canMessage(to.id, x.role); }),
    `every "Ask" span follows ${cfg.versionLabel}'s consult rules (${asks.map((x) => x.role + "→" + x.action.slice(4, 12)).join(", ") || "none"})`);
  if (files.length) {
    const readers = cfg.members.filter((m) => m.tools.includes("read_files")).map((m) => m.role).filter((r) => s.sections.some((x) => x.owner === r));
    for (const r of readers) {
      for (const f of files) {
        const span = spans.find((x) => x.kind === "tool" && x.role === r && x.action === `Read ${f.name}`);
        check(!!span && span.model === null && span.inputTokens === 0, `${r} has a "Read ${f.name}" tool span (model null, 0 tokens)`);
      }
      const owned = s.sections.filter((x) => x.owner === r && x.content.length);
      const cited = owned.filter((x) => files.some((f) => x.sources.some((src) => src === f.name || src === `${f.name}, excerpt`)));
      check(owned.length > 0 && cited.length === owned.length, `${r}'s drafted sections list the files as sources (${cited.length}/${owned.length})`);
    }
  }
  const msgOk = spans
    .filter((x) => x.kind === "msg")
    .every((x) => {
      const m = x.action.match(/^(?:Assign .* to|Ask) ([A-Za-z ]+?)(?::|$)/);
      if (!m) return true;
      const to = Object.values(team.roles).find((r) => r.name === m[1]);
      return to ? canMessage(x.role, to.id) : false;
    });
  check(msgOk, "every message span follows a handoff rule");
  for (const sec of s.sections) {
    check(sec.reviews.filter((r) => r.verdict === "sent_back").length <= s.guardrails.criticRounds, `${sec.id}: send-backs within criticRounds`);
  }
  if (s.status === "completed") {
    check(s.sections.filter((x) => x.id !== "open").every((x) => x.status === "approved"), "completed run: every reviewed section approved");
    check(s.sections.find((x) => x.id === "open")?.status === "open", 'completed run: Open questions section has status "open"');
    check(!!s.endedAt && !!s.startedAt, "startedAt and endedAt set");
  }
  await memberChecks(s, cfg);
  const tree = await call("GET", `/agents/run-agent/${s.runId}/spans`);
  check(tree.status === 200 && tree.data.length === spans.length, `GET …/spans returns all ${spans.length} spans with full text`);
  const list = await call("GET", "/api/runs");
  const row = list.data.find((r) => r.runId === s.runId);
  check(!!row && row.status === s.status && row.turns === s.totals.turns, "GET /api/runs lists the run with its current status and turns");
  check(!!row && row.teamId === cfg.teamId && row.teamVersion === cfg.version && row.fileCount === files.length,
    `GET /api/runs row has team ${row?.teamId} v${row?.teamVersion} and ${row?.fileCount} file(s)`);
  check(!!row && row.outputId === cfg.outputId, `GET /api/runs row has outputId ${row?.outputId}`);
}

/**
 * The automatic sample-size check: its review spans look right, and no approved sizing section states
 * a sample size the calculator didn't compute (unless the note was kept at the send-back limit).
 */
async function sampleSizeGuardChecks(s, cfg) {
  const auto = s.spans.filter((x) => x.why === SAMPLE_SIZE_CHECK_WHY);
  const hasCalculator = cfg.members.some((m) => m.tools.includes("sample_size"));
  check(auto.every((x) => x.kind === "review" && x.role === "C" && x.model === null && x.inputTokens + x.outputTokens === 0 && !x.agent &&
      ["sent_back", "approved"].includes(x.status) && SIZING_SECTIONS.includes(x.sectionId) && hasCalculator),
    `automatic sample-size checks are Critic review spans without a model, on sizing sections only (${auto.map((x) => `#${x.id} ${x.sectionId} ${x.status}`).join(", ") || "none fired"})`);
  check(auto.filter((x) => x.status === "sent_back").every((x) => s.spans.some((y) => y.parentId === x.id && (y.action.startsWith("Revise ") || y.kind === "msg" || y.action.startsWith("Decide on sample size"))) || (TERMINAL.includes(s.status) && s.status !== "completed")),
    "every automatic send-back is followed by a revision (or a sizing decision first)");
  if (!hasCalculator) return;
  const results = [];
  for (const sp of s.spans.filter((x) => x.kind === "tool" && x.action.startsWith("Sample size:") && x.status === "done")) {
    const full = (await call("GET", `/agents/run-agent/${s.runId}/spans`)).data.find((x) => x.id === sp.id);
    try { results.push(JSON.parse(full.output)); } catch {}
  }
  for (const sec of s.sections.filter((x) => SIZING_SECTIONS.includes(x.id) && x.status === "approved")) {
    const bad = unverifiedSampleSizes(sec.content.join("\n"), results);
    const kept = sec.sources.some((src) => src.startsWith("Critic's note kept at the send-back limit"));
    check(!bad.length || kept, `${sec.id}: every stated sample size comes from the calculator${bad.length ? ` (not: ${bad.join(", ")}; note kept)` : ""}`);
  }
}

/** Every model turn ran on the member's own agent and model; messages reached inboxes; memory grew. */
async function memberChecks(s, cfg) {
  const agentOf = (role) => `${cfg.teamId}--${role}`;
  const spans = s.spans;
  check(cfg.members.every((m) => s.memberAgents?.[m.role] === agentOf(m.role)), `state.memberAgents maps every member (${Object.values(s.memberAgents ?? {}).join(", ")})`);
  const model = spans.filter((x) => x.model !== null);
  const badAgent = model.filter((x) => x.agent !== agentOf(x.role));
  check(model.length > 0 && !badAgent.length, `every model span has agent = memberAgentName(teamId, role) (${model.length}${badAgent.length ? `; wrong: ${badAgent.map((x) => "#" + x.id).join(", ")}` : ""})`);
  check(spans.filter((x) => x.model === null).every((x) => !x.agent), "engine / coordinator-only spans (tools, messages, system) have no agent");
  const modelOf = (role) => cfg.members.find((m) => m.role === role)?.model ?? DEFAULT_MODEL_ID;
  const wrongModel = model.filter((x) => x.model !== modelOf(x.role));
  check(!wrongModel.length, `every model span ran on its member's model (${[...new Set(model.map((x) => `${x.role}: ${x.model.split("/").pop()}`))].join(", ")}${wrongModel.length ? `; wrong: ${wrongModel.map((x) => "#" + x.id).join(", ")}` : ""})`);
  const roleByName = Object.fromEntries(Object.values(ROLE_NAMES).map((r) => [r.name, r.id]));
  const msgs = spans.filter((x) => x.kind === "msg");
  const undelivered = msgs.filter((x) => {
    const m = x.action.match(/^(?:Assign .* to|Ask) ([A-Za-z ]+?)(?::|$)/);
    const to = m && roleByName[m[1]];
    return !to || x.delivered?.to !== to || x.status !== "done";
  });
  check(msgs.length > 0 && !undelivered.length, `every msg span was delivered to its recipient's inbox (${msgs.length}${undelivered.length ? `; not: ${undelivered.map((x) => "#" + x.id).join(", ")}` : ""})`);
  check(spans.every((x) => !x.delivered || x.kind === "msg"), "delivered is only set on msg spans");
  check(spans.filter((x) => x.model !== null).every((x) => !!x.agent) && spans.filter((x) => x.model === null).every((x) => !x.agent),
    "agent is set exactly on spans with a model");
  // Memories used must exist in that member's memory; collect views once per role.
  const views = {};
  for (const m of cfg.members) {
    const r = await call("GET", `/api/teams/${cfg.teamId}/members/${m.role}`);
    check(r.status === 200 && r.data.agentName === agentOf(m.role), `GET /api/teams/${cfg.teamId}/members/${m.role} → ${r.status} (${r.data.stats?.turns} turns, ${r.data.memories?.length} memories)`);
    views[m.role] = r.data;
  }
  check(Object.values(views).every((v) => typeof v.memoryCount === "number" && v.memoryCount >= v.memories.length), "MemberView has memoryCount");
  // Consult answers and Critic's send-back notes reach the owner's inbox (looked up by the span that delivered them).
  const inboxHas = (role, spanId, kind) => (views[role]?.recentInbox ?? []).some((m) => m.runId === s.runId && m.spanId === spanId && m.kind === kind);
  const answers = spans.filter((x) => x.action.startsWith("Answer ") && x.status === "done");
  const ownerOf = (x) => s.sections.find((sec) => sec.id === x.sectionId)?.owner;
  // recentInbox holds the newest 20 messages only: an older message may have scrolled out.
  const recent = (x) => (views[ownerOf(x)]?.recentInbox?.length ?? 0) < 20 || inboxHas(ownerOf(x), x.id, x.kind === "review" ? "review" : "answer");
  check(answers.filter(recent).every((x) => inboxHas(ownerOf(x), x.id, "answer")), `consult answers are in the asking owner's inbox (${answers.length})`);
  const sentBack = spans.filter((x) => x.kind === "review" && x.status === "sent_back");
  check(sentBack.filter(recent).every((x) => inboxHas(ownerOf(x), x.id, "review")), `Critic's send-back notes are in the owner's inbox (${sentBack.length})`);
  const used = model.filter((x) => x.memoriesUsed?.length);
  const missing = used.flatMap((x) => x.memoriesUsed.filter((id) => !views[x.role]?.memories?.some((mm) => mm.id === id)).map((id) => `#${x.id}:${id}`));
  check(model.every((x) => Array.isArray(x.memoriesUsed) && x.memoriesUsed.length <= 5), "every model span lists memoriesUsed (≤ 5)");
  check(!missing.length, `memoriesUsed ids exist in the member's memory (${used.length} span(s) used ${used.reduce((a, x) => a + x.memoriesUsed.length, 0)} memories${missing.length ? `; missing ${missing.join(", ")}` : ""})`);
  console.log(`  info spans that used memories: ${used.map((x) => `#${x.id} ${x.role} [${x.memoriesUsed.join(",")}]`).join(", ") || "none"}`);
  const reflections = spans.filter((x) => x.action === "Reflect on the run");
  if (s.status === "completed") {
    const collect = spans.find((x) => x.action === "Collect lessons");
    check(!!collect && collect.role === cfg.coordinator && collect.kind === "system", `"Collect lessons" system span by ${cfg.coordinator}`);
    check(!!collect && !collect.agent && collect.model === null, `"Collect lessons" has no agent and no model`);
    check(reflections.every((x) => x.parentId === collect?.id && x.kind === "work" && x.model && x.sectionId === null && x.agent === agentOf(x.role)), `reflections are member turns under "Collect lessons" (${reflections.length})`);
    const worked = cfg.members.map((m) => m.role).filter((r) => spans.some((x) => x.role === r && x.model !== null && x.action !== "Reflect on the run"));
    const skipped = spans.some((x) => x.action === "Skip remaining reflections");
    check(skipped || worked.every((r) => reflections.some((x) => x.role === r)), `one reflection per member that worked (${reflections.map((x) => x.role).join(", ")})`);
    for (const sec of s.sections.filter((x) => x.status === "approved")) {
      const mem = views[sec.owner]?.memories ?? [];
      check(mem.some((m) => m.kind === "outcome" && m.runId === s.runId && m.sectionId === sec.id), `${sec.owner} remembers an outcome for ${sec.id}`);
      const sb = sec.reviews.filter((r) => r.verdict === "sent_back").length;
      if (sb) check(mem.some((m) => m.kind === "lesson" && m.sectionId === sec.id && m.text.startsWith(`${sec.name}:`)), `${sec.owner} remembers a lesson for each send-back of ${sec.id} (${sb})`);
    }
    const reflected = Object.values(views).flatMap((v) => v.memories.filter((m) => m.runId === s.runId && m.sectionId === null));
    check(reflected.every((m) => m.text.length <= 300), `reflection items ≤ 300 chars (${reflected.length} stored)`);
    console.log(`  info memory items created by this run: ${Object.values(views).reduce((a, v) => a + v.memories.filter((m) => m.runId === s.runId).length, 0)} ` +
      `(${Object.entries(views).map(([r, v]) => `${r}: ${v.memories.filter((m) => m.runId === s.runId).map((m) => m.kind[0]).join("") || "-"}`).join(", ")})`);
    for (const m of reflected) console.log(`  info reflection ${m.kind}: ${m.text}`);
  }
}

let ROLE_NAMES = {};

async function main() {
  console.log(`Base URL: ${base}${repo ? ` · repo ${repo}` : ""}${teamId ? ` · team ${teamId}` : ""}${teamVersion ? ` v${teamVersion}` : ""}`);
  const templates = (await call("GET", "/api/templates")).data;
  // Every role in any template (names for parsing "Assign …" / "Ask …" spans).
  const team = { roles: Object.fromEntries(templates.flatMap((t) => t.roles).map((r) => [r.id, r])) };
  ROLE_NAMES = team.roles;
  const tid = teamId ?? "squad";
  const cfgRes = teamVersion ? await call("GET", `/api/teams/${tid}/versions/${teamVersion}`) : { data: (await call("GET", `/api/teams/${tid}`)).data.team };
  const cfg = cfgRes.data;
  if (!cfg?.rules) throw new Error(`Team ${tid} ${teamVersion ?? "latest"} not found`);
  const tpl = templates.find((t) => t.templateId === (cfg.templateId ?? "product-squad"));
  const TASK = taskArg ?? TASKS[cfg.outputId ?? "work-plan"];
  console.log(`Team: ${cfg.name} ${cfg.versionLabel} — ${cfg.note} · ${tpl.name} → ${tpl.outputName} · coordinator ${cfg.coordinator} · criticRounds ${cfg.guardrails.criticRounds} · consult pairs ${cfg.rules.filter((r) => !["*", cfg.coordinator, "C"].includes(r.from) && !["*", cfg.coordinator, "C"].includes(r.to)).map((r) => r.from + "→" + r.to).join(" ")}`);
  console.log(`Task: ${TASK}`);
  await errorCases();
  if (errorsOnly && failures.length) process.exit(1);

  const files = [];
  for (const p of filePaths) {
    const up = await upload(p);
    check(up.status === 201 && up.data.status === "ready", `upload ${p} → ${up.status} ${up.data.status ?? up.data.error} (${up.data.chars ?? 0} chars)`);
    if (up.status === 201 && up.data.status === "ready") files.push(up.data);
  }

  console.log("\nCreating run");
  const created = await call("POST", "/api/runs", {
    task: TASK, ...(repo ? { repo } : {}), ...(teamId ? { teamId } : {}), ...(teamVersion ? { teamVersion: Number(teamVersion) } : {}),
    ...(files.length ? { fileIds: files.map((f) => f.fileId) } : {})
  });
  check(created.status === 201 && created.data.runId, `POST /api/runs → 201 (${created.status})`);
  const runId = created.data.runId;
  console.log(`  runId ${runId}`);

  const early = await call("POST", `/agents/run-agent/${runId}/approve`, {});
  check(early.status === 409, `approve while drafting_brief → 409 (${early.status})`);

  const t0 = Date.now();
  let s = await waitFor(runId, (d) => d.status !== "drafting_brief", "the brief");
  console.log(`  brief took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (s.status !== "awaiting_approval") {
    printRun(s);
    console.log(`\nRun ended before the brief: ${s.status} ${s.stopReason}`);
    process.exit(1);
  }
  console.log("\nBrief");
  for (const [k, v] of Object.entries(s.brief)) console.log(`  ${k}: ${v}`);

  let r = await call("POST", `/agents/run-agent/${runId}/approve`, { brief: { goal: 42 } });
  check(r.status === 400, `approve with invalid brief edit → 400 (${r.status})`);

  if (errorsOnly) {
    r = await call("POST", `/agents/run-agent/${runId}/stop`);
    check(r.status === 200 && r.data.status === "stopped", "stop while awaiting approval → stopped");
    r = await call("POST", `/agents/run-agent/${runId}/approve`);
    check(r.status === 409, `approve after stop → 409 (${r.status})`);
    r = await call("POST", `/agents/run-agent/${runId}/stop`);
    check(r.status === 409, `stop twice → 409 (${r.status})`);
    console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
    process.exit(failures.length ? 1 : 0);
  }

  r = await call("POST", `/agents/run-agent/${runId}/approve`);
  check(r.status === 200 && r.data.status === "running", `approve → 200 running (${r.status})`);
  r = await call("POST", `/agents/run-agent/${runId}/approve`);
  check(r.status === 409, `approve twice → 409 (${r.status})`);

  const briefSpans = s.spans.length;
  if (stopAfter) {
    const n = Number(stopAfter);
    await waitFor(runId, (d) => d.spans.length >= briefSpans + n || TERMINAL.includes(d.status), `${n} spans`);
    r = await call("POST", `/agents/run-agent/${runId}/stop`);
    check(r.status === 200 && r.data.status === "stopped" && r.data.stopReason === "Stopped by user", "Stop → stopped / Stopped by user");
    const spansAtStop = r.data.spans.length;
    await sleep(15_000); // a step that was in flight may still record its span; nothing new may start
    s = (await call("GET", `/agents/run-agent/${runId}`)).data;
    check(s.status === "stopped", "still stopped 15s later");
    check(s.spans.length <= spansAtStop + 1, `no new steps after Stop (${spansAtStop} → ${s.spans.length} spans)`);
    r = await call("POST", `/agents/run-agent/${runId}/stop`);
    check(r.status === 409, `stop twice → 409 (${r.status})`);
  } else {
    s = await waitFor(runId, (d) => TERMINAL.includes(d.status), "the run to end");
  }

  printRun(s);
  await checks(s, team, cfg, files, tpl);
  if (s.status === "completed") {
    const doc = await call("GET", `/agents/run-agent/${runId}/document`);
    check(doc.status === 200 && String(doc.data).startsWith("# "), "GET …/document returns Markdown");
  } else if (!stopAfter) {
    check(false, `run completed (got ${s.status}: ${s.stopReason})`);
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}` : "\nAll checks passed");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
