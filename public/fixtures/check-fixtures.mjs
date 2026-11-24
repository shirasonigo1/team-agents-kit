// Validates the UI fixtures against src/contract.ts (Node 22.6+ strips the TS types on import).
// Usage: node public/fixtures/check-fixtures.mjs   (from the project root)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES, HANDOFF_RULES, ALLOWED_TOOLS, TOOL_LABELS, OUTPUTS, TEMPLATES, fixedRulesFor, rulesFor, canMessage, effectiveConsults, memberAgentName, MODELS, DEFAULT_MODEL_ID } from "../../src/contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUN_STATUS = ["drafting_brief", "awaiting_approval", "running", "completed", "stopped", "failed"];
const SECTION_STATUS = ["pending", "drafting", "in_review", "sent_back", "approved", "open"];
const SPAN_KIND = ["work", "msg", "tool", "review", "system"];
const SPAN_STATUS = ["running", "done", "approved", "sent_back", "failed"];
const RUN_KEYS = ["runId", "title", "task", "output", "team", "repo", "status", "stopReason", "brief", "guardrails", "sections", "openQuestions", "spans", "totals", "activeRole", "createdAt", "startedAt", "endedAt"];
const RUN_TEAM_KEYS = ["teamRef", "teamConfig", "files"]; // runs on a saved team version (absent on legacy runs)
const RUN_AGENT_KEYS = ["memberAgents"]; // optional
const SPAN_AGENT_KEYS = ["agent", "memoriesUsed", "delivered"]; // optional
const MEMORY_KINDS = ["lesson", "note", "outcome"];
const INBOX_KINDS = ["assign", "question", "answer", "review", "brief", "files", "tool_result"];
const MEMBER_VIEW_KEYS = ["agentName", "teamId", "role", "stats", "memories", "recentInbox"];
const TEAM_KEYS = ["teamId", "name", "version", "versionLabel", "note", "createdAt", "coordinator", "members", "rules", "guardrails"];
const TEAM_OPTIONAL_KEYS = ["templateId", "outputId"]; // missing = Product squad / Work plan
const SUMMARY_KEYS = ["teamId", "name", "version", "versionLabel", "updatedAt", "runCount", "lastRunAt"];
const SUMMARY_OPTIONAL_KEYS = ["templateId", "outputId", "coordinator", "members"];
const FILE_KEYS = ["fileId", "name", "mimeType", "bytes", "chars", "truncated", "status", "error", "createdAt"];
const GUARD_RANGES = { maxTurns: [10, 120], maxTokens: [10_000, 300_000], criticRounds: [0, 3], noProgressTurns: [2, 20] };
const templateOf = (t) => TEMPLATES[(t && t.templateId) || "product-squad"];
const MODEL_IDS = MODELS.map((m) => m.id);
/** The model a member runs on (MemberConfig.model, missing = DEFAULT_MODEL_ID). */
const memberModel = (team, role) => ((team.members || []).find((m) => m.role === role) || {}).model || DEFAULT_MODEL_ID;

/** Inverse standard normal CDF (Acklam), for checking sample-size results independently of the engine. */
function zq(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - 0.02425) return -zq(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** Expected per-group n for a SampleSizeRequest (two-sided, normal approximation). */
function expectedPerGroup(req) {
  const alpha = req.alpha ?? 0.05, power = req.power ?? 0.8, z = (zq(1 - alpha / 2) + zq(power)) ** 2;
  if (req.test === "two_proportions") return Math.ceil(z * (req.p1 * (1 - req.p1) + req.p2 * (1 - req.p2)) / (req.p1 - req.p2) ** 2);
  if (req.test === "two_means") return Math.ceil(2 * z / req.effectSize ** 2);
  return NaN;
}
const SPAN_KEYS = ["id", "parentId", "role", "kind", "action", "why", "status", "startMs", "durMs", "depth", "sectionId", "inputTokens", "outputTokens", "model", "input", "output", "gatewayLogId"];
const SECTION_KEYS = ["id", "name", "owner", "consults", "guidance", "status", "rounds", "content", "consulted", "sources", "reviews", "spanIds", "tokens"];

let failures = 0;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function check(file, cond, msg) { if (!cond) { failures++; console.error(`✗ ${file}: ${msg}`); } }
const exactKeys = (o, keys) => keys.every((k) => k in o) && Object.keys(o).every((k) => keys.includes(k));
const isRole = (r) => Object.hasOwn(ROLES, r);
const ruleKey = (r) => `${r.from}>${r.to}`;

/** TeamConfig: the template's members in order, tools ⊆ ALLOWED_TOOLS, model ∈ MODELS, fixed rules present, consults two-way, guardrails in range. */
function checkTeamConfig(c, t, where) {
  c(t && TEAM_KEYS.every((k) => k in t) && Object.keys(t).every((k) => TEAM_KEYS.includes(k) || TEAM_OPTIONAL_KEYS.includes(k)), `${where}: TeamConfig keys ${t && Object.keys(t).join(",")}`);
  if (!t) return;
  const tpl = templateOf(t);
  c(!!tpl, `${where}: unknown templateId ${t.templateId}`);
  if (!tpl) return;
  c(!("outputId" in t) || t.outputId === tpl.outputId, `${where}: outputId ${t.outputId} is not the template's ${tpl.outputId}`);
  c(typeof t.teamId === "string" && /^[a-z0-9-]+$/.test(t.teamId), `${where}: teamId slug`);
  c(typeof t.name === "string" && t.name.length > 0 && t.name.length <= 60, `${where}: name ≤ 60`);
  c(Number.isInteger(t.version) && t.version >= 1 && t.versionLabel === `v${t.version}`, `${where}: version/versionLabel`);
  c(typeof t.note === "string" && t.note.length <= 200, `${where}: note ≤ 200`);
  c(!isNaN(Date.parse(t.createdAt)), `${where}: createdAt`);
  c(t.coordinator === tpl.coordinator, `${where}: coordinator ${t.coordinator} ≠ template's ${tpl.coordinator}`);
  c(JSON.stringify(t.members.map((m) => m.role)) === JSON.stringify(tpl.members), `${where}: members must be the template's [${tpl.members}] in order`);
  for (const m of t.members) {
    c(exactKeys(m, "model" in m ? ["role", "personality", "responsibleFor", "tools", "model"] : ["role", "personality", "responsibleFor", "tools"]), `${where}: member ${m.role} keys`);
    c(!("model" in m) || MODEL_IDS.includes(m.model), `${where}: member ${m.role} model ${m.model} is not in MODELS`);
    c(m.personality.length > 0 && m.personality.length <= 300 && m.responsibleFor.length > 0 && m.responsibleFor.length <= 300, `${where}: member ${m.role} text limits`);
    for (const tool of m.tools) c(Object.hasOwn(TOOL_LABELS, tool) && (ALLOWED_TOOLS[m.role] || []).includes(tool), `${where}: ${m.role} has tool ${tool} not in ALLOWED_TOOLS`);
    c(new Set(m.tools).size === m.tools.length, `${where}: ${m.role} duplicate tools`);
  }
  c(JSON.stringify(t.members.find((m) => m.role === "C").tools) === JSON.stringify(["comment"]), `${where}: the Critic can only comment`);
  const keys = new Set(t.rules.map(ruleKey));
  const fixedRules = fixedRulesFor(tpl.coordinator);
  for (const r of fixedRules) c(keys.has(ruleKey(r)), `${where}: fixed rule ${ruleKey(r)} missing`);
  const allowedConsults = rulesFor(tpl, tpl.consultPairs).filter((r) => !fixedRules.some((f) => ruleKey(f) === ruleKey(r)));
  for (const r of t.rules) {
    if (fixedRules.some((f) => ruleKey(f) === ruleKey(r))) continue;
    const pair = allowedConsults.find((h) => ruleKey(h) === ruleKey(r));
    c(!!pair, `${where}: rule ${ruleKey(r)} is not one of the template's consult pairs`);
    c(keys.has(`${r.to}>${r.from}`), `${where}: consult ${ruleKey(r)} not stored both ways`);
    c(!pair || pair.what === r.what, `${where}: consult ${ruleKey(r)} "what" differs from the template`);
  }
  c(keys.size === t.rules.length, `${where}: duplicate rules`);
  c(exactKeys(t.guardrails, Object.keys(GUARD_RANGES)), `${where}: guardrails keys`);
  for (const [k, [lo, hi]] of Object.entries(GUARD_RANGES)) c(Number.isInteger(t.guardrails[k]) && t.guardrails[k] >= lo && t.guardrails[k] <= hi, `${where}: guardrails.${k} = ${t.guardrails[k]} outside ${lo}–${hi}`);
}
function checkFile(c, f, where) {
  c(exactKeys(f, FILE_KEYS), `${where}: FileMeta keys`);
  c(f.bytes > 0 && f.bytes <= 2 * 1024 * 1024, `${where}: bytes ≤ 2 MB`);
  c(Number.isInteger(f.chars) && f.chars >= 0 && f.chars <= 60_000, `${where}: chars ≤ 60,000`);
  c(f.truncated === (f.chars === 60_000) || !f.truncated, `${where}: truncated only at the cap`);
  c(["ready", "failed"].includes(f.status) && (f.status === "failed") === (typeof f.error === "string"), `${where}: status/error`);
  c(/\.(pdf|docx|xlsx|csv|txt|md|html)$/i.test(f.name), `${where}: file type`);
}

const allFiles = readdirSync(here).filter((f) => f.endsWith(".json")).sort();

// ---------- Teams ----------
const teamsList = JSON.parse(readFileSync(join(here, "teams.json"), "utf8"));
{
  const c = (cond, msg) => check("teams.json", cond, msg);
  c(Array.isArray(teamsList) && teamsList.length > 0, "TeamSummary[]");
  for (const t of teamsList) {
    c(SUMMARY_KEYS.every((k) => k in t) && Object.keys(t).every((k) => SUMMARY_KEYS.includes(k) || SUMMARY_OPTIONAL_KEYS.includes(k)), `${t.teamId}: TeamSummary keys`);
    const tpl = templateOf(t);
    if (t.members) c(JSON.stringify(t.members) === JSON.stringify(tpl.members), `${t.teamId}: members ≠ template members`);
    if (t.coordinator) c(t.coordinator === tpl.coordinator, `${t.teamId}: coordinator`);
    if (t.outputId) c(t.outputId === tpl.outputId, `${t.teamId}: outputId`);
    c(t.lastRunAt === null || !isNaN(Date.parse(t.lastRunAt)), `${t.teamId}: lastRunAt`);
    c(allFiles.includes(`team-${t.teamId}.json`), `${t.teamId}: team-${t.teamId}.json missing`);
  }
  console.log(`${failures ? "…" : "✓"} teams.json: ${teamsList.length} teams`);
}
for (const file of allFiles.filter((f) => /^team-[a-z0-9-]+\.json$/.test(f) && !/-v\d+\.json$/.test(f))) {
  const c = (cond, msg) => check(file, cond, msg);
  const d = JSON.parse(readFileSync(join(here, file), "utf8"));
  c(exactKeys(d, ["team", "versions"]), "detail keys { team, versions }");
  checkTeamConfig(c, d.team, "team");
  const sum = teamsList.find((t) => t.teamId === d.team.teamId);
  c(!!sum && sum.version === d.team.version && sum.name === d.team.name, "matches teams.json");
  c(d.versions[0] && d.versions[0].version === d.team.version, "versions newest first, latest = team");
  c(d.versions.every((v, i) => exactKeys(v, ["version", "versionLabel", "note", "createdAt", "runCount"]) && (i === 0 || v.version === d.versions[i - 1].version - 1)), "TeamVersionSummary shape and order");
  c(!sum || sum.runCount === d.versions.reduce((a, v) => a + v.runCount, 0), "runCount = sum over versions");
  c(!sum || !sum.templateId || sum.templateId === (d.team.templateId || "product-squad"), "summary templateId = team templateId");
  for (const v of d.versions) {
    const vf = `team-${d.team.teamId}-v${v.version}.json`;
    c(allFiles.includes(vf), `${vf} missing`);
    if (!allFiles.includes(vf)) continue;
    const cfg = JSON.parse(readFileSync(join(here, vf), "utf8"));
    checkTeamConfig((cond, msg) => check(vf, cond, msg), cfg, vf);
    c(cfg.version === v.version && cfg.note === v.note && cfg.createdAt === v.createdAt, `${vf} matches its version summary`);
  }
  c(JSON.stringify(JSON.parse(readFileSync(join(here, `team-${d.team.teamId}-v${d.team.version}.json`), "utf8"))) === JSON.stringify(d.team), "latest version file = team");
  console.log(`${failures ? "…" : "✓"} ${file}: ${d.team.name}, ${d.versions.length} versions`);
}

// ---------- Templates (GET /api/templates) ----------
{
  const c = (cond, msg) => check("templates.json", cond, msg);
  const list = JSON.parse(readFileSync(join(here, "templates.json"), "utf8"));
  c(Array.isArray(list) && list.length === Object.keys(TEMPLATES).length, "one entry per template");
  for (const t of list) {
    const ref = TEMPLATES[t.templateId];
    c(!!ref, `unknown template ${t.templateId}`);
    if (!ref) continue;
    for (const k of Object.keys(ref)) c(JSON.stringify(t[k]) === JSON.stringify(ref[k]), `${t.templateId}.${k} differs from TEMPLATES`);
    c(exactKeys(t, [...Object.keys(ref), "roles", "sections", "outputName"]), `${t.templateId}: keys`);
    c(JSON.stringify(t.roles) === JSON.stringify(ref.members.map((id) => ROLES[id])), `${t.templateId}: roles = ROLES of its members`);
    c(JSON.stringify(t.sections) === JSON.stringify(OUTPUTS[ref.outputId].sections), `${t.templateId}: sections = OUTPUTS[${ref.outputId}].sections`);
    c(t.outputName === OUTPUTS[ref.outputId].name, `${t.templateId}: outputName`);
  }
  console.log(`${failures ? "…" : "✓"} templates.json: ${list.length} templates`);
}

// ---------- Runs ----------
for (const file of allFiles.filter((f) => f.startsWith("run-"))) {
  const s = JSON.parse(readFileSync(join(here, file), "utf8"));
  const c = (cond, msg) => check(file, cond, msg);

  const hasTeam = "teamConfig" in s;
  const base = hasTeam ? [...RUN_KEYS, ...RUN_TEAM_KEYS] : RUN_KEYS;
  c(base.every((k) => k in s) && Object.keys(s).every((k) => base.includes(k) || RUN_AGENT_KEYS.includes(k)), `RunState keys: ${Object.keys(s).join(",")}`);
  // The team version snapshot drives the rules; legacy runs (no teamConfig) use the built-in HANDOFF_RULES.
  const output = OUTPUTS[s.output];
  c(!!output, `output ${s.output}`);
  const PLAN = output ? output.sections : [];
  const tpl = hasTeam ? templateOf(s.teamConfig) : Object.values(TEMPLATES).find((t) => t.outputId === s.output);
  c(!!tpl && tpl.outputId === s.output, `output ${s.output} is not the team's output`);
  const members = hasTeam ? s.teamConfig.members.map((m) => m.role) : tpl.members;
  const rules = hasTeam ? s.teamConfig.rules : s.output === "work-plan" ? HANDOFF_RULES : rulesFor(tpl, tpl.defaultConsults);
  if (hasTeam) {
    checkTeamConfig(c, s.teamConfig, "teamConfig");
    c(s.teamRef && exactKeys(s.teamRef, ["teamId", "version"]) && s.teamRef.teamId === s.teamConfig.teamId && s.teamRef.version === s.teamConfig.version, "teamRef matches teamConfig");
    c(s.team.name === s.teamConfig.name && s.team.version === s.teamConfig.versionLabel, "team label matches teamConfig");
    c(JSON.stringify(s.guardrails) === JSON.stringify(s.teamConfig.guardrails), "guardrails = teamConfig.guardrails");
    // A fixture team version must be the same as the saved one in team-<id>-v<n>.json.
    const vf = `team-${s.teamRef.teamId}-v${s.teamRef.version}.json`;
    if (allFiles.includes(vf)) c(JSON.stringify(JSON.parse(readFileSync(join(here, vf), "utf8"))) === JSON.stringify(s.teamConfig), `teamConfig equals ${vf}`);
    c(Array.isArray(s.files) && s.files.length <= 5, "files ≤ 5");
    for (const f of s.files) { checkFile(c, f, `file ${f.name}`); c(f.status === "ready", `file ${f.name}: runs only take ready files`); }
  }
  const toolsOf = (r) => hasTeam ? (s.teamConfig.members.find((m) => m.role === r) || { tools: [] }).tools : ROLES[r].tools;
  c(RUN_STATUS.includes(s.status), `status ${s.status}`);
  c(s.repo === null || (typeof s.repo.name === "string" && typeof s.repo.branch === "string"), "repo");
  c(["stopped", "failed"].includes(s.status) ? typeof s.stopReason === "string" : s.stopReason === null, "stopReason only for stopped/failed");
  c(s.status === "drafting_brief" ? s.brief === null : s.brief && exactKeys(s.brief, ["goal", "audience", "assumptions", "outOfScope", "doneWhen"]), "brief");
  c(exactKeys(s.guardrails, ["maxTurns", "maxTokens", "criticRounds", "noProgressTurns"]), "guardrails");
  c(s.activeRole === null || members.includes(s.activeRole), "activeRole");
  c(!isNaN(Date.parse(s.createdAt)), "createdAt");
  c(["running", "completed", "stopped", "failed"].includes(s.status) ? !!s.startedAt : s.startedAt === null, "startedAt");
  c(["completed", "stopped", "failed"].includes(s.status) ? !!s.endedAt : s.endedAt === null, "endedAt");

  // Spans: unique ids, parents exist and come first, depth = parent depth + 1, causal start order.
  const byId = new Map();
  for (const sp of s.spans) {
    c(SPAN_KEYS.every((k) => k in sp) && Object.keys(sp).every((k) => SPAN_KEYS.includes(k) || SPAN_AGENT_KEYS.includes(k)), `span ${sp.id} keys`);
    c(!byId.has(sp.id), `duplicate span id ${sp.id}`);
    c(isRole(sp.role) && members.includes(sp.role), `span ${sp.id} role ${sp.role} is not a team member [${members}]`);
    c(SPAN_KIND.includes(sp.kind) && SPAN_STATUS.includes(sp.status), `span ${sp.id} kind/status`);
    c(sp.kind !== "review" || (sp.role === "C" && ["approved", "sent_back", "running", "failed"].includes(sp.status)), `span ${sp.id}: reviews are by the Critic`);
    c((sp.status === "approved" || sp.status === "sent_back") === (sp.kind === "review" && sp.status !== "running" && sp.status !== "failed"), `span ${sp.id}: approved/sent_back only on reviews`);
    c(sp.sectionId === null || PLAN.some((p) => p.id === sp.sectionId), `span ${sp.id} sectionId`);
    if (sp.parentId === null) c(sp.depth === 0, `span ${sp.id} root depth`);
    else {
      const p = byId.get(sp.parentId);
      c(!!p, `span ${sp.id} parent ${sp.parentId} missing or after child`);
      if (p) {
        c(sp.depth === p.depth + 1, `span ${sp.id} depth`);
        c(sp.startMs >= p.startMs, `span ${sp.id} starts before its parent`);
      }
    }
    c(sp.inputTokens >= 0 && sp.outputTokens >= 0 && sp.durMs >= 0 && sp.startMs >= 0, `span ${sp.id} numbers`);
    // A model span runs on its member's model (MemberConfig.model, or the default).
    if (sp.model !== null) c(sp.model === (hasTeam ? memberModel(s.teamConfig, sp.role) : DEFAULT_MODEL_ID), `span ${sp.id}: model ${sp.model} is not ${sp.role}'s model`);
    byId.set(sp.id, sp);
  }
  const running = s.spans.filter((x) => x.status === "running");
  c(["running", "drafting_brief"].includes(s.status) ? running.length >= 1 : running.length === 0, "running spans only while running");

  // Messages obey the handoff rules (to = role of the spans the message caused).
  for (const m of s.spans.filter((x) => x.kind === "msg")) {
    for (const child of s.spans.filter((x) => x.parentId === m.id && x.role !== m.role)) {
      c(canMessage(m.role, child.role, rules), `msg span ${m.id}: ${m.role} → ${child.role} not allowed by the team's rules`);
    }
    const ask = m.action.match(/^Ask ([^:]+):/);
    if (ask) {
      const to = members.find((id) => ROLES[id].name === ask[1]);
      c(!!to, `msg span ${m.id}: asks "${ask[1]}", who is not on the team`);
      if (to) c(canMessage(m.role, to, rules) && canMessage(to, m.role, rules), `msg span ${m.id}: consult ${m.role} ↔ ${to} not allowed both ways`);
    }
  }
  // Tool spans: the role must have the tool. "GitHub: …" needs github_repo, "Read <file>" needs read_files and an attached file.
  for (const t of s.spans.filter((x) => x.kind === "tool")) {
    if (t.action.startsWith("GitHub")) c(toolsOf(t.role).includes("github_repo") && s.repo, `tool span ${t.id}: ${t.role} has no github_repo tool or no repo`);
    if (/^sample[ -]size\b/i.test(t.action)) {
      c(toolsOf(t.role).includes("sample_size"), `tool span ${t.id}: ${t.role} has no sample_size tool`);
      let req = null, res = null;
      try { req = JSON.parse(t.input); res = JSON.parse(t.output); } catch { /* reported below */ }
      c(req && res, `tool span ${t.id}: input/output are not SampleSizeRequest/SampleSizeResult JSON`);
      if (req && res) {
        c(exactKeys(res, ["perGroup", "total", "alpha", "power", "explanation"]), `tool span ${t.id}: SampleSizeResult keys`);
        const n = expectedPerGroup(req);
        c(res.perGroup === n, `tool span ${t.id}: perGroup ${res.perGroup}, formula says ${n}`);
        c(res.total === 2 * res.perGroup, `tool span ${t.id}: total ≠ 2 × perGroup`);
        c(res.alpha === (req.alpha ?? 0.05) && res.power === (req.power ?? 0.8), `tool span ${t.id}: alpha/power`);
        c(t.model === null && t.inputTokens === 0 && t.outputTokens === 0, `tool span ${t.id}: the calculator is code, no model call`);
        // Every source that quotes the calculator must quote these numbers.
        for (const sec of s.sections) for (const src of sec.sources) if (/^sample[ -]size\b/i.test(src)) {
          c(src.includes(res.perGroup.toLocaleString("en-US")) && src.includes(res.total.toLocaleString("en-US")), `section ${sec.id}: source "${src}" doesn't match the calculator`);
        }
      }
    }
    if (t.action.startsWith("Read ")) {
      c(toolsOf(t.role).includes("read_files"), `tool span ${t.id}: ${t.role} has no read_files tool`);
      c(hasTeam && s.files.some((f) => t.action === `Read ${f.name}`), `tool span ${t.id}: "${t.action}" names no attached file`);
    }
  }
  // Sources that cite a file name an attached file.
  for (const sec of s.sections) for (const src of sec.sources) {
    const m = src.match(/^File: (\S+)/);
    if (m) c(hasTeam && s.files.some((f) => f.name === m[1]), `section ${sec.id}: source cites unknown file ${m[1]}`);
  }

  // Sections follow WORK_PLAN; consults are two-way allowed; derived fields agree with spans.
  c(s.sections.length === PLAN.length && s.sections.every((sec, i) => sec.id === PLAN[i].id), `section ids must be OUTPUTS[${s.output}].sections`);
  s.sections.forEach((sec, i) => {
    const p = PLAN[i];
    if (!p) return;
    c(exactKeys(sec, SECTION_KEYS), `section ${sec.id} keys`);
    c(sec.id === p.id && sec.name === p.name && sec.owner === p.owner && sec.consults.every((r) => p.consults.includes(r)), `section ${sec.id} matches the ${output.name} plan`);
    c(members.includes(sec.owner), `section ${sec.id}: owner ${sec.owner} not on the team`);
    c(SECTION_STATUS.includes(sec.status), `section ${sec.id} status`);
    const eff = effectiveConsults(p, rules);
    for (const r of sec.consulted) c(eff.includes(r), `section ${sec.id} consulted ${r}, but the team's rules allow only [${eff}]`);
    const mine = s.spans.filter((x) => x.sectionId === sec.id);
    c(JSON.stringify(sec.spanIds) === JSON.stringify(mine.map((x) => x.id)), `section ${sec.id} spanIds`);
    c(sec.tokens === mine.reduce((a, x) => a + x.inputTokens + x.outputTokens, 0), `section ${sec.id} tokens`);
    const sentBack = mine.filter((x) => x.kind === "review" && x.status === "sent_back").length;
    c(sec.reviews.filter((r) => r.verdict === "sent_back").length === sentBack, `section ${sec.id} reviews vs sent_back spans`);
    c(sentBack <= s.guardrails.criticRounds, `section ${sec.id} exceeds criticRounds`);
    for (const r of sec.reviews) c(typeof r.note === "string" && Array.isArray(r.before) && r.round >= 1, `section ${sec.id} review shape`);
    const approvedSpan = mine.some((x) => x.kind === "review" && x.status === "approved");
    c((sec.status === "approved") === approvedSpan, `section ${sec.id} approved status vs spans`);
  });

  // Totals are always derived from spans. Turns = model calls (spans with a model).
  const t = s.totals;
  const exp = {
    turns: s.spans.filter((x) => x.model !== null).length,
    inputTokens: s.spans.reduce((a, x) => a + x.inputTokens, 0),
    outputTokens: s.spans.reduce((a, x) => a + x.outputTokens, 0),
    sectionsApproved: s.sections.filter((x) => x.status === "approved").length,
    reviewRoundsUsed: s.spans.filter((x) => x.kind === "review" && x.status === "sent_back").length
  };
  c(exactKeys(t, Object.keys(exp)), "totals keys");
  for (const k of Object.keys(exp)) c(t[k] === exp[k], `totals.${k} = ${t[k]}, spans say ${exp[k]}`);
  c(t.turns <= s.guardrails.maxTurns && t.inputTokens + t.outputTokens <= s.guardrails.maxTokens, "within guardrails");
  for (const q of s.openQuestions) c(typeof q.question === "string" && isRole(q.raisedBy), "openQuestions shape");

  // Member agents: agent names, delivered messages, memories used, reflections.
  const hasAgents = "memberAgents" in s || s.spans.some((x) => SPAN_AGENT_KEYS.some((k) => k in x));
  let agentNote = "";
  if (hasAgents) {
    c(hasTeam, "member-agent fields need teamRef (the agent name is derived from the team id)");
    const teamId = hasTeam ? s.teamRef.teamId : "";
    c(s.memberAgents && exactKeys(s.memberAgents, members) && members.every((r) => s.memberAgents[r] === memberAgentName(teamId, r)), "memberAgents = memberAgentName(teamId, role) for every member");
    for (const sp of s.spans) {
      if (sp.model !== null) c(sp.agent === memberAgentName(teamId, sp.role), `span ${sp.id}: model span agent ${sp.agent} ≠ ${memberAgentName(teamId, sp.role)}`);
      else c(sp.agent === null || sp.agent === undefined || sp.agent === memberAgentName(teamId, sp.role), `span ${sp.id}: agent ${sp.agent} doesn't match its role`);
      if (sp.delivered) {
        c(sp.kind === "msg", `span ${sp.id}: delivered only on msg spans`);
        c(exactKeys(sp.delivered, ["to", "kind"]) && members.includes(sp.delivered.to) && INBOX_KINDS.includes(sp.delivered.kind), `span ${sp.id}: delivered shape ${JSON.stringify(sp.delivered)}`);
        c(canMessage(sp.role, sp.delivered.to, rules), `span ${sp.id}: delivered ${sp.role} → ${sp.delivered.to} breaks the team's handoff rules`);
        const child = s.spans.find((x) => x.parentId === sp.id && x.role !== sp.role);
        c(!child || child.role === sp.delivered.to, `span ${sp.id}: delivered to ${sp.delivered.to} but ${child && child.role} answered`);
      } else if (sp.kind === "msg") c(false, `span ${sp.id}: msg span without delivered`);
      if (sp.memoriesUsed !== undefined) {
        c(Array.isArray(sp.memoriesUsed) && sp.memoriesUsed.length <= 5 && new Set(sp.memoriesUsed).size === sp.memoriesUsed.length, `span ${sp.id}: memoriesUsed ≤ 5 unique ids`);
        c(!!sp.agent, `span ${sp.id}: memoriesUsed on a span without an agent`);
        const mf = `member-${teamId}-${sp.role}.json`;
        const view = allFiles.includes(mf) ? JSON.parse(readFileSync(join(here, mf), "utf8")) : null;
        if (sp.memoriesUsed.length) c(!!view, `span ${sp.id}: ${mf} missing`);
        for (const id of sp.memoriesUsed) {
          const mem = view && view.memories.find((m) => m.id === id);
          c(!!mem, `span ${sp.id}: memory ${id} not in ${mf}`);
          if (mem) c(Date.parse(mem.createdAt) <= Date.parse(s.createdAt) + sp.startMs, `span ${sp.id}: uses memory ${id} created after the span started`);
        }
      }
    }
    const reflections = s.spans.filter((x) => x.action === "Reflect on the run");
    const per = {};
    for (const r of reflections) {
      per[r.role] = (per[r.role] || 0) + 1;
      c(r.kind === "work" && r.model !== null && r.sectionId === null, `span ${r.id}: reflection is a model "work" span with no section`);
    }
    for (const [r, n] of Object.entries(per)) c(n <= 1, `${n} reflection spans for ${r} (max 1 per member)`);
    c(!reflections.length || s.status === "completed", "reflections only after a completed run");
    const used = s.spans.reduce((a, x) => a + ((x.memoriesUsed || []).length), 0);
    agentNote = `, agents ✓, ${s.spans.filter((x) => x.delivered).length} delivered, ${used} memories used, ${reflections.length} reflections`;
  }
  console.log(`${failures ? "…" : "✓"} ${file}: ${s.status}, ${s.spans.length} spans, ${t.turns} turns, ${exp.inputTokens + exp.outputTokens} tokens, ${hasTeam ? `team ${s.teamRef.teamId} v${s.teamRef.version}, ${plural(s.files.length, "file")}` : "legacy run (no teamConfig)"}${agentNote}`);
}
// ---------- Member agents: GET /api/teams/<id>/members and …/members/<role> ----------
function checkMemberView(c, v, teamId, role, where) {
  c(exactKeys(v, MEMBER_VIEW_KEYS), `${where}: MemberView keys`);
  c(v.agentName === memberAgentName(teamId, role) && v.teamId === teamId && v.role === role, `${where}: agentName/teamId/role`);
  c(exactKeys(v.stats, ["runs", "turns", "inputTokens", "outputTokens", "lastActiveAt"]) && ["runs", "turns", "inputTokens", "outputTokens"].every((k) => Number.isInteger(v.stats[k]) && v.stats[k] >= 0), `${where}: stats`);
  c(v.stats.lastActiveAt === null || !isNaN(Date.parse(v.stats.lastActiveAt)), `${where}: lastActiveAt`);
  c(Array.isArray(v.memories) && v.memories.length <= 100, `${where}: memories ≤ 100`);
  c(new Set(v.memories.map((m) => m.id)).size === v.memories.length, `${where}: memory ids unique`);
  v.memories.forEach((m, i) => {
    c(exactKeys(m, ["id", "kind", "text", "runId", "teamVersion", "sectionId", "createdAt"]), `${where}: memory ${m.id} keys`);
    c(MEMORY_KINDS.includes(m.kind) && typeof m.text === "string" && m.text.length > 0 && m.text.length <= 300, `${where}: memory ${m.id} kind/text`);
    c(Number.isInteger(m.teamVersion) && m.teamVersion >= 1 && !isNaN(Date.parse(m.createdAt)), `${where}: memory ${m.id} version/date`);
    c(i === 0 || (v.memories[i - 1].createdAt >= m.createdAt && v.memories[i - 1].id > m.id), `${where}: memories newest first`);
  });
  c(Array.isArray(v.recentInbox) && v.recentInbox.length <= 20, `${where}: recentInbox ≤ 20`);
  for (const m of v.recentInbox) c(exactKeys(m, ["id", "runId", "from", "kind", "text", "spanId", "createdAt"]) && INBOX_KINDS.includes(m.kind) && m.text.length <= 2000, `${where}: inbox ${m.id} shape`);
}
for (const file of allFiles.filter((f) => /^members-[a-z0-9-]+\.json$/.test(f))) {
  const c = (cond, msg) => check(file, cond, msg);
  const teamId = file.slice(8, -5);
  const team = JSON.parse(readFileSync(join(here, `team-${teamId}.json`), "utf8")).team;
  const list = JSON.parse(readFileSync(join(here, file), "utf8"));
  c(Array.isArray(list) && JSON.stringify(list.map((v) => v.role)) === JSON.stringify(team.members.map((m) => m.role)), "one MemberView per latest member, in team order");
  let n = 0;
  for (const v of list) {
    checkMemberView(c, v, teamId, v.role, v.role);
    c(v.memories.length <= 5, `${v.role}: the list carries ≤ 5 memories`);
    const df = `member-${teamId}-${v.role}.json`;
    if (allFiles.includes(df)) {
      const d = JSON.parse(readFileSync(join(here, df), "utf8"));
      checkMemberView((cond, msg) => check(df, cond, msg), d, teamId, v.role, df);
      c(JSON.stringify(d.stats) === JSON.stringify(v.stats), `${v.role}: stats differ from ${df}`);
      c(JSON.stringify(d.memories.slice(0, 5)) === JSON.stringify(v.memories), `${v.role}: list memories ≠ newest 5 of ${df}`);
      // Every memory tied to a fixture run comes from that run's team.
      for (const m of d.memories) {
        const rf = allFiles.filter((f) => f.startsWith("run-")).map((f) => JSON.parse(readFileSync(join(here, f), "utf8"))).find((r) => r.runId === m.runId);
        if (rf) c(rf.teamRef && rf.teamRef.teamId === teamId && rf.teamRef.version === m.teamVersion, `${df}: memory ${m.id} run ${m.runId} is not this team's v${m.teamVersion}`);
      }
    }
    n += v.memories.length;
  }
  console.log(`${failures ? "…" : "✓"} ${file}: ${list.length} agents, ${n} memories in the list`);
}
if (failures) { console.error(`${failures} problem(s)`); process.exit(1); }
console.log("All fixtures match the contract.");
