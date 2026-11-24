/* Team Agents Kit — shared helpers for the plain-JS pages (loaded by every page before its own inline script).
 *
 * Sections:
 *   1. Contract mirror      — constants and rules copied from src/contract.ts, plus UI-only limits and labels
 *   2. API client and auth  — fetch helpers, sign-in redirect, live run WebSocket, fixture (offline) mode
 *   3. Formatting           — numbers, durations, dates, lists
 *   4. Icons                — static SVG markup
 *   5. DOM helpers          — the h() element builder and small shared components
 *   6. Run and team derivations — what a page shows, derived from a TeamConfig or RunState
 *   7. Page setup           — runs on DOMContentLoaded
 *
 * Security: model output is untrusted. Every dynamic string goes through textContent (via h()), never innerHTML.
 * The only markup injected with innerHTML is the static icon set in section 4. */
"use strict";

// =====================================================================================
// 1. Contract mirror
// Everything in this section mirrors src/contract.ts; keep the two in sync. Pages never hard-code a team's
// roles, coordinator, sections or consult pairs: they derive them from a TeamConfig (or a run's teamConfig/output)
// through the helpers in section 6, falling back to the Product squad for data saved without a template.
// =====================================================================================
const ROLES = {
  PL: { id: "PL", name: "Product lead", initials: "PL", color: "#3B5BDB", coordinator: true, tools: ["shared_draft", "task_list"],
    personality: "Clear and decisive. Keeps scope tight.", responsibleFor: "Writes the brief, assigns sections, assembles the final document." },
  R: { id: "R", name: "Researcher", initials: "R", color: "#237032", coordinator: false, tools: ["read_files", "shared_draft"],
    personality: "Evidence first. Always cites sources.", responsibleFor: "Context, user needs, dependencies." },
  D: { id: "D", name: "Designer", initials: "D", color: "#B02358", coordinator: false, tools: ["shared_draft"],
    personality: "User-centred. Thinks in flows.", responsibleFor: "Scope from the user's side, milestones that ship value." },
  E: { id: "E", name: "Engineer", initials: "E", color: "#5F3DC4", coordinator: false, tools: ["github_repo", "shared_draft"],
    personality: "Pragmatic. Flags effort and risk early.", responsibleFor: "Timeline, technical risks, feasibility. Reads the code when a public GitHub repo is linked." },
  C: { id: "C", name: "Critic", initials: "C", color: "#C2410C", coordinator: false, tools: ["comment"],
    personality: "Strict but fair. Has no tools for making things.", responsibleFor: "Reviews every section against the brief." },
  PI: { id: "PI", name: "Principal investigator", initials: "PI", color: "#0B7285", coordinator: true, tools: ["shared_draft", "task_list"],
    personality: "Rigorous and focused. States the question before the method.", responsibleFor: "Writes the brief, owns the hypothesis, assembles the experiment design." },
  MS: { id: "MS", name: "Methods specialist", initials: "MS", color: "#8C5A00", coordinator: false, tools: ["read_files", "shared_draft"],
    personality: "Precise. Prefers the simplest design that answers the question.", responsibleFor: "Variables, method, sample and controls." },
  DA: { id: "DA", name: "Data analyst", initials: "DA", color: "#495057", coordinator: false, tools: ["sample_size", "read_files", "shared_draft"],
    personality: "Quantitative and sceptical. Names the test and the numbers behind it.", responsibleFor: "Measurements, analysis plan, sample size." },
  ER: { id: "ER", name: "Ethics reviewer", initials: "ER", color: "#9C36B5", coordinator: false, tools: ["read_files", "shared_draft"],
    personality: "Protective of participants. Asks who could be harmed and how consent works.", responsibleFor: "Risks and ethics: consent, privacy, harm, data handling." }
};
const TOOL_LABELS = {
  shared_draft: "Shared draft",
  task_list: "Task list",
  read_files: "Read uploaded files",
  github_repo: "GitHub repository (read-only, public repos)",
  comment: "Comment on draft",
  sample_size: "Sample-size calculator"
};
const WORK_PLAN = [
  { id: "goal", name: "Goal", owner: "PL", consults: [], guidance: "One or two sentences: the outcome and the deadline." },
  { id: "scope", name: "Scope and non-goals", owner: "D", consults: ["R"], guidance: "What is in scope, and explicit non-goals." },
  { id: "milestones", name: "Milestones", owner: "D", consults: ["E"], guidance: "3–5 milestones that each ship user value." },
  { id: "owners", name: "Owners", owner: "PL", consults: [], guidance: "Who owns what. Use [PLACEHOLDER] names, never invent people." },
  { id: "timeline", name: "Timeline", owner: "E", consults: ["D"], guidance: "Phases with rough dates up to the deadline." },
  { id: "risks", name: "Risks", owner: "E", consults: ["R"], guidance: "Top risks, each with a likelihood and a concrete mitigation." },
  { id: "deps", name: "Dependencies", owner: "R", consults: ["E"], guidance: "Things that must happen or be decided first." },
  { id: "open", name: "Open questions", owner: "PL", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];
const LAB_EXPERIMENT = [
  { id: "hypothesis", name: "Hypothesis", owner: "PI", consults: [], guidance: "One testable hypothesis with a direction and a null hypothesis." },
  { id: "variables", name: "Variables", owner: "MS", consults: ["DA"], guidance: "Independent, dependent and controlled variables, each with how it is operationalised." },
  { id: "method", name: "Method", owner: "MS", consults: ["ER"], guidance: "Design (e.g. randomised A/B, within-subjects), procedure step by step, duration." },
  { id: "sample", name: "Sample and controls", owner: "MS", consults: ["DA"], guidance: "Who takes part, how they are recruited and assigned, the control condition, and the sample size with its justification." },
  { id: "measurements", name: "Measurements", owner: "DA", consults: ["MS"], guidance: "Each metric with its exact definition, unit, time window and data source." },
  { id: "analysis", name: "Analysis plan", owner: "DA", consults: ["MS"], guidance: "Primary test, significance level, power, how missing data and multiple comparisons are handled, and the decision rule." },
  { id: "ethics", name: "Risks and ethics", owner: "ER", consults: ["MS"], guidance: "Consent, privacy and data retention, possible harms and how they are mitigated, and stop conditions." },
  { id: "open", name: "Open questions", owner: "PI", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];
const OUTPUTS = {
  "work-plan": { id: "work-plan", name: "Work plan", sections: WORK_PLAN },
  "lab-experiment": { id: "lab-experiment", name: "Lab experiment design", sections: LAB_EXPERIMENT }
};
const DEFAULT_GUARDRAILS = { maxTurns: 60, maxTokens: 120000, criticRounds: 2, noProgressTurns: 5 };
/** The Product squad's default rules; used for legacy runs that carry no teamConfig. */
const HANDOFF_RULES = [
  { from: "PL", to: "*", what: "Assigns sections" },
  { from: "*", to: "PL", what: "Returns finished sections and open questions" },
  { from: "R", to: "D", what: "Consult: findings and user needs" },
  { from: "D", to: "R", what: "Consult: findings and user needs" },
  { from: "D", to: "E", what: "Consult: feasibility check" },
  { from: "E", to: "D", what: "Consult: feasibility check" },
  { from: "R", to: "E", what: "Consult: technical dependencies" },
  { from: "E", to: "R", what: "Consult: technical dependencies" },
  { from: "C", to: "*", what: "Approves or sends a section back" },
  { from: "*", to: "C", what: "Submits a section for review" }
];
const ALLOWED_TOOLS = {
  PL: ["shared_draft", "task_list"],
  R: ["read_files", "shared_draft"],
  D: ["shared_draft", "read_files"],
  E: ["github_repo", "read_files", "shared_draft"],
  C: ["comment"],
  PI: ["shared_draft", "task_list", "read_files"],
  MS: ["read_files", "shared_draft"],
  DA: ["sample_size", "read_files", "shared_draft"],
  ER: ["read_files", "shared_draft"]
};
/** Coordinator → everyone, everyone → coordinator, Critic ↔ everyone. Never editable. */
function fixedRulesFor(coordinator) {
  return [
    { from: coordinator, to: "*", what: "Assigns sections" },
    { from: "*", to: coordinator, what: "Returns finished sections and open questions" },
    { from: "C", to: "*", what: "Approves or sends a section back" },
    { from: "*", to: "C", what: "Submits a section for review" }
  ];
}
const SQUAD_PAIRS = [
  { a: "R", b: "D", what: "Consult: findings and user needs" },
  { a: "D", b: "E", what: "Consult: feasibility check" },
  { a: "R", b: "E", what: "Consult: technical dependencies" }
];
const LAB_PAIRS = [
  { a: "MS", b: "DA", what: "Consult: measurement and sample size" },
  { a: "MS", b: "ER", what: "Consult: participant risk in the procedure" },
  { a: "DA", b: "ER", what: "Consult: data privacy and retention" }
];
const TEMPLATES = {
  "product-squad": {
    templateId: "product-squad", name: "Product squad",
    description: "Product lead (coordinator), Researcher, Designer, Engineer, Critic",
    outputId: "work-plan", coordinator: "PL", members: ["PL", "R", "D", "E", "C"],
    consultPairs: SQUAD_PAIRS, defaultConsults: SQUAD_PAIRS, guardrails: DEFAULT_GUARDRAILS
  },
  "research-lab": {
    templateId: "research-lab", name: "Research lab",
    description: "Principal investigator (coordinator), Methods specialist, Data analyst, Ethics reviewer, Critic",
    outputId: "lab-experiment", coordinator: "PI", members: ["PI", "MS", "DA", "ER", "C"],
    consultPairs: LAB_PAIRS, defaultConsults: LAB_PAIRS, guardrails: DEFAULT_GUARDRAILS
  }
};
/** Teams saved without a templateId are Product squads. */
const DEFAULT_TEMPLATE = "product-squad";
/** Rules for a team = fixed rules for its coordinator + each enabled consult pair in both directions. */
function rulesFor(template, enabled) {
  return [...fixedRulesFor(template.coordinator), ...enabled.flatMap((p) => [{ from: p.a, to: p.b, what: p.what }, { from: p.b, to: p.a, what: p.what }])];
}
/** True if the rules let `from` send a message to `to`. */
function canMessage(from, to, rules = HANDOFF_RULES) {
  if (from === to) return false;
  return rules.some((r) => (r.from === from || r.from === "*") && (r.to === to || r.to === "*"));
}
/** A consult happens only if the rules allow it both ways. */
function effectiveConsults(plan, rules) {
  return (plan.consults || []).filter((r) => canMessage(plan.owner, r, rules) && canMessage(r, plan.owner, rules));
}
/** The Durable Object name of a team member's agent, e.g. "squad--R". */
function memberAgentName(teamId, roleId) { return `${teamId}--${roleId}`; }

/** Workers AI models a member can run on (the UI fields of ModelInfo; engine-only fields such as maxTokens are left out).
 * `verified` = completed a full run with this app; `jsonMode` = accepts a JSON schema. */
const DEFAULT_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", size: "medium", jsonMode: true, verified: true, note: "Default. Reliable JSON; good all-rounder." },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B (4B active)", size: "small", jsonMode: true, verified: false, note: "Mixture-of-experts; cheap per token. Runs with thinking switched off." },
  { id: "@cf/openai/gpt-oss-20b", label: "gpt-oss 20B", size: "small", jsonMode: true, verified: false, note: "Small open-weight reasoning model; always reasons first, so it uses more output tokens." },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B", size: "medium", jsonMode: false, verified: false, note: "Good instruction following." },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", size: "large", jsonMode: true, verified: false, note: "Strongest, but uses the allowance fastest — best kept for the Critic." }
];
const MODEL_SIZE_LABELS = { small: "Small", medium: "Medium", large: "Large" };

// ---- UI-only limits and labels (validation ranges match TeamConfig and POST /api/files in the contract) ----
const GUARDRAIL_FIELDS = [
  { key: "maxTurns", label: "Max turns", min: 10, max: 120, step: 1, unit: "turns", hint: "Model calls for the whole run" },
  { key: "maxTokens", label: "Token budget", min: 10000, max: 300000, step: 1000, unit: "tokens", hint: "Input + output, whole run" },
  { key: "criticRounds", label: "Critic rounds per section", min: 0, max: 3, step: 1, unit: "rounds", hint: "Send-backs before the note is kept" },
  { key: "noProgressTurns", label: "Stop if no progress for", min: 2, max: 20, step: 1, unit: "turns", hint: "Turns that don't move the document" }
];
const TEXT_LIMITS = { name: 60, personality: 300, responsibleFor: 300, note: 200 };
const FILE_TYPES = ["pdf", "docx", "xlsx", "csv", "txt", "md", "html"];
const FILE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;
/** Section ids the Critic never reviews (WORK_PLAN: "Open questions … Not reviewed"). */
const UNREVIEWED_SECTIONS = new Set(["open"]);

const RUN_STATUS = {
  drafting_brief: { label: "Drafting brief", cls: "s-running", pulse: true },
  awaiting_approval: { label: "Waiting for your approval", cls: "s-warn" },
  running: { label: "Running", cls: "s-running", pulse: true },
  completed: { label: "Completed", cls: "s-ok" },
  stopped: { label: "Stopped", cls: "s-err" },
  failed: { label: "Failed", cls: "s-fail" }
};
const SPAN_STATUS = {
  running: { label: "Running", cls: "s-running" },
  done: { label: "Done", cls: "s-ok" },
  approved: { label: "Approved", cls: "s-ok" },
  sent_back: { label: "Sent back", cls: "s-err" },
  failed: { label: "Failed", cls: "s-fail" }
};
const SPAN_KIND = { work: "Agent work", msg: "Message", tool: "Tool call", review: "Review", system: "System" };
const SECTION_STATUS = {
  pending: "Not started", drafting: "Drafting", in_review: "In review", sent_back: "Sent back", approved: "Approved", open: "Open questions"
};
/** Run statuses after which nothing changes any more. */
const TERMINAL = new Set(["completed", "stopped", "failed"]);
const MEMORY_KIND = {
  lesson: { label: "Lesson", cls: "mk-lesson", hint: "From a review note or the agent's own reflection" },
  note: { label: "Note", cls: "mk-note", hint: "A fact the agent chose to keep" },
  outcome: { label: "Outcome", cls: "mk-outcome", hint: "A section it delivered" }
};

// =====================================================================================
// 2. API client and auth
// Every page also works offline with ?fixture=<name> (see apiGet). "empty" and "error" simulate an empty list
// and a failing API.
// =====================================================================================
/** One query-string parameter of the current page, or null. */
function queryParam(name) { return new URLSearchParams(location.search).get(name); }
/** The fixture name when the page runs offline (?fixture=…), else null. */
const FIXTURE = queryParam("fixture");

/** Access control (src/access.ts): an expired or missing session gets 401 on /api/* and /agents/*. Send the user to
 * sign in and come back to this page. Returns a promise that never settles, so pages don't flash an error while navigating. */
let signingIn = false;
function redirectToLogin() {
  if (!signingIn) {
    signingIn = true;
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  return new Promise(() => {});
}
/** fetch() that returns parsed JSON, or throws an Error with `status` and the server's `{ error }` message. */
async function fetchJSON(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { accept: "application/json", ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } });
  } catch (err) {
    throw new Error("Network error: could not reach the server.");
  }
  if (res.status === 401 && !FIXTURE) return redirectToLogin();
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not JSON */ } }
  if (!res.ok) {
    const plain = text && !/^\s*</.test(text) ? text.trim().slice(0, 200) : "";
    const msg = (data && (data.error || data.message)) || plain || res.statusText || "request failed";
    const e = new Error(`HTTP ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  if (data === null) throw new Error("The server returned an empty or non-JSON response.");
  return data;
}
function postJSON(url, body) {
  return fetchJSON(url, { method: "POST", body: JSON.stringify(body || {}) });
}
/** HTTP and WebSocket path of a run's coordinator agent. */
function runPath(runId) { return `/agents/run-agent/${encodeURIComponent(runId)}`; }

/**
 * Live run state over the Agent's WebSocket. Messages of type "cf_agent_state" carry RunState.
 * Reconnects with backoff until close() or until the run reaches a terminal status.
 * onConn(status): "connecting" | "open" | "reconnecting" | "closed".
 */
function connectRun(runId, onState, onConn = () => {}) {
  let ws = null, closed = false, attempt = 0, timer = null, terminal = false;
  function open() {
    if (closed) return;
    onConn(attempt ? "reconnecting" : "connecting");
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${runPath(runId)}`);
    } catch { scheduleReconnect(); return; }
    ws.onopen = () => { attempt = 0; onConn("open"); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && msg.type === "cf_agent_state" && msg.state) {
        terminal = TERMINAL.has(msg.state.status);
        onState(msg.state);
      }
    };
    ws.onclose = () => { ws = null; if (closed) return; if (terminal) { onConn("closed"); return; } scheduleReconnect(); };
    ws.onerror = () => { /* onclose follows */ };
  }
  function scheduleReconnect() {
    attempt++;
    onConn("reconnecting");
    // A WebSocket upgrade refused with 401 looks like any other failure, so after a few failed attempts ask over HTTP.
    if (attempt === 3 || (attempt > 3 && attempt % 5 === 0)) checkAuth(runPath(runId));
    timer = setTimeout(open, Math.min(10000, 800 * 2 ** Math.min(attempt, 4)));
  }
  open();
  return {
    close() { closed = true; clearTimeout(timer); if (ws) ws.close(); },
    retryNow() { if (!ws && !closed) { clearTimeout(timer); open(); } }
  };
}

/** GET a gated path; on 401 go to the sign-in page. Network errors are ignored (the caller keeps retrying). */
async function checkAuth(path) {
  if (FIXTURE) return;
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    if (res.status === 401) redirectToLogin();
  } catch { /* offline: keep retrying */ }
}

/** Internal link that keeps fixture mode. Empty, null and undefined params are left out. */
function appLink(path, params) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined && v !== "") u.searchParams.set(k, String(v));
  if (FIXTURE && !u.searchParams.has("fixture")) u.searchParams.set("fixture", FIXTURE);
  return u.pathname + u.search;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** GET an API path, or its fixture file in fixture mode. */
async function apiGet(path) {
  if (!FIXTURE) return fetchJSON(path);
  await delay(250);
  if (FIXTURE === "error") { const e = new Error("HTTP 500: Simulated server error (fixture)"); e.status = 500; throw e; }
  let m;
  if (path === "/api/teams") return FIXTURE === "empty" ? [] : fetchJSON("/fixtures/teams.json");
  if (path === "/api/templates") return fetchJSON("/fixtures/templates.json");
  if (path === "/api/models") return MODELS.map((x) => ({ ...x }));
  if ((m = path.match(/^\/api\/teams\/([^/]+)$/))) return fetchFixture(`/fixtures/team-${m[1]}.json`);
  if ((m = path.match(/^\/api\/teams\/([^/]+)\/versions\/(\d+)$/))) return fetchFixture(`/fixtures/team-${m[1]}-v${m[2]}.json`);
  if ((m = path.match(/^\/api\/teams\/([^/]+)\/members$/))) return fetchFixture(`/fixtures/members-${m[1]}.json`);
  if ((m = path.match(/^\/api\/teams\/([^/]+)\/members\/([A-Z]+)$/))) return fetchFixture(`/fixtures/member-${m[1]}-${m[2]}.json`);
  throw new Error(`No fixture for ${path}`);
}
/** Fetch a fixture file; a missing file becomes the same 404 error the API would give. */
async function fetchFixture(url) {
  try { return await fetchJSON(url); }
  catch (err) { if (err.status === 404) { const e = new Error("HTTP 404: Not found"); e.status = 404; throw e; } throw err; }
}

/** The model catalog in use: GET /api/models once loaded, else the MODELS mirror above. */
let modelCatalog = MODELS;
let modelsRequest = null;
/** Load GET /api/models once (shared by every caller). Falls back to the mirror on any error, so it never rejects. */
function loadModels() {
  if (!modelsRequest) {
    modelsRequest = apiGet("/api/models")
      .then((list) => {
        if (!Array.isArray(list) || !list.length || !list.every((x) => x && typeof x.id === "string" && typeof x.label === "string")) throw new Error("Unexpected response from /api/models.");
        modelCatalog = list;
      })
      .catch(() => { /* older server or offline: keep the mirror */ })
      .then(() => modelCatalog);
  }
  return modelsRequest;
}

/** Fixture runs by runId, so memory "from run" links open the right fixture offline. */
const FIXTURE_RUN_IDS = {
  r_completed_offline01: "completed", r_labcompleted_onboard01: "lab-completed", r_labsecond_onboard02: "lab-second",
  r_running_offline01: "running", r_stopped_offline01: "stopped", r_failed_offline01: "failed", r_legacy_offline01: "legacy"
};
/** Link to a run page (the matching fixture in fixture mode). */
function runLink(runId) {
  if (!FIXTURE) return appLink("/run.html", { id: runId });
  return appLink("/run.html", { id: runId, fixture: FIXTURE_RUN_IDS[runId] || "completed" });
}

// =====================================================================================
// 3. Formatting
// =====================================================================================
/** Duration as m:ss or h:mm:ss. */
function fmtDur(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const total = Math.floor(ms / 1000), hh = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = (s < 10 ? "0" : "") + s;
  return hh ? `${hh}:${m < 10 ? "0" : ""}${m}:${ss}` : `${m}:${ss}`;
}
/** Short durations with a tenth of a second ("4.2s"), longer ones as fmtDur. */
function fmtPreciseDur(ms) {
  ms = Math.max(0, Number(ms) || 0);
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : fmtDur(ms);
}
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
/** Whole number with thousands separators (token counts, turns, limits). */
function fmtNumber(n) { return NUMBER_FORMAT.format(Math.round(Number(n) || 0)); }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
/** Day and month; the year only when it isn't this year. */
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
function fmtRelative(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return fmtDateTime(iso);
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** "1 turn", "3 turns"; pass `many` for irregular plurals. */
function plural(n, one, many) { return `${n} ${n === 1 ? one : many || one + "s"}`; }
/** Role ids as a comma-separated list of role names. */
function listNames(ids) { return (ids || []).map((id) => roleInfo(id).name).join(", "); }
/** "A", "A and B", "A, B and C". */
function andList(items) { const a = (items || []).map(String); return a.length < 2 ? (a[0] || "") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`; }
/** Run ids are long; shorten them for inline links (the full id goes in the title). */
function shortRunId(runId) { const s = String(runId || ""); return s.length > 22 ? s.slice(0, 20) + "…" : s; }

// =====================================================================================
// 4. Icons (static markup only — never pass data to icon())
// =====================================================================================
const ICONS = {
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  code: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B5B66" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7 3 12l5 5M16 7l5 5-5 5"/></svg>',
  tool: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 21h14"/></svg>',
  calc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>',
  memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z"/></svg>',
  agent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/></svg>',
  inbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M 3 13h5l1 3h6l1-3h5"/><path d="M 5 5h14l2 8v6H3v-6z"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M 5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  chip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>'
};
/** A fresh SVG node for one of the ICONS. */
function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = ICONS[name] || "";
  return t.content.firstChild;
}

// =====================================================================================
// 5. DOM helpers
// =====================================================================================
/** DOM builder: h("div", { class, style, text, onClick, dataset, "aria-x": … }, ...children).
 * Strings and numbers become text nodes (never HTML); null/undefined/false props and children are skipped;
 * arrays of children are flattened. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}
/** Append children to el with the same rules as h(). */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}
/** document.getElementById. */
const $ = (id) => document.getElementById(id);

/** Re-render while keeping keyboard focus on the element with the same data-key. */
function keepFocus(fn) {
  const a = document.activeElement;
  const key = a && a.dataset ? a.dataset.key : null;
  fn();
  if (key) {
    const again = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again && again !== document.activeElement) again.focus({ preventScroll: true });
  }
}

/** Round role badge in the role's colour (decorative: the role name is always shown or announced next to it). */
function avatar(roleId, size = 28, fontSize) {
  const r = roleInfo(roleId);
  const fs = fontSize || (size >= 40 ? 15 : size >= 28 ? 11 : size >= 22 ? 10 : 9);
  return h("span", {
    class: "avatar", "aria-hidden": "true", title: r.name,
    style: `width:${size}px;height:${size}px;background:${r.color};font-size:${fs}px`
  }, r.initials);
}

/** Status pill. opts: sm (small), dot (leading dot), pulse (animated dot). */
function pill(label, cls, opts = {}) {
  return h("span", { class: `pill ${opts.sm ? "sm " : ""}${cls || "s-neutral"}` },
    opts.dot ? h("span", { class: "dot" + (opts.pulse ? " pulse" : ""), "aria-hidden": "true" }) : null, label);
}
function runStatusPill(status, extra) {
  const s = RUN_STATUS[status] || { label: String(status), cls: "s-neutral" };
  return pill(extra ? `${s.label} · ${extra}` : s.label, s.cls, { dot: true, pulse: !!s.pulse });
}
function spanStatusPill(status) {
  const s = SPAN_STATUS[status] || { label: String(status), cls: "s-neutral" };
  return pill(s.label, s.cls, { sm: true });
}
/** Show the live connection state in the page's #conn badge (hidden while connected). */
function connPill(state) {
  const el = $("conn");
  if (!el) return;
  if (state === "reconnecting") { el.hidden = false; el.replaceChildren(pill("Reconnecting…", "s-warn", { dot: true, pulse: true })); }
  else if (state === "connecting") { el.hidden = false; el.replaceChildren(pill("Connecting…", "s-neutral", { dot: true, pulse: true })); }
  else { el.hidden = true; el.replaceChildren(); }
}

function memoryKindBadge(kind) {
  const k = MEMORY_KIND[kind] || { label: String(kind), cls: "", hint: "" };
  return h("span", { class: `mem-kind ${k.cls}`, title: k.hint || null }, k.label);
}
/** A member agent's Durable Object name, monospace. */
function agentTag(name) { return h("code", { class: "agent-name" }, name); }
/** One memory as a list item: kind badge, text, and where it came from. opts.hideRun drops the run link. */
function memoryItem(m, opts = {}) {
  return h("li", { class: "mem-item" },
    h("div", { class: "mem-top" }, memoryKindBadge(m.kind), h("span", { class: "mem-text" }, m.text)),
    h("div", { class: "mem-meta" },
      opts.hideRun ? null : [ "from run ", h("a", { href: runLink(m.runId), title: m.runId }, shortRunId(m.runId)), " · "],
      `v${m.teamVersion} · ${fmtDate(m.createdAt)}`));
}
/** A member's model as a chip: label and size, the model id as a tooltip; unverified models are tinted. */
function modelChip(modelId) {
  const m = modelInfo(modelId);
  return h("span", { class: "model-chip" + (m.verified ? "" : " unverified"), title: m.id },
    icon("chip"), h("span", { class: "sr-only" }, "Model: "), m.label,
    MODEL_SIZE_LABELS[m.size] ? h("span", { class: "sz" }, `· ${MODEL_SIZE_LABELS[m.size].toLowerCase()}`) : null);
}

// =====================================================================================
// 6. Run and team derivations
// =====================================================================================
/** The role's catalog entry; unknown ids get a neutral placeholder so old data still renders. */
function roleInfo(id) {
  return ROLES[id] || { id: String(id), name: String(id || "Unknown"), initials: String(id || "?").slice(0, 2), color: "#495057", tools: [] };
}
/** True if both directions of the consult pair a ↔ b are in the rules. */
function consultPairOn(rules, a, b) {
  return rules.some((r) => r.from === a && r.to === b) && rules.some((r) => r.from === b && r.to === a);
}
/** The template a team (TeamConfig or TeamSummary) was made from. Missing templateId = Product squad. */
function templateOf(cfg) {
  const id = cfg && cfg.templateId;
  if (id && TEMPLATES[id]) return TEMPLATES[id];
  // A team without templateId but with another template's coordinator still gets the right template.
  const coord = cfg && cfg.coordinator;
  const byCoord = coord && Object.values(TEMPLATES).find((t) => t.coordinator === coord);
  return byCoord || TEMPLATES[DEFAULT_TEMPLATE];
}
function templateForOutput(outputId) { return Object.values(TEMPLATES).find((t) => t.outputId === outputId) || TEMPLATES[DEFAULT_TEMPLATE]; }
function outputIdOf(cfg) { const id = cfg && cfg.outputId; return id && OUTPUTS[id] ? id : templateOf(cfg).outputId; }
function outputOf(cfg) { return OUTPUTS[outputIdOf(cfg)]; }
function coordinatorOf(cfg) { return (cfg && cfg.coordinator && ROLES[cfg.coordinator]) ? cfg.coordinator : templateOf(cfg).coordinator; }
/** Member role ids in display order (coordinator first, Critic last). Accepts MemberConfig[] or RoleId[]. */
function teamRoles(cfg) {
  if (cfg && Array.isArray(cfg.members) && cfg.members.length) {
    const ids = cfg.members.map((m) => typeof m === "string" ? m : m.role).filter((id) => ROLES[id]);
    if (ids.length) return ids;
  }
  return templateOf(cfg).members.slice();
}
function fixedRulesOf(cfg) { return fixedRulesFor(coordinatorOf(cfg)); }
function consultPairsOf(cfg) { return templateOf(cfg).consultPairs; }
/** A TeamConfig rebuilt from the template, for legacy runs that carry no teamConfig snapshot. Marked `legacy: true`. */
function legacyTeamConfig(run) {
  const tpl = templateForOutput(run && run.output);
  return {
    teamId: tpl.templateId === DEFAULT_TEMPLATE ? "squad" : tpl.templateId, name: (run && run.team && run.team.name) || "Mobile Product Squad", version: 1,
    versionLabel: (run && run.team && run.team.version) || "v1", note: "", createdAt: "", templateId: tpl.templateId, outputId: tpl.outputId, coordinator: tpl.coordinator,
    members: tpl.members.map((id) => ({ role: id, personality: ROLES[id].personality, responsibleFor: ROLES[id].responsibleFor, tools: ROLES[id].tools.slice() })),
    rules: tpl.templateId === DEFAULT_TEMPLATE ? HANDOFF_RULES.slice() : rulesFor(tpl, tpl.defaultConsults),
    guardrails: (run && run.guardrails) || { ...DEFAULT_GUARDRAILS }, legacy: true
  };
}
/** The MemberConfig of a role in a team, or null. */
function memberOf(cfg, roleId) { return (cfg && cfg.members || []).find((m) => m.role === roleId) || null; }
/** A member's tools; falls back to the role's default tools when the team doesn't list the member. */
function memberTools(cfg, roleId) { const m = memberOf(cfg, roleId); return m ? m.tools : (ROLES[roleId] ? ROLES[roleId].tools : []); }
/** Roles in the team that have a given tool. */
function whoHasTool(cfg, tool) { return teamRoles(cfg).filter((id) => memberTools(cfg, id).includes(tool)); }
/** Sections of a plan that consult along pair a ↔ b. */
function pairSections(sections, p) {
  return sections.filter((s) => (s.owner === p.a && s.consults.includes(p.b)) || (s.owner === p.b && s.consults.includes(p.a)));
}
/** The model a member runs on: its MemberConfig.model, or DEFAULT_MODEL_ID when missing. */
function memberModel(cfg, roleId) { const m = memberOf(cfg, roleId); return (m && m.model) || DEFAULT_MODEL_ID; }
/** ModelInfo for an id from the loaded catalog (or the mirror). Unknown ids get a placeholder named after the id. */
function modelInfo(id) {
  const known = modelCatalog.find((m) => m.id === id) || MODELS.find((m) => m.id === id);
  if (known) return known;
  const short = String(id || "Unknown model").split("/").pop();
  return { id: String(id), label: short, size: "", jsonMode: false, verified: false, note: "" };
}

// ---- Sample-size tool (Data analyst) ----
// Span shape from the engine: kind "tool", role with the sample_size tool, action starting "Sample size", input with the
// SampleSizeRequest JSON and output with the SampleSizeResult JSON ({ perGroup, total, alpha, power, explanation }).
// Plain-text outputs are parsed as a fallback.
function isSampleSizeSpan(sp) { return !!sp && sp.kind === "tool" && /^sample[ -]size\b/i.test(sp.action || ""); }
/** True for a section source line that quotes the calculator. */
function isSampleSizeSource(src) { return /^sample[ -]size\b/i.test(String(src || "")); }
/** The first {...} JSON object embedded in a text, or null. */
function firstJSON(text) {
  if (!text) return null;
  const s = String(text), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
/** { req, res } from a sample-size span; res is null when no result can be read. */
function parseSampleSize(sp) {
  const req = firstJSON(sp.input) || {};
  let res = firstJSON(sp.output);
  if (!res || typeof res.perGroup !== "number") {
    const t = String(sp.output || "");
    const num = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const perGroup = num(/([\d,]+)\s*(?:per group|\/\s*group)/i) ?? num(/per group[^\d]*([\d,]+)/i);
    if (perGroup === null) return { req, res: null };
    res = { perGroup, total: num(/total[^\d]*([\d,]+)/i) ?? num(/([\d,]+)\s*total/i), alpha: num(/(?:α|alpha)\s*[=:]?\s*(0?\.\d+)/i), power: num(/power\s*[=:]?\s*(0?\.\d+)/i), explanation: "" };
  }
  return { req, res };
}

// =====================================================================================
// 7. Page setup
// =====================================================================================
/** Add the icon to the header's "New run" button, and keep fixture mode on the static header links. */
document.addEventListener("DOMContentLoaded", () => {
  const nb = document.getElementById("new-btn");
  if (nb && !nb.querySelector("svg")) nb.prepend(icon("plus"));
  if (!FIXTURE) return;
  document.querySelectorAll(".site-header a[href^='/']:not([href='/logout'])").forEach((a) => a.setAttribute("href", appLink(a.getAttribute("href"))));
});
