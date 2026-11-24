// Generates public/fixtures/*.json: run states (run-*.json), the teams list (teams.json) and team details
// (team-<id>.json = GET /api/teams/<id>, team-<id>-v<n>.json = GET /api/teams/<id>/versions/<n>).
// Totals are always derived from spans. Usage (from the project root): node public/fixtures/make-fixtures.mjs public/fixtures
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = process.argv[2] || new URL(".", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"; // DEFAULT_MODEL_ID in src/contract.ts
const CRITIC_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // a large model, given to the Critic in squad v3
const CREATED = "2026-11-24T09:12:00.000Z";
const REPO = { name: "example-org/field-notes-app", branch: "main" };
const TASK = "Plan the launch of offline mode for our field-notes app. Target: beta by end of Q1. The team is 4 engineers and 1 designer.";

const brief = {
  goal: "Ship an offline mode beta of the field-notes app by the end of Q1, with sync that never loses a note.",
  audience: "The team's engineering and design leads.",
  assumptions: "4 engineers and 1 designer. The linked repository (example-org/field-notes-app, main) shows how sync works today.",
  outOfScope: "Pricing changes and tablet layouts.",
  doneWhen: "All 7 reviewed sections are approved by the Critic, and anything unresolved is listed under Open questions."
};

const PLAN = [
  { id: "goal", name: "Goal", owner: "PL", consults: [], guidance: "One or two sentences: the outcome and the deadline." },
  { id: "scope", name: "Scope and non-goals", owner: "D", consults: ["R"], guidance: "What is in scope, and explicit non-goals." },
  { id: "milestones", name: "Milestones", owner: "D", consults: ["E"], guidance: "3–5 milestones that each ship user value." },
  { id: "owners", name: "Owners", owner: "PL", consults: [], guidance: "Who owns what. Use [PLACEHOLDER] names, never invent people." },
  { id: "timeline", name: "Timeline", owner: "E", consults: ["D"], guidance: "Phases with rough dates up to the deadline." },
  { id: "risks", name: "Risks", owner: "E", consults: ["R"], guidance: "Top risks, each with a likelihood and a concrete mitigation." },
  { id: "deps", name: "Dependencies", owner: "R", consults: ["E"], guidance: "Things that must happen or be decided first." },
  { id: "open", name: "Open questions", owner: "PL", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];

const CONTENT = {
  goal: ["Ship an offline mode beta of the field-notes app by the end of Q1.", "Field users can capture and edit notes with no signal, and sync never loses a note."],
  scope: ["In scope: create, edit and delete notes offline; queue photo attachments; sync on reconnect.", "In scope: a clear offline indicator and a per-note sync status.", "Non-goals: tablet layouts, pricing changes, offline search across shared notebooks."],
  milestones: ["1 · Local storage layer: notes and photos are saved on the device first.", "2 · Sync with per-field conflict merge, behind a feature flag.", "3 · Offline indicator and sync status in the UI.", "4 · Closed beta with [BETA GROUP SIZE] field users."],
  owners: ["Overall: [PRODUCT OWNER].", "Sync and storage: [ENGINEERING LEAD].", "Offline states and messaging: [DESIGNER].", "Beta recruitment and feedback: [RESEARCH LEAD]."],
  timeline: ["Weeks 1–3: local storage layer and migration of existing notes.", "Weeks 4–7: sync and conflict merge, with a conflict test suite.", "Weeks 8–9: offline UI states and internal dogfood.", "Weeks 10–12: closed beta, fixes, go/no-go by end of Q1."],
  risksV1: ["Sync conflicts may overwrite edits made on two devices. Likelihood: high.", "Storage limits on older phones. Likelihood: medium.", "Scope creep into tablet layouts. Likelihood: low."],
  risks: ["Sync conflicts may overwrite edits made on two devices. Likelihood: high. Mitigation: merge per field, keep both versions when a merge fails, and pass a conflict test suite before beta.", "Storage limits on older phones. Likelihood: medium. Mitigation: cap the photo cache and warn the user before it fills.", "Scope creep into tablet layouts. Likelihood: low. Mitigation: listed as a non-goal; Product lead rejects tablet tickets until after beta."],
  deps: ["Choose the on-device database before the local storage work starts (the repo has no local store today).", "Background sync permissions on iOS and Android.", "The note ID format must become client-generated before offline creates can sync."],
  open: ["Should conflicted notes show both versions to the user, or merge silently? (raised by Designer)", "Do managed devices need admin controls over offline data? (raised by Researcher)"]
};
const SOURCES_V1 = {
  goal: ["Approved brief"],
  scope: ["Researcher's answer: field use with no signal", "Approved brief: out of scope"],
  milestones: ["Engineer's feasibility answer", "GitHub: src/sync/ on main"],
  owners: ["Approved brief", "Section owners from the section plan"],
  timeline: ["GitHub: repository tree and src/sync/", "Designer's answer: beta timing", "Milestones section"],
  risks: ["GitHub: src/sync/ (last-write-wins, no merge)", "Researcher's answer: field failure modes", "Critic's note, round 1"],
  deps: ["Engineer's answer: technical dependencies", "GitHub: package.json and src/storage/"],
  open: ["Questions raised during the run that no agent could answer"]
};
// ---------- Teams (saved, versioned) ----------
const MEMBERS_V1 = [
  { role: "PL", personality: "Clear and decisive. Keeps scope tight.", responsibleFor: "Writes the brief, assigns sections, assembles the final document.", tools: ["shared_draft", "task_list"] },
  { role: "R", personality: "Evidence first. Always cites sources.", responsibleFor: "Context, user needs, dependencies.", tools: ["read_files", "shared_draft"] },
  { role: "D", personality: "User-centred. Thinks in flows.", responsibleFor: "Scope from the user's side, milestones that ship value.", tools: ["shared_draft"] },
  { role: "E", personality: "Pragmatic. Flags effort and risk early.", responsibleFor: "Timeline, technical risks, feasibility. Reads the code when a public GitHub repo is linked.", tools: ["github_repo", "shared_draft"] },
  { role: "C", personality: "Strict but fair. Has no tools for making things.", responsibleFor: "Reviews every section against the brief.", tools: ["comment"] }
];
const FIXED = [
  { from: "PL", to: "*", what: "Assigns sections" },
  { from: "*", to: "PL", what: "Returns finished sections and open questions" },
  { from: "C", to: "*", what: "Approves or sends a section back" },
  { from: "*", to: "C", what: "Submits a section for review" }
];
const PAIRS = { RD: ["R", "D", "Consult: findings and user needs"], DE: ["D", "E", "Consult: feasibility check"], RE: ["R", "E", "Consult: technical dependencies"] };
const rulesWith = (keys) => [...FIXED, ...keys.flatMap((k) => { const [a, b, what] = PAIRS[k]; return [{ from: a, to: b, what }, { from: b, to: a, what }]; })];
const clone = (x) => JSON.parse(JSON.stringify(x));
function teamVersion(teamId, name, version, note, createdAt, members, consultKeys, guardrails) {
  return { teamId, name, version, versionLabel: `v${version}`, note, createdAt, coordinator: "PL", members: clone(members), rules: rulesWith(consultKeys), guardrails: { ...guardrails } };
}
const G1 = { maxTurns: 60, maxTokens: 120000, criticRounds: 2, noProgressTurns: 5 };
const MEMBERS_V2 = clone(MEMBERS_V1);
MEMBERS_V2.find((m) => m.role === "E").tools = ["github_repo", "read_files", "shared_draft"];
MEMBERS_V2.find((m) => m.role === "R").personality = "Evidence first. Always cites sources, and quotes the uploaded files when they answer the question.";
// v3 runs the Critic on a larger model (MemberConfig.model); everyone else keeps the default.
const MEMBERS_V3 = clone(MEMBERS_V2);
MEMBERS_V3.find((m) => m.role === "C").model = CRITIC_MODEL;
/** The model a member runs on: its MemberConfig.model, or the default. */
const modelOf = (team, role) => ((team.members || []).find((m) => m.role === role) || {}).model || MODEL;
const SQUAD = [
  teamVersion("squad", "Mobile Product Squad", 1, "Copied from the Product squad template", "2026-11-03T10:00:00.000Z", MEMBERS_V1, ["RD", "DE", "RE"], G1),
  teamVersion("squad", "Mobile Product Squad", 2, "Engineer can read uploaded files; Researcher quotes them", "2026-11-12T15:30:00.000Z", MEMBERS_V2, ["RD", "DE", "RE"], { ...G1, maxTokens: 150000 }),
  teamVersion("squad", "Mobile Product Squad", 3, "Turned off the Designer ↔ Engineer consult to save turns; Critic on Llama 3.3 70B", "2026-11-24T08:40:00.000Z", MEMBERS_V3, ["RD", "RE"], { ...G1, maxTokens: 150000 })
];
const MEMBERS_GROWTH_V2 = clone(MEMBERS_V1);
MEMBERS_GROWTH_V2.find((m) => m.role === "R").tools = ["shared_draft"];
MEMBERS_GROWTH_V2.find((m) => m.role === "E").tools = ["shared_draft"];
MEMBERS_GROWTH_V2.find((m) => m.role === "E").responsibleFor = "Timeline, technical risks, feasibility from general knowledge (no code access).";
const GROWTH = [
  teamVersion("growth", "Growth squad", 1, "Copied from the Product squad template", "2026-11-20T12:00:00.000Z", MEMBERS_V1, ["RD", "DE", "RE"], G1),
  // No GitHub and no file readers: New run hides the code step and says nobody can read files.
  teamVersion("growth", "Growth squad", 2, "No code or file access; fewer turns", "2026-11-21T09:00:00.000Z", MEMBERS_GROWTH_V2, ["RD", "DE"], { ...G1, maxTurns: 40, criticRounds: 1 })
];
const FILE_ROADMAP = { fileId: "f_roadmap01", name: "field-notes-roadmap.pdf", mimeType: "application/pdf", bytes: 248_312, chars: 12_480, truncated: false, status: "ready", error: null, createdAt: "2026-11-24T09:11:20.000Z" };
const FILE_INTERVIEWS = { fileId: "f_interviews01", name: "field-interviews.csv", mimeType: "text/csv", bytes: 1_402_118, chars: 60_000, truncated: true, status: "ready", error: null, createdAt: "2026-11-24T09:11:40.000Z" };

const RISKS_NOTE = "Sync conflicts are named as the top risk but there is no mitigation, and no risk has a mitigation at all. The brief says sync must never lose a note.";

// [parent, role, kind, action, why, status, durS, section, in, out, input, output, gapS]
const S = [
  [null, "PL", "work", "Draft the brief", "A run starts with a brief the user approves before anything else happens.", "done", 14.2, null, 1450, 380, "Task: " + TASK, "Brief with goal, audience, assumptions, out of scope and done-when."],
  [1, "PL", "system", "Brief approved by you", "The run waits at the brief checkpoint until you approve it.", "done", 0, null, 0, 0, "Brief v1.", "Approved without edits.", 41],
  [2, "PL", "work", "Split the brief into 8 section tasks", "Matched each section to the member whose role and tools fit it best, using the section plan.", "done", 9.1, null, 1900, 520, "Approved brief and section plan.", "8 section tasks, each with an owner and the roles they may consult."],
  [3, "PL", "msg", "Assign Scope and Milestones to Designer", "Both sections are about what the user experiences, which is the Designer's job.", "done", 0.3, null, 0, 0, "Section tasks: Scope and non-goals, Milestones.", "Message delivered."],
  [3, "PL", "msg", "Assign Timeline and Risks to Engineer", "Timeline and Risks depend on the code, and only the Engineer can read the repository.", "done", 0.3, null, 0, 0, "Section tasks: Timeline, Risks.", "Message delivered."],
  [3, "PL", "msg", "Assign Dependencies to Researcher", "Dependencies is about what must be decided first; the Researcher collects that evidence.", "done", 0.3, null, 0, 0, "Section task: Dependencies.", "Message delivered."],
  [3, "PL", "work", "Draft Goal", "Goal is mine: one or two sentences with the outcome and the deadline from the brief.", "done", 7.4, "goal", 1600, 210, "Brief: goal and done-when.", CONTENT.goal.join("\n")],
  [7, "C", "review", "Review Goal", "Checked against the brief: outcome and deadline both match.", "approved", 5.2, "goal", 1300, 140, "Goal section, version 1.", "Approved, no changes."],
  [4, "D", "msg", "Ask Researcher: what do field users need with no signal?", "Scope should start from real field use. The handoff rules let me consult the Researcher.", "done", 0.4, "scope", 0, 0, "Question for Researcher.", "Question delivered."],
  [9, "R", "work", "Answer Designer: field use with no signal", "Answered from the brief and common patterns for field apps; no uploaded files for this run.", "done", 8.8, "scope", 1700, 450, "Designer's question and the brief.", "Users capture short notes and photos in bursts, often for hours without signal, then sync at the end of the day. Losing a note is the top complaint."],
  [4, "D", "work", "Draft Scope and non-goals", "Framed scope around what a field user needs with no signal, using the Researcher's answer.", "done", 15.6, "scope", 2100, 640, "Brief and Researcher's answer.", CONTENT.scope.join("\n")],
  [11, "C", "review", "Review Scope and non-goals", "Checked against the brief: out-of-scope items and audience match.", "approved", 6.1, "scope", 1500, 160, "Scope section, version 1.", "Approved, no changes."],
  [4, "D", "msg", "Ask Engineer: is conflict-safe sync feasible by end of Q1?", "The sync milestone depends on it. The handoff rules allow a Designer → Engineer feasibility check.", "done", 0.4, "milestones", 0, 0, "Question for Engineer.", "Question delivered."],
  [13, "E", "tool", "GitHub: read src/sync/ on main", "Needed to see how sync handles conflicts today before answering.", "done", 3.4, "milestones", 0, 0, "example-org/field-notes-app @ main, src/sync/", "4 files. sync.ts uses last-write-wins on the whole note; no merge logic; note IDs are assigned by the server."],
  [13, "E", "work", "Answer Designer: sync feasibility", "Sized the work from the repository: a per-field merge is feasible in about 4 weeks.", "done", 10.2, "milestones", 3800, 420, "Designer's question and the sync module.", "Feasible by end of Q1 if merge is per field and behind a flag. Today the app uses last-write-wins, so conflicts silently drop edits."],
  [4, "D", "work", "Draft Milestones", "Each milestone ships something a field user notices, in the order the Engineer said is feasible.", "done", 14.8, "milestones", 2300, 590, "Engineer's answer and the scope section.", CONTENT.milestones.join("\n")],
  [16, "C", "review", "Review Milestones", "4 milestones, each ships user value, and the beta lands inside Q1.", "approved", 6.0, "milestones", 1600, 150, "Milestones section, version 1.", "Approved, no changes."],
  [5, "E", "msg", "Ask Designer: can the beta start in early March?", "The timeline hinges on when the offline UI is ready. Engineer ↔ Designer consults are allowed.", "done", 0.4, "timeline", 0, 0, "Question for Designer.", "Question delivered."],
  [18, "D", "work", "Answer Engineer: beta timing", "Offline UI states depend on local storage, so early March is realistic only if storage lands by week 3.", "done", 7.1, "timeline", 1500, 260, "Engineer's question and the milestones.", "Early March works if storage lands by week 3; I need 2 weeks for offline states after that."],
  [5, "E", "work", "Draft Timeline", "Used the repository findings and the Designer's answer to place 4 phases before the deadline.", "done", 17.9, "timeline", 3400, 700, "Brief, milestones, repository notes, Designer's answer.", CONTENT.timeline.join("\n")],
  [20, "C", "review", "Review Timeline", "Phases cover every milestone and end before the Q1 deadline.", "approved", 5.9, "timeline", 1700, 150, "Timeline section, version 1.", "Approved, no changes."],
  [5, "E", "msg", "Ask Researcher: what breaks offline in field conditions?", "Risks should include field failure modes, not only code risks. Engineer ↔ Researcher consults are allowed.", "done", 0.4, "risks", 0, 0, "Question for Researcher.", "Question delivered."],
  [22, "R", "work", "Answer Engineer: field failure modes", "Listed the failure modes that matter most for long offline sessions.", "done", 9.3, "risks", 1600, 380, "Engineer's question.", "Two devices editing the same note, phones running out of storage from photos, and the OS killing background sync."],
  [5, "E", "work", "Draft Risks", "Built on the conflict findings from the repository and the Researcher's answer.", "done", 15.8, "risks", 2900, 520, "Repository notes, timeline, Researcher's answer.", CONTENT.risksV1.join("\n")],
  [24, "C", "review", "Review Risks", "The section names sync conflicts as the top risk but gives no mitigation. The brief says sync must never lose a note.", "sent_back", 6.8, "risks", 1800, 210, "Risks section, version 1.", "Sent back to Engineer: " + RISKS_NOTE],
  [25, "E", "work", "Revise Risks (round 2)", "Responding to the Critic: added a mitigation to every risk, starting with a per-field merge for conflicts.", "done", 17.2, "risks", 3300, 610, "Critic's note and Risks version 1.", CONTENT.risks.join("\n")],
  [26, "C", "review", "Review Risks (round 2)", "Every risk now has a likelihood and a concrete mitigation; the conflict mitigation protects every note.", "approved", 6.3, "risks", 2000, 150, "Risks section, version 2.", "Approved."],
  [6, "R", "msg", "Ask Engineer: what must land before sync work?", "Dependencies are technical here. Researcher ↔ Engineer consults are allowed.", "done", 0.4, "deps", 0, 0, "Question for Engineer.", "Question delivered."],
  [28, "E", "tool", "GitHub: read package.json and src/storage/", "Checked whether a local database or client-side IDs already exist.", "done", 2.9, "deps", 0, 0, "example-org/field-notes-app @ main: package.json, src/storage/", "No local database dependency. src/storage/ only caches the last 20 notes in memory. IDs come from the API."],
  [28, "E", "work", "Answer Researcher: technical dependencies", "Turned the repository findings into decisions that block local storage and sync.", "done", 8.9, "deps", 3500, 330, "Researcher's question and repository notes.", "Pick an on-device database first; move to client-generated note IDs; confirm background sync permissions on both platforms."],
  [6, "R", "work", "Draft Dependencies", "Combined the Engineer's answer with what the milestones need first.", "done", 14.6, "deps", 2400, 470, "Engineer's answer and milestones.", CONTENT.deps.join("\n")],
  [31, "C", "review", "Review Dependencies", "Each dependency is concrete and tied to a milestone.", "approved", 5.7, "deps", 1500, 140, "Dependencies section, version 1.", "Approved, no changes."],
  [3, "PL", "work", "Draft Owners", "Owners follow the section plan; names stay as placeholders as the guidance requires.", "done", 7.9, "owners", 2200, 230, "Section plan and drafted sections.", CONTENT.owners.join("\n")],
  [33, "C", "review", "Review Owners", "Every area has an owner and no real names were invented.", "approved", 5.1, "owners", 1400, 130, "Owners section, version 1.", "Approved, no changes."],
  [3, "PL", "work", "Collect open questions", "Two questions came up that no agent could answer; they go to Open questions instead of being guessed.", "done", 6.2, "open", 1900, 190, "Questions raised during the run.", CONTENT.open.join("\n")],
  [3, "PL", "work", "Assemble the work plan", "All reviewed sections are approved, so the document can be assembled.", "done", 5.4, null, 4100, 260, "8 sections.", "Work plan assembled: 8 sections, 2 open questions."]
];

// Rows keyed by their position in S (1-based) so a variant can drop, change or insert rows by key.
const ROWS = S.map((r, i) => ({ key: i + 1, row: r }));

// Variant for team v3 (Designer ↔ Engineer consult off) with an uploaded file the Researcher reads.
function v3Rows() {
  const drop = new Set([13, 14, 15, 18, 19]);
  const out = [];
  for (const { key, row } of ROWS) {
    if (drop.has(key)) continue;
    const r = row.slice();
    if (key === 10) {
      // The Researcher reads the uploaded roadmap before answering the Designer.
      out.push({ key: "readScope", row: [9, "R", "tool", "Read field-notes-roadmap.pdf", "The Designer asked about field use; the uploaded roadmap has a field research section.", "done", 1.1, "scope", 0, 0, "field-notes-roadmap.pdf (12,480 chars of Markdown)", "Found 'Field research': 68% of note sessions start with no signal; median offline stretch 3 h 40 min; losing a note is the top complaint in 41 of 52 interviews."] });
      r[4] = "Answered from the uploaded roadmap's field research section.";
      r[11] = "68% of sessions start with no signal and last hours offline (field-notes-roadmap.pdf). Users capture short notes and photos in bursts, then sync at the end of the day. Losing a note is the top complaint.";
    }
    if (key === 16) { r[4] = "Designer ↔ Engineer consults are off in this team version, so the milestones follow the brief and the scope section."; r[10] = "Brief and the scope section."; }
    if (key === 20) {
      out.push({ key: "ghTimeline", row: [5, "E", "tool", "GitHub: read src/sync/ on main", "Needed to see how sync handles conflicts today before placing the phases.", "done", 3.4, "timeline", 0, 0, "example-org/field-notes-app @ main, src/sync/", "4 files. sync.ts uses last-write-wins on the whole note; no merge logic; note IDs are assigned by the server."] });
      r[4] = "Placed 4 phases before the deadline from the repository findings. Designer consults are off in this team version.";
      r[10] = "Brief, milestones, repository notes.";
    }
    if (key === 31) {
      out.push({ key: "readDeps", row: [6, "R", "tool", "Read field-notes-roadmap.pdf", "The roadmap lists platform constraints that decide what must happen first.", "done", 0.9, "deps", 0, 0, "field-notes-roadmap.pdf, section 'Platform constraints'", "iOS background sync is limited to ~30 s windows; Android 14 needs a foreground service for long uploads."] });
      r[10] = "Engineer's answer, milestones and the uploaded roadmap.";
    }
    out.push({ key, row: r });
  }
  return out;
}

function build(rows) {
  const spans = [];
  const idOf = new Map();
  let t = 0;
  rows.forEach(({ key, row }, i) => {
    const [parentKey, role, kind, action, why, status, durS, sectionId, inT, outT, input, output, gapS] = row;
    t += (gapS ?? (i === 0 ? 0 : 0.25)) * 1000;
    const parentId = parentKey ? idOf.get(parentKey) : null;
    if (parentKey && !parentId) throw new Error(`row ${key}: parent ${parentKey} missing`);
    const parent = parentId ? spans[parentId - 1] : null;
    idOf.set(key, i + 1);
    const llm = kind === "work" || kind === "review";
    spans.push({
      id: i + 1, parentId, role, kind, action, why, status,
      startMs: Math.round(t), durMs: Math.round(durS * 1000), depth: parent ? parent.depth + 1 : 0,
      sectionId, inputTokens: inT, outputTokens: outT, model: llm ? MODEL : null,
      input, output, gatewayLogId: llm ? `01JDQ${String(7000 + i * 37).padStart(6, "0")}GW${(i * 7919).toString(36).toUpperCase().padStart(5, "0")}` : null
    });
    t += durS * 1000;
  });
  return spans;
}
const ALL = build(ROWS);
const ALL_V3 = build(v3Rows());

const SOURCES_V3 = {
  ...SOURCES_V1,
  scope: ["Researcher's answer: field use with no signal", "File: field-notes-roadmap.pdf (field research)", "Approved brief: out of scope"],
  milestones: ["Approved brief", "Scope and non-goals section"],
  timeline: ["GitHub: repository tree and src/sync/", "Milestones section"],
  deps: ["Engineer's answer: technical dependencies", "File: field-notes-roadmap.pdf (platform constraints)", "GitHub: package.json and src/storage/"]
};
function sectionsFor(spans, phase, SOURCES = SOURCES_V1) {
  return PLAN.map((p) => {
    const mine = spans.filter((s) => s.sectionId === p.id);
    const drafts = mine.filter((s) => s.kind === "work" && s.role === p.owner && s.status !== "running" && !s.action.startsWith("Answer"));
    const reviews = mine.filter((s) => s.kind === "review" && s.status !== "running");
    const running = mine.some((s) => s.status === "running");
    const lastReview = reviews[reviews.length - 1];
    let status = "pending";
    if (phase === "brief") status = "pending";
    else if (p.id === "open" && drafts.length) status = "open";
    else if (lastReview && lastReview.status === "approved") status = "approved";
    else if (lastReview && lastReview.status === "sent_back") status = running ? "drafting" : drafts.some((d) => d.id > lastReview.id) ? "in_review" : "sent_back";
    else if (drafts.length && !running) status = "in_review";
    else if (mine.length) status = "drafting";
    let content = [];
    if (drafts.length) content = p.id === "risks" ? (drafts.length > 1 ? CONTENT.risks : CONTENT.risksV1) : CONTENT[p.id];
    const consulted = [...new Set(mine.filter((s) => s.role !== p.owner && s.role !== "C" && s.kind === "work").map((s) => s.role))];
    const sentBack = reviews.filter((s) => s.status === "sent_back");
    return {
      ...p, status, rounds: drafts.length, content, consulted,
      sources: drafts.length ? SOURCES[p.id].filter((x) => p.id !== "risks" || drafts.length > 1 || !x.startsWith("Critic")) : [],
      reviews: reviews.map((s, i) => ({
        round: i + 1, verdict: s.status,
        note: s.status === "sent_back" ? RISKS_NOTE : s.output,
        before: s.status === "sent_back" ? CONTENT.risksV1 : []
      })).filter((r) => r.verdict === "sent_back"),
      spanIds: mine.map((s) => s.id),
      tokens: mine.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0)
    };
  });
}

function totals(spans, sections) {
  return {
    turns: spans.filter((s) => s.model !== null).length,
    inputTokens: spans.reduce((a, s) => a + s.inputTokens, 0),
    outputTokens: spans.reduce((a, s) => a + s.outputTokens, 0),
    sectionsApproved: new Set(spans.filter((s) => s.kind === "review" && s.status === "approved").map((s) => s.sectionId)).size,
    reviewRoundsUsed: spans.filter((s) => s.kind === "review" && s.status === "sent_back").length
  };
}

const at = (ms) => new Date(Date.parse(CREATED) + ms).toISOString();

function make({ count, status, stopReason = null, runningLast = false, runningDur, team = SQUAD[0], files = [], legacy = false, v3 = false, title = "Offline mode launch plan", runId, base: baseOverride }) {
  const base = baseOverride || (v3 ? ALL_V3 : ALL);
  const spans = base.slice(0, count ?? base.length).map((s) => ({ ...s, model: s.model && modelOf(team, s.role) }));
  if (runningLast) {
    const last = spans[spans.length - 1];
    last.status = "running";
    last.durMs = runningDur;
    last.outputTokens = 0;
    last.output = "";
    last.gatewayLogId = null;
  }
  const phase = status === "drafting_brief" || status === "awaiting_approval" ? "brief" : "run";
  const sections = sectionsFor(spans, phase, v3 ? SOURCES_V3 : SOURCES_V1);
  const last = spans[spans.length - 1];
  const end = last.startMs + last.durMs;
  const openQ = spans.some((s) => s.sectionId === "open" && s.status === "done")
    ? [{ question: "Should conflicted notes show both versions to the user, or merge silently?", raisedBy: "D" }, { question: "Do managed devices need admin controls over offline data?", raisedBy: "R" }]
    : [];
  const savedTeamFields = legacy ? {} : { teamRef: { teamId: team.teamId, version: team.version }, teamConfig: clone(team), files: clone(files) };
  return {
    runId: runId || "r_" + status.replace(/_/g, "") + "_offline01",
    title,
    task: TASK,
    output: "work-plan",
    team: { name: team.name, version: team.versionLabel },
    repo: REPO,
    ...savedTeamFields,
    status, stopReason,
    brief: status === "drafting_brief" ? null : brief,
    guardrails: { ...team.guardrails },
    sections,
    openQuestions: openQ,
    spans,
    totals: totals(spans, sections),
    activeRole: status === "running" ? last.role : status === "drafting_brief" ? "PL" : null,
    createdAt: CREATED,
    startedAt: phase === "run" ? at(ALL[1].startMs) : null,
    endedAt: TERMINAL.has(status) ? at(end + 300) : null
  };
}
const TERMINAL = new Set(["completed", "stopped", "failed"]);

const fixtures = {
  // Long title = the task text (runs created without a title are named after the task): exercises the one-line header.
  "run-drafting.json": make({ count: 1, status: "drafting_brief", runningLast: true, runningDur: 6200, team: SQUAD[2], v3: true, title: TASK, files: [FILE_ROADMAP] }),
  "run-awaiting.json": make({ count: 1, status: "awaiting_approval", team: SQUAD[2], v3: true, files: [FILE_ROADMAP, FILE_INTERVIEWS] }),
  "run-running.json": make({ count: 26, status: "running", runningLast: true, runningDur: 9400, team: SQUAD[1] }),
  "run-stopped.json": make({ count: 27, status: "stopped", stopReason: "Stopped by you. The run finished its current turn and then stopped.", team: SQUAD[1] }),
  "run-failed.json": make({ count: 15, status: "failed", stopReason: "Model call failed 3 times in a row (Workers AI: 429 Too Many Requests — daily free allowance used up).", team: SQUAD[0] }),
  // Edited team version (v3: Designer ↔ Engineer consult off) and a file read by the Researcher.
  "run-completed.json": make({ status: "completed", team: SQUAD[2], v3: true, files: [FILE_ROADMAP] }),
  // A legacy run from before saved teams: no teamRef/teamConfig/files, the UI falls back to the built-in team.
  "run-legacy.json": make({ status: "completed", legacy: true, runId: "r_legacy_offline01" })
};
// The failed run's last span is a failed model call.
{
  const f = fixtures["run-failed.json"];
  const l = f.spans[f.spans.length - 1];
  l.status = "failed"; l.outputTokens = 0; l.output = "Error: 429 Too Many Requests"; l.durMs = 31000;
  f.endedAt = at(l.startMs + l.durMs + 300);
  f.totals = totals(f.spans, f.sections);
  f.sections = sectionsFor(f.spans, "run");
}

// =====================================================================================
// Research lab template: the ux-research team and its Lab experiment design runs.
// =====================================================================================
/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
function zq(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -zq(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const SS_REQ = { test: "two_proportions", p1: 0.30, p2: 0.36, alpha: 0.05, power: 0.8 };
const SS_N = Math.ceil(((zq(1 - SS_REQ.alpha / 2) + zq(SS_REQ.power)) ** 2) * (SS_REQ.p1 * (1 - SS_REQ.p1) + SS_REQ.p2 * (1 - SS_REQ.p2)) / (SS_REQ.p1 - SS_REQ.p2) ** 2);
const SS_RES = {
  perGroup: SS_N, total: 2 * SS_N, alpha: SS_REQ.alpha, power: SS_REQ.power,
  explanation: `To detect a rise in week-1 retention from 30% to 36% with a two-sided test at α 0.05 and 80% power, each group needs ${SS_N} new users (${2 * SS_N} in total): n = (z0.975 + z0.80)² × (p1(1−p1) + p2(1−p2)) / (p1 − p2)², rounded up.`
};
const SS_SOURCE = `Sample size: ${SS_N.toLocaleString("en-US")} per group, ${(2 * SS_N).toLocaleString("en-US")} total (two proportions, 30% vs 36%, α 0.05, power 0.80)`;

const LAB_TASK = "Design an experiment to test whether an onboarding checklist increases week-1 retention of our note-taking app.";
const LAB_PLAN = [
  { id: "hypothesis", name: "Hypothesis", owner: "PI", consults: [], guidance: "One testable hypothesis with a direction and a null hypothesis." },
  { id: "variables", name: "Variables", owner: "MS", consults: ["DA"], guidance: "Independent, dependent and controlled variables, each with how it is operationalised." },
  { id: "method", name: "Method", owner: "MS", consults: ["ER"], guidance: "Design (e.g. randomised A/B, within-subjects), procedure step by step, duration." },
  { id: "sample", name: "Sample and controls", owner: "MS", consults: ["DA"], guidance: "Who takes part, how they are recruited and assigned, the control condition, and the sample size with its justification." },
  { id: "measurements", name: "Measurements", owner: "DA", consults: ["MS"], guidance: "Each metric with its exact definition, unit, time window and data source." },
  { id: "analysis", name: "Analysis plan", owner: "DA", consults: ["MS"], guidance: "Primary test, significance level, power, how missing data and multiple comparisons are handled, and the decision rule." },
  { id: "ethics", name: "Risks and ethics", owner: "ER", consults: ["MS"], guidance: "Consent, privacy and data retention, possible harms and how they are mitigated, and stop conditions." },
  { id: "open", name: "Open questions", owner: "PI", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];
const LAB_MEMBERS_V1 = [
  { role: "PI", personality: "Rigorous and focused. States the question before the method.", responsibleFor: "Writes the brief, owns the hypothesis, assembles the experiment design.", tools: ["shared_draft", "task_list"] },
  { role: "MS", personality: "Precise. Prefers the simplest design that answers the question.", responsibleFor: "Variables, method, sample and controls.", tools: ["read_files", "shared_draft"] },
  { role: "DA", personality: "Quantitative and sceptical. Names the test and the numbers behind it.", responsibleFor: "Measurements, analysis plan, sample size.", tools: ["sample_size", "read_files", "shared_draft"] },
  { role: "ER", personality: "Protective of participants. Asks who could be harmed and how consent works.", responsibleFor: "Risks and ethics: consent, privacy, harm, data handling.", tools: ["read_files", "shared_draft"] },
  { role: "C", personality: "Strict but fair. Has no tools for making things.", responsibleFor: "Reviews every section against the brief.", tools: ["comment"] }
];
const LAB_MEMBERS_V2 = clone(LAB_MEMBERS_V1);
LAB_MEMBERS_V2.find((m) => m.role === "DA").personality = "Quantitative and sceptical. Always runs the sample-size calculator before quoting a number of participants.";
const LAB_FIXED = [
  { from: "PI", to: "*", what: "Assigns sections" },
  { from: "*", to: "PI", what: "Returns finished sections and open questions" },
  { from: "C", to: "*", what: "Approves or sends a section back" },
  { from: "*", to: "C", what: "Submits a section for review" }
];
const LAB_PAIRS = { MSDA: ["MS", "DA", "Consult: measurement and sample size"], MSER: ["MS", "ER", "Consult: participant risk in the procedure"], DAER: ["DA", "ER", "Consult: data privacy and retention"] };
const labRules = (keys) => [...LAB_FIXED, ...keys.flatMap((k) => { const [a, b, what] = LAB_PAIRS[k]; return [{ from: a, to: b, what }, { from: b, to: a, what }]; })];
function labVersion(version, note, createdAt, members, keys, guardrails) {
  return { teamId: "ux-research", name: "UX Research Team", version, versionLabel: `v${version}`, note, createdAt, templateId: "research-lab", outputId: "lab-experiment", coordinator: "PI", members: clone(members), rules: labRules(keys), guardrails: { ...guardrails } };
}
const LAB = [
  labVersion(1, "Copied from the Research lab template", "2026-11-18T10:00:00.000Z", LAB_MEMBERS_V1, ["MSDA", "MSER", "DAER"], G1),
  labVersion(2, "Data analyst always uses the calculator; Data analyst ↔ Ethics reviewer consult off", "2026-11-23T16:20:00.000Z", LAB_MEMBERS_V2, ["MSDA", "MSER"], G1)
];
const FILE_LAB = { fileId: "f_onbinterviews01", name: "onboarding-interviews.md", mimeType: "text/markdown", bytes: 18_904, chars: 18_311, truncated: false, status: "ready", error: null, createdAt: "2026-11-24T09:11:30.000Z" };
const LAB_BRIEF = {
  goal: "Design a randomised experiment that shows whether an onboarding checklist increases week-1 retention of the note-taking app.",
  audience: "The product and data leads who decide whether to ship the checklist.",
  assumptions: "Week-1 retention is about 30% today. The checklist is built and behind a feature flag. Enough new users sign up each week to fill both groups within a few weeks ([WEEKLY SIGN-UPS]).",
  outOfScope: "Redesigning the onboarding screens; changes to paid acquisition.",
  doneWhen: "All 7 reviewed sections are approved by the Critic, and anything unresolved is listed under Open questions."
};
const SAMPLE_NOTE = "Assignment isn't described: say how new users are randomised and what happens to users who reinstall. The control condition is named but not defined.";
const LAB_CONTENT = {
  hypothesis: ["H1: New users who see the onboarding checklist have higher week-1 retention than new users who don't.", "H0: Week-1 retention is the same with and without the checklist.", "Expected direction: an increase from about 30% to 36% (a 6-point lift), tested two-sided."],
  variables: ["Independent: onboarding checklist shown (treatment) or not shown (control), set by the feature flag at first launch.", "Dependent: week-1 retention = the user opens the app on any day 2–7 after sign-up (from the analytics events table).", "Controlled: app version, sign-up platform and acquisition channel are recorded and balanced by randomisation."],
  method: ["Design: randomised A/B test, between-subjects, 1:1 allocation at first launch.", "Procedure: the flag service assigns each new account; treatment sees the 5-step checklist on the home screen until it is completed or dismissed.", "Duration: enrol until both groups are full, then follow each user for 7 days; no change to the app during the test.", "Participants who see the checklist can dismiss it at any time, as the Ethics reviewer asked."],
  sampleV1: ["Participants: new sign-ups on iOS and Android during the test.", "Control: the current onboarding.", `Sample size: ${SS_N} per group (${2 * SS_N} in total), from the Data analyst's calculation.`],
  sample: ["Participants: every new sign-up on iOS and Android during the test; existing users and staff accounts are excluded.", "Assignment: the flag service randomises each new account 1:1 at first launch, keyed on the account ID, so a reinstall keeps the same group.", "Control: the current onboarding with no checklist and no other change.", `Sample size: ${SS_N} per group, ${2 * SS_N} in total: enough to detect a rise from 30% to 36% at α 0.05 with 80% power (sample-size calculator).`],
  measurements: ["Primary: week-1 retention (yes/no) = at least one app open on days 2–7 after sign-up, from the analytics events table, in each user's local time.", "Secondary: checklist completion rate (treatment only), notes created in week 1 (count).", "Guardrail: uninstalls in week 1 (count), to catch a checklist that annoys users."],
  analysis: ["Primary test: two-sided two-proportion z-test on week-1 retention, α 0.05, power 0.80.", `Analyse when both groups reach ${SS_N} users with 7 days of follow-up; no peeking before that.`, "Missing data: users with no events after day 1 count as not retained; accounts deleted in week 1 are excluded and reported.", "Secondary metrics are reported with Holm-corrected p-values and do not decide the outcome.", "Decision rule: ship the checklist if retention is significantly higher and the uninstall rate is not higher."],
  ethics: ["Consent: covered by the app's terms for product improvement tests; no extra data is collected for the test.", "Privacy: only account IDs and event counts are analysed; the analysis table is deleted 90 days after the decision.", "Harm: low; the checklist can be dismissed. Stop the test if week-1 uninstalls in treatment exceed control by 2 points.", "Participants with accessibility settings on get the same checklist with screen-reader labels."],
  open: ["How many new users sign up per week, so we know how long enrolment takes? (raised by Methods specialist)", "Should users who dismiss the checklist on day 1 be analysed separately? (raised by Data analyst)"]
};
const LAB_SOURCES = {
  hypothesis: ["Approved brief"],
  variables: ["Data analyst's answer: measuring week-1 retention", "onboarding-interviews.md, excerpt"],
  method: ["Ethics reviewer's answer: hiding the checklist from the control group", "Approved brief"],
  sample: ["Data analyst's answer: sample size", SS_SOURCE, "Critic's note, round 1"],
  measurements: ["Variables section", "Approved brief"],
  analysis: [SS_SOURCE, "Measurements section"],
  ethics: ["Method section", "onboarding-interviews.md, excerpt"],
  open: ["Questions raised during the run that no agent could answer"]
};
// [parent, role, kind, action, why, status, durS, section, in, out, input, output, gapS]
const LS = [
  [null, "PI", "work", "Draft the brief", "A run starts with a brief the user approves before anything else happens.", "done", 13.6, null, 1520, 400, "Task: " + LAB_TASK, "Brief with goal, audience, assumptions, out of scope and done-when."],
  [1, "PI", "system", "Brief approved by you", "The run waits at the brief checkpoint until you approve it.", "done", 0, null, 0, 0, "Brief v1.", "Approved without edits.", 35],
  [2, "PI", "work", "Split the brief into 8 section tasks", "Matched each section to its owner in the Lab experiment design plan.", "done", 8.7, null, 1880, 500, "Approved brief and section plan.", "8 section tasks, each with an owner and the roles they may consult."],
  [3, "PI", "msg", "Assign Variables, Method and Sample to Methods specialist", "These sections define what is manipulated and how, which is the Methods specialist's job.", "done", 0.3, null, 0, 0, "Section tasks: Variables, Method, Sample and controls.", "Message delivered."],
  [3, "PI", "msg", "Assign Measurements and Analysis plan to Data analyst", "Metrics and the statistical test belong to the Data analyst.", "done", 0.3, null, 0, 0, "Section tasks: Measurements, Analysis plan.", "Message delivered."],
  [3, "PI", "msg", "Assign Risks and ethics to Ethics reviewer", "Consent, privacy and harm are the Ethics reviewer's responsibility.", "done", 0.3, null, 0, 0, "Section task: Risks and ethics.", "Message delivered."],
  [3, "PI", "work", "Draft Hypothesis", "The hypothesis is mine: one testable statement with a direction and a null.", "done", 7.9, "hypothesis", 1650, 240, "Brief: goal and assumptions.", LAB_CONTENT.hypothesis.join("\n")],
  [7, "C", "review", "Review Hypothesis", "Testable, directional, with a null hypothesis.", "approved", 5.0, "hypothesis", 1320, 140, "Hypothesis section, version 1.", "Approved, no changes."],
  [4, "MS", "tool", "Read onboarding-interviews.md", "The interviews describe what new users do in their first week, which shapes the variables.", "done", 1.0, "variables", 0, 0, "onboarding-interviews.md (18,311 chars of Markdown)", "Found 'First week': 9 of 14 users said they didn't know what to do after the first note; most who stayed had created 3+ notes by day 3."],
  [4, "MS", "msg", "Ask Data analyst: how should week-1 retention be measured?", "The dependent variable needs an exact definition. The handoff rules let me consult the Data analyst.", "done", 0.4, "variables", 0, 0, "Question for Data analyst.", "Question delivered."],
  [10, "DA", "work", "Answer Methods specialist: measuring week-1 retention", "Defined retention from the events the app already logs.", "done", 8.1, "variables", 1600, 380, "Methods specialist's question and the brief.", "Count a user as retained if they open the app on any day 2–7 after sign-up, from the analytics events table, in their local time."],
  [4, "MS", "work", "Draft Variables", "Built the variables from the Data analyst's definition and the interview findings.", "done", 14.2, "variables", 2600, 560, "Brief, Data analyst's answer, interview excerpt.", LAB_CONTENT.variables.join("\n")],
  [12, "C", "review", "Review Variables", "Each variable says how it is operationalised.", "approved", 5.6, "variables", 1500, 150, "Variables section, version 1.", "Approved, no changes."],
  [4, "MS", "msg", "Ask Ethics reviewer: is it a risk to withhold the checklist from the control group?", "The method decides who sees what. Methods specialist ↔ Ethics reviewer consults are allowed.", "done", 0.4, "method", 0, 0, "Question for Ethics reviewer.", "Question delivered."],
  [14, "ER", "work", "Answer Methods specialist: withholding the checklist", "Withholding a new helper is low risk if nothing is taken away; asked that it can be dismissed.", "done", 7.4, "method", 1400, 300, "Methods specialist's question.", "Low risk: the control group keeps today's onboarding. Let treatment users dismiss the checklist, and don't collect anything extra."],
  [4, "MS", "work", "Draft Method", "A between-subjects A/B test is the simplest design that answers the question.", "done", 15.1, "method", 2500, 600, "Brief, variables and the Ethics reviewer's answer.", LAB_CONTENT.method.join("\n")],
  [16, "C", "review", "Review Method", "Design, procedure and duration are all stated.", "approved", 5.8, "method", 1600, 150, "Method section, version 1.", "Approved, no changes."],
  [4, "MS", "msg", "Ask Data analyst: how many new users per group do we need?", "The sample size must be justified. Methods specialist ↔ Data analyst consults are allowed.", "done", 0.4, "sample", 0, 0, "Question for Data analyst.", "Question delivered."],
  [18, "DA", "tool", "Sample size: two proportions, 30% vs 36%", "A sample size must come from a calculation, not a guess; the calculator is my tool.", "done", 0.1, "sample", 0, 0, JSON.stringify(SS_REQ), JSON.stringify(SS_RES)],
  [18, "DA", "work", "Answer Methods specialist: sample size", "Turned the calculator's result into an answer with its assumptions.", "done", 7.2, "sample", 1700, 330, "Methods specialist's question and the sample-size result.", `${SS_N} per group (${2 * SS_N} in total) to detect 30% → 36% at α 0.05 with 80% power, two-sided.`],
  [4, "MS", "work", "Draft Sample and controls", "Used the Data analyst's sample size and the brief's audience.", "done", 13.4, "sample", 2400, 480, "Brief and Data analyst's answer.", LAB_CONTENT.sampleV1.join("\n")],
  [21, "C", "review", "Review Sample and controls", "The section has a sample size but doesn't say how users are assigned or what the control is.", "sent_back", 6.4, "sample", 1700, 200, "Sample and controls, version 1.", "Sent back to Methods specialist: " + SAMPLE_NOTE],
  [22, "MS", "work", "Revise Sample and controls (round 2)", "Responding to the Critic: described assignment, reinstalls, exclusions and the control condition.", "done", 15.9, "sample", 2900, 620, "Critic's note and Sample and controls version 1.", LAB_CONTENT.sample.join("\n")],
  [23, "C", "review", "Review Sample and controls (round 2)", "Assignment, control and a justified sample size are all present.", "approved", 5.9, "sample", 1900, 140, "Sample and controls, version 2.", "Approved."],
  [5, "DA", "work", "Draft Measurements", "Each metric gets a definition, unit, window and source.", "done", 13.8, "measurements", 2300, 520, "Variables section and brief.", LAB_CONTENT.measurements.join("\n")],
  [25, "C", "review", "Review Measurements", "Every metric has a definition, unit, time window and data source.", "approved", 5.5, "measurements", 1600, 140, "Measurements section, version 1.", "Approved, no changes."],
  [5, "DA", "work", "Draft Analysis plan", "Named the test and reused the calculator's numbers so the plan matches the sample.", "done", 15.2, "analysis", 2600, 600, "Measurements and the sample-size result.", LAB_CONTENT.analysis.join("\n")],
  [27, "C", "review", "Review Analysis plan", "Test, α, power, missing data, multiple comparisons and a decision rule are all there.", "approved", 6.0, "analysis", 1800, 150, "Analysis plan, version 1.", "Approved, no changes."],
  [6, "ER", "tool", "Read onboarding-interviews.md", "The interviews might mention what users consider intrusive in onboarding.", "done", 0.8, "ethics", 0, 0, "onboarding-interviews.md, section 'Privacy'", "3 of 14 users disliked prompts that asked for contacts; nobody objected to tips."],
  [6, "ER", "work", "Draft Risks and ethics", "Covered consent, privacy, harm and a stop condition from the method.", "done", 14.4, "ethics", 2500, 560, "Method section and the interview excerpt.", LAB_CONTENT.ethics.join("\n")],
  [30, "C", "review", "Review Risks and ethics", "Consent, retention, harms and stop conditions are covered.", "approved", 5.4, "ethics", 1700, 140, "Risks and ethics, version 1.", "Approved, no changes."],
  [3, "PI", "work", "Collect open questions", "Two questions came up that no agent could answer; they go to Open questions instead of being guessed.", "done", 6.0, "open", 1800, 180, "Questions raised during the run.", LAB_CONTENT.open.join("\n")],
  [3, "PI", "work", "Assemble the experiment design", "All reviewed sections are approved, so the document can be assembled.", "done", 5.1, null, 4000, 240, "8 sections.", "Lab experiment design assembled: 8 sections, 2 open questions."]
];
const LAB_ALL = build(LS.map((row, i) => ({ key: i + 1, row })));
function labSections(spans, phase, { firstTimeSample = false } = {}) {
  return LAB_PLAN.map((p) => {
    const mine = spans.filter((s) => s.sectionId === p.id);
    const drafts = mine.filter((s) => s.kind === "work" && s.role === p.owner && !s.action.startsWith("Answer"));
    const reviews = mine.filter((s) => s.kind === "review");
    const last = reviews[reviews.length - 1];
    let status = "pending";
    if (phase !== "brief") {
      if (p.id === "open" && drafts.length) status = "open";
      else if (last && last.status === "approved") status = "approved";
      else if (last) status = "sent_back";
      else if (drafts.length) status = "in_review";
    }
    const content = !drafts.length ? [] : p.id === "sample" && drafts.length === 1 && !firstTimeSample ? LAB_CONTENT.sampleV1 : LAB_CONTENT[p.id];
    const sentBack = reviews.filter((s) => s.status === "sent_back");
    return {
      ...p, status, rounds: drafts.length, content,
      consulted: [...new Set(mine.filter((s) => s.role !== p.owner && s.role !== "C" && s.kind === "work").map((s) => s.role))],
      sources: drafts.length ? LAB_SOURCES[p.id].filter((x) => sentBack.length || !x.startsWith("Critic")) : [],
      reviews: sentBack.map((s, i) => ({ round: i + 1, verdict: "sent_back", note: SAMPLE_NOTE, before: LAB_CONTENT.sampleV1 })),
      spanIds: mine.map((s) => s.id),
      tokens: mine.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0)
    };
  });
}
function makeLab({ count, status, team = LAB[1], files = [FILE_LAB], runId, base = LAB_ALL, title = "Onboarding checklist experiment", createdAt = CREATED, firstTimeSample = false }) {
  const spans = base.slice(0, count ?? base.length).map((s) => ({ ...s, model: s.model && modelOf(team, s.role) }));
  const phase = status === "awaiting_approval" ? "brief" : "run";
  const sections = labSections(spans, phase, { firstTimeSample });
  const last = spans[spans.length - 1];
  const at = (ms) => new Date(Date.parse(createdAt) + ms).toISOString();
  return {
    runId, title, task: LAB_TASK, output: "lab-experiment",
    team: { name: team.name, version: team.versionLabel }, repo: null,
    teamRef: { teamId: team.teamId, version: team.version }, teamConfig: clone(team), files: clone(files),
    status, stopReason: null, brief: LAB_BRIEF, guardrails: { ...team.guardrails }, sections,
    openQuestions: phase === "run" ? [{ question: "How many new users sign up per week, so we know how long enrolment takes?", raisedBy: "MS" }, { question: "Should users who dismiss the checklist on day 1 be analysed separately?", raisedBy: "DA" }] : [],
    spans, totals: totals(spans, sections), activeRole: null, createdAt,
    startedAt: phase === "run" ? at(base[1].startMs) : null,
    endedAt: TERMINAL.has(status) ? at(last.startMs + last.durMs + 300) : null
  };
}
fixtures["run-lab-completed.json"] = makeLab({ status: "completed", runId: "r_labcompleted_onboard01" });
fixtures["run-lab-awaiting.json"] = makeLab({ count: 1, status: "awaiting_approval", runId: "r_labawaiting_onboard01" });
console.log(`sample size: ${SS_N} per group (z.975 = ${zq(0.975).toFixed(6)}, z.80 = ${zq(0.8).toFixed(6)})`);


const ROLE_NAMES = { PL: "Product lead", R: "Researcher", D: "Designer", E: "Engineer", C: "Critic", PI: "Principal investigator", MS: "Methods specialist", DA: "Data analyst", ER: "Ethics reviewer" };
// =====================================================================================
// Member agents: every member is its own MemberAgent ("<teamId>--<role>") with long-term memory and an inbox.
// The completed squad run and both completed lab runs carry Span.agent / memoriesUsed / delivered and
// RunState.memberAgents; members-<teamId>.json = GET /api/teams/<id>/members, member-<teamId>-<role>.json =
// GET /api/teams/<id>/members/<role>. Memory ids are per agent (each MemberAgent has its own SQLite database).
// =====================================================================================
const agentName = (teamId, role) => `${teamId}--${role}`;
const REFLECT_WHY = "The run ended, so I kept at most two things worth remembering for this team's next runs.";
/** "Collect lessons" (coordinator bookkeeping, no model call) + one "Reflect on the run" per member that worked. */
function reflectionRows(coord, assembleKey, items) {
  const roles = Object.keys(items);
  return [
    { key: "collect", row: [assembleKey, coord, "system", "Collect lessons", "Every member that worked reflects once at the end, so the next run of this team starts from what this one learned.", "done", 0.2, null, 0, 0, `Members that worked: ${roles.join(", ")}.`, `Asked ${roles.length} agents to reflect. Outcomes and the Critic's notes were stored as each section was approved or sent back.`] },
    ...roles.map((r) => ({ key: `reflect-${r}`, row: ["collect", r, "work", "Reflect on the run", REFLECT_WHY, "done", 3.6 + roles.indexOf(r) * 0.3, null, 880 + roles.indexOf(r) * 40, 110,
      "My turns in this run, the Critic's notes on my sections and what I already remember (newest 20 memories).",
      JSON.stringify({ items: items[r].map(([kind, text]) => ({ kind, text })) }, null, 1)] }))
  ];
}
/** Adds the member-agent fields to a run built by make()/makeLab(). uses: action → memory ids. */
function addMemberAgentFields(run, teamId, uses = {}) {
  const roles = run.teamConfig.members.map((m) => m.role);
  run.memberAgents = Object.fromEntries(roles.map((r) => [r, agentName(teamId, r)]));
  const nameToRole = (n) => roles.find((r) => ROLE_NAMES[r] === n);
  for (const sp of run.spans) {
    sp.agent = sp.model !== null ? agentName(teamId, sp.role) : null;
    if (sp.model !== null) sp.memoriesUsed = uses[sp.action] ? uses[sp.action].slice() : [];
    if (sp.kind === "msg") {
      const child = run.spans.find((x) => x.parentId === sp.id && x.role !== sp.role);
      let m, to = child ? child.role : null, kind = "assign";
      if ((m = sp.action.match(/^Ask ([^:]+):/))) { to = nameToRole(m[1]); kind = "question"; }
      else if ((m = sp.action.match(/^Assign .* to (.+)$/))) to = nameToRole(m[1]);
      if (to) sp.delivered = { to, kind };
    }
  }
  // Keep the key order of RunState readable: memberAgents after files.
  return run;
}

// ---------- Memory store ----------
const STORE = {};   // teamId → role → MemoryItem[] (oldest first)
const STATS = {};   // teamId → role → { runs:Set, turns, inputTokens, outputTokens, lastActiveAt }
const INBOX = {};   // teamId → role → InboxMessage[] (oldest first)
const roleStore = (o, teamId, role, init) => ((o[teamId] ||= {})[role] ||= init());
function remember(teamId, role, kind, text, runId, teamVersion, sectionId, createdAt) {
  const list = roleStore(STORE, teamId, role, () => []);
  if (text.length > 300) throw new Error(`memory over 300 chars: ${text}`);
  const item = { id: list.length + 1, kind, text, runId, teamVersion, sectionId, createdAt };
  list.push(item);
  return item.id;
}
/** Earlier activity (before the fixture runs) for squad members. */
function seedStats(teamId, role, runs, turns, inT, outT, last) {
  const s = roleStore(STATS, teamId, role, () => ({ runs: new Set(), turns: 0, inputTokens: 0, outputTokens: 0, lastActiveAt: null }));
  for (let i = 0; i < runs; i++) s.runs.add(`earlier-${i}`);
  s.turns += turns; s.inputTokens += inT; s.outputTokens += outT; s.lastActiveAt = last;
}
/** What a finished run leaves behind: stats, inbox, outcomes + Critic lessons, and the reflection items. */
function absorb(run, teamId, reflections) {
  const t0 = Date.parse(run.createdAt);
  const endOf = (sp) => new Date(t0 + sp.startMs + sp.durMs).toISOString();
  const v = run.teamRef.version;
  for (const sp of run.spans) {
    if (sp.agent) {
      const s = roleStore(STATS, teamId, sp.role, () => ({ runs: new Set(), turns: 0, inputTokens: 0, outputTokens: 0, lastActiveAt: null }));
      s.runs.add(run.runId); s.turns++; s.inputTokens += sp.inputTokens; s.outputTokens += sp.outputTokens;
      if (!s.lastActiveAt || endOf(sp) > s.lastActiveAt) s.lastActiveAt = endOf(sp);
    }
    const box = (role) => roleStore(INBOX, teamId, role, () => []);
    const push = (role, from, kind, text, spanId, createdAt) => { const b = box(role); b.push({ id: b.length + 1, runId: run.runId, from, kind, text: text.slice(0, 2000), spanId, createdAt }); };
    if (sp.delivered) push(sp.delivered.to, sp.role, sp.delivered.kind, sp.input + (sp.action.startsWith("Ask") ? " " + sp.action.replace(/^Ask [^:]+:\s*/, "") : ""), sp.id, endOf(sp));
    const parent = sp.parentId ? run.spans[sp.parentId - 1] : null;
    if (sp.kind === "work" && sp.action.startsWith("Answer") && parent && parent.delivered) push(parent.role, sp.role, "answer", sp.output, sp.id, endOf(sp));
    if (sp.kind === "review" && sp.sectionId) {
      const sec = run.sections.find((x) => x.id === sp.sectionId);
      push(sec.owner, "C", "review", sp.output, sp.id, endOf(sp));
      const name = sec.name;
      if (sp.status === "sent_back") remember(teamId, sec.owner, "lesson", `${name}: ${sp.output.replace(/^Sent back to [^:]+:\s*/, "")}`, run.runId, v, sec.id, endOf(sp));
      if (sp.status === "approved") {
        const rounds = run.spans.filter((x) => x.sectionId === sec.id && x.kind === "review" && x.id <= sp.id).length;
        const gist = (sec.content[0] || "").replace(/\.$/, "");
        remember(teamId, sec.owner, "outcome", `${name}: approved ${rounds === 1 ? "first time" : `after ${rounds} rounds`}. ${gist}.`.slice(0, 300), run.runId, v, sec.id, endOf(sp));
      }
    }
    if (sp.action === "Reflect on the run") {
      for (const [kind, text] of reflections[sp.role] || []) remember(teamId, sp.role, kind, text, run.runId, v, null, endOf(sp));
    }
  }
}
function memberView(teamId, role, { list = false } = {}) {
  const s = (STATS[teamId] || {})[role] || { runs: new Set(), turns: 0, inputTokens: 0, outputTokens: 0, lastActiveAt: null };
  const memories = ((STORE[teamId] || {})[role] || []).slice().reverse().slice(0, list ? 5 : 100);
  const inbox = ((INBOX[teamId] || {})[role] || []).slice().reverse().slice(0, list ? 5 : 20);
  return { agentName: agentName(teamId, role), teamId, role, stats: { runs: s.runs.size, turns: s.turns, inputTokens: s.inputTokens, outputTokens: s.outputTokens, lastActiveAt: s.lastActiveAt }, memories, recentInbox: inbox };
}

// ---------- Squad: memories from an earlier run, then the completed v3 run ----------
const SQUAD_EARLIER = { runId: "r_squad_beta02", v: 2, at: "2026-11-20T14:05:00.000Z" };
const squadSeed = {
  PL: [["note", "The team is 4 engineers and 1 designer; plans have to fit that headcount."]],
  R: [["note", "Field users go hours without signal and sync at the end of the day; losing a note is their top complaint."]],
  D: [["lesson", "Milestones: each milestone must ship something a user notices, not an internal refactor."]],
  E: [["outcome", "Timeline: approved first time. Four phases that end at the deadline, with a test week before beta."]],
  C: [["lesson", "Check that every risk has a mitigation, not only a likelihood."]]
};
for (const [r, items] of Object.entries(squadSeed)) for (const [k, t] of items) remember("squad", r, k, t, SQUAD_EARLIER.runId, SQUAD_EARLIER.v, k === "lesson" && r === "D" ? "milestones" : k === "outcome" ? "timeline" : null, SQUAD_EARLIER.at);
seedStats("squad", "PL", 12, 61, 98_400, 14_200, "2026-11-23T17:02:00.000Z");
seedStats("squad", "R", 12, 30, 51_000, 11_300, "2026-11-23T16:58:00.000Z");
seedStats("squad", "D", 12, 38, 66_200, 17_900, "2026-11-23T16:59:00.000Z");
seedStats("squad", "E", 12, 44, 112_500, 21_600, "2026-11-23T17:00:00.000Z");
seedStats("squad", "C", 12, 92, 148_300, 15_400, "2026-11-23T17:01:00.000Z");

const SQUAD_REFLECT = {
  PL: [["note", "Owners stay as [PLACEHOLDER] names; the Critic approves them first time when every area has one."]],
  R: [["note", "The uploaded roadmap's field research section answers most user-need questions; read it before answering."]],
  D: [["lesson", "When the Engineer consult is off, base milestones on the scope section and the brief's deadline."]],
  E: [["lesson", "Write a concrete mitigation next to every risk in the first draft; the Critic sends back risks without one."], ["note", "The repo's sync uses last-write-wins and server-assigned note IDs."]],
  C: [["lesson", "For offline sync plans, the conflict risk needs a mitigation that protects every note."]]
};
const squadRows = [...v3Rows(), ...reflectionRows("PL", 36, SQUAD_REFLECT)];
const squadDone = addMemberAgentFields(make({ status: "completed", team: SQUAD[2], v3: true, files: [FILE_ROADMAP], base: build(squadRows) }), "squad", {
  "Draft the brief": [1], "Answer Designer: field use with no signal": [1], "Draft Milestones": [1], "Draft Timeline": [1], "Review Risks": [1], "Review Risks (round 2)": [1],
  "Reflect on the run": []
});
// Reflections see the member's memories (the brief's note for PL, etc.).
for (const sp of squadDone.spans) if (sp.action === "Reflect on the run") sp.memoriesUsed = [1];
fixtures["run-completed.json"] = squadDone;
absorb(squadDone, "squad", SQUAD_REFLECT);

// ---------- Lab: the first run with member agents creates memories, the second run uses them ----------
const LAB_REFLECT_1 = {
  PI: [["note", "The product and data leads want a ship / don't-ship decision rule in every experiment design."]],
  MS: [["lesson", "Sample and controls: state the randomisation unit, how reinstalls are handled and the control condition in the first draft."]],
  DA: [["note", "Week-1 retention is about 30%; 961 users per group detect a rise to 36% at α 0.05, power 0.8."]],
  ER: [["lesson", "Tie the stop condition to a guardrail metric (week-1 uninstalls) so it can be checked during the test."]],
  C: [["lesson", "Check Sample and controls for the assignment method and a defined control condition."]]
};
const labRows1 = [...LS.map((row, i) => ({ key: i + 1, row })), ...reflectionRows("PI", 33, LAB_REFLECT_1)];
const labFirst = addMemberAgentFields(makeLab({ status: "completed", runId: "r_labcompleted_onboard01", base: build(labRows1) }), "ux-research", {});
fixtures["run-lab-completed.json"] = labFirst;
absorb(labFirst, "ux-research", LAB_REFLECT_1);
const memId = (role, pred) => { const m = STORE["ux-research"][role].find(pred); if (!m) throw new Error(`no memory for ${role}`); return m.id; };
const firstRun = (m) => m.runId === labFirst.runId;
const M = {
  PIhyp: memId("PI", (m) => firstRun(m) && m.sectionId === "hypothesis"), PInote: memId("PI", (m) => firstRun(m) && m.kind === "note"),
  MSvar: memId("MS", (m) => firstRun(m) && m.sectionId === "variables"), MSmethod: memId("MS", (m) => firstRun(m) && m.sectionId === "method"),
  MSsampleLesson: memId("MS", (m) => firstRun(m) && m.sectionId === "sample" && m.kind === "lesson"), MSsampleOut: memId("MS", (m) => firstRun(m) && m.sectionId === "sample" && m.kind === "outcome"),
  MSreflect: memId("MS", (m) => firstRun(m) && m.sectionId === null),
  DAmeas: memId("DA", (m) => firstRun(m) && m.sectionId === "measurements"), DAanal: memId("DA", (m) => firstRun(m) && m.sectionId === "analysis"), DAnote: memId("DA", (m) => firstRun(m) && m.kind === "note"),
  ERout: memId("ER", (m) => firstRun(m) && m.kind === "outcome"), ERlesson: memId("ER", (m) => firstRun(m) && m.kind === "lesson"),
  Clesson: memId("C", (m) => firstRun(m))
};
// Second run: same task; the Methods specialist remembers last run's send-back and gets Sample and controls approved first time.
const LS2 = LS.map((row, i) => ({ key: i + 1, row: row.slice() })).filter((x) => x.key !== 23 && x.key !== 24);
{
  const r21 = LS2.find((x) => x.key === 21).row;
  r21[4] = "Stated assignment, reinstalls and the control condition up front: my memory of the last run says the Critic sent this section back without them.";
  r21[8] = 2900; r21[9] = 610; r21[10] = "Brief, Data analyst's answer and 3 memories from earlier runs."; r21[11] = LAB_CONTENT.sample.join("\n");
  const r22 = LS2.find((x) => x.key === 22).row;
  r22[4] = "Assignment, control and a justified sample size are all in the first draft."; r22[5] = "approved"; r22[10] = "Sample and controls, version 1."; r22[11] = "Approved, no changes.";
  const r1 = LS2.find((x) => x.key === 1).row; r1[10] = "Task: " + LAB_TASK + "\nFrom earlier runs: 1 note.";
}
const LAB_REFLECT_2 = {
  PI: [["note", "Re-running a design with the same brief takes about 30% fewer turns once members remember the last review."]],
  MS: [["lesson", "Stating assignment and the control in the first draft got Sample and controls approved first time; keep doing it."]],
  DA: [["note", "Reuse the earlier sample-size result when the baseline and lift haven't changed."]],
  ER: [], // the Ethics reviewer reflected but found nothing new worth keeping
  C: [["note", "Sample and controls now arrives with assignment and control defined; review it like any other section."]]
};
const labRows2 = [...LS2, ...reflectionRows("PI", 33, LAB_REFLECT_2)];
const labSecond = addMemberAgentFields(makeLab({ status: "completed", runId: "r_labsecond_onboard02", base: build(labRows2), title: "Onboarding checklist experiment (second run)", createdAt: "2026-11-24T11:40:00.000Z", firstTimeSample: true }), "ux-research", {
  "Draft the brief": [M.PInote], "Split the brief into 8 section tasks": [M.PInote], "Draft Hypothesis": [M.PIhyp],
  "Answer Methods specialist: measuring week-1 retention": [M.DAmeas], "Draft Variables": [M.MSvar],
  "Answer Methods specialist: withholding the checklist": [M.ERlesson], "Draft Method": [M.MSmethod],
  "Answer Methods specialist: sample size": [M.DAnote], "Draft Sample and controls": [M.MSsampleLesson, M.MSreflect, M.MSsampleOut],
  "Review Sample and controls": [M.Clesson], "Draft Measurements": [M.DAmeas, M.DAnote], "Draft Analysis plan": [M.DAanal, M.DAnote],
  "Draft Risks and ethics": [M.ERlesson, M.ERout], "Assemble the experiment design": [M.PInote]
});
for (const sp of labSecond.spans) if (sp.action === "Reflect on the run") sp.memoriesUsed = sp.role === "MS" ? [M.MSsampleLesson, M.MSreflect] : sp.role === "C" ? [M.Clesson] : [];
fixtures["run-lab-second.json"] = labSecond;
absorb(labSecond, "ux-research", LAB_REFLECT_2);

const membersOut = {};
for (const [teamId, roles] of [["squad", SQUAD[2].members.map((m) => m.role)], ["ux-research", LAB[1].members.map((m) => m.role)], ["growth", GROWTH[1].members.map((m) => m.role)]]) {
  membersOut[`members-${teamId}.json`] = roles.map((r) => memberView(teamId, r, { list: true }));
  if (teamId !== "growth") for (const r of roles) membersOut[`member-${teamId}-${r}.json`] = memberView(teamId, r);
}

for (const [name, data] of Object.entries(fixtures)) {
  writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2) + "\n");
  console.log(name, data.spans.length, "spans", JSON.stringify(data.totals));
}

// ---------- Team fixtures ----------
const RUNS_PER_VERSION = { squad: { 1: 2, 2: 7, 3: 4 }, growth: { 1: 0, 2: 0 }, "ux-research": { 1: 1, 2: 2 } };
function versionSummaries(list) {
  return list.slice().reverse().map((t) => ({ version: t.version, versionLabel: t.versionLabel, note: t.note, createdAt: t.createdAt, runCount: RUNS_PER_VERSION[t.teamId][t.version] }));
}
// GET /api/templates: Template + { roles: Role[], sections: SectionPlan[], outputName } (mirrors src/contract.ts TEMPLATES).
const ROLE_DEFS = {
  PL: { id: "PL", name: "Product lead", initials: "PL", color: "#3B5BDB", coordinator: true },
  R: { id: "R", name: "Researcher", initials: "R", color: "#237032", coordinator: false },
  D: { id: "D", name: "Designer", initials: "D", color: "#B02358", coordinator: false },
  E: { id: "E", name: "Engineer", initials: "E", color: "#5F3DC4", coordinator: false },
  C: { id: "C", name: "Critic", initials: "C", color: "#C2410C", coordinator: false },
  PI: { id: "PI", name: "Principal investigator", initials: "PI", color: "#0B7285", coordinator: true },
  MS: { id: "MS", name: "Methods specialist", initials: "MS", color: "#8C5A00", coordinator: false },
  DA: { id: "DA", name: "Data analyst", initials: "DA", color: "#495057", coordinator: false },
  ER: { id: "ER", name: "Ethics reviewer", initials: "ER", color: "#9C36B5", coordinator: false }
};
const roleOf = (m) => ({ ...ROLE_DEFS[m.role], personality: m.personality, responsibleFor: m.responsibleFor, tools: m.tools.slice() });
const SQUAD_PAIR_LIST = Object.values(PAIRS).map(([a, b, what]) => ({ a, b, what }));
const LAB_PAIR_LIST = Object.values(LAB_PAIRS).map(([a, b, what]) => ({ a, b, what }));
const TEMPLATES_OUT = [
  { templateId: "product-squad", name: "Product squad", description: "Product lead (coordinator), Researcher, Designer, Engineer, Critic",
    outputId: "work-plan", coordinator: "PL", members: ["PL", "R", "D", "E", "C"], consultPairs: SQUAD_PAIR_LIST, defaultConsults: SQUAD_PAIR_LIST, guardrails: G1,
    roles: MEMBERS_V1.map(roleOf), sections: PLAN, outputName: "Work plan" },
  { templateId: "research-lab", name: "Research lab", description: "Principal investigator (coordinator), Methods specialist, Data analyst, Ethics reviewer, Critic",
    outputId: "lab-experiment", coordinator: "PI", members: ["PI", "MS", "DA", "ER", "C"], consultPairs: LAB_PAIR_LIST, defaultConsults: LAB_PAIR_LIST, guardrails: G1,
    roles: LAB_MEMBERS_V1.map(roleOf), sections: LAB_PLAN, outputName: "Lab experiment design" }
];
const teamsOut = {
  "teams.json": [
    // Summaries carry templateId/outputId/coordinator/members. "growth" is left without them on purpose, like an
    // older server: the Teams page then reads the team itself (and falls back to the Product squad).
    { teamId: "squad", name: "Mobile Product Squad", version: 3, versionLabel: "v3", updatedAt: SQUAD[2].createdAt, runCount: 13, lastRunAt: "2026-11-24T09:12:00.000Z",
      templateId: "product-squad", outputId: "work-plan", coordinator: "PL", members: ["PL", "R", "D", "E", "C"] },
    { teamId: "ux-research", name: "UX Research Team", version: 2, versionLabel: "v2", updatedAt: LAB[1].createdAt, runCount: 3, lastRunAt: "2026-11-24T09:12:00.000Z",
      templateId: "research-lab", outputId: "lab-experiment", coordinator: "PI", members: ["PI", "MS", "DA", "ER", "C"] },
    { teamId: "growth", name: "Growth squad", version: 2, versionLabel: "v2", updatedAt: GROWTH[1].createdAt, runCount: 0, lastRunAt: null }
  ],
  "team-ux-research.json": { team: LAB[1], versions: versionSummaries(LAB) },
  "templates.json": TEMPLATES_OUT,
  "team-squad.json": { team: SQUAD[2], versions: versionSummaries(SQUAD) },
  "team-growth.json": { team: GROWTH[1], versions: versionSummaries(GROWTH) }
};
for (const t of [...SQUAD, ...GROWTH, ...LAB]) teamsOut[`team-${t.teamId}-v${t.version}.json`] = t;
Object.assign(teamsOut, membersOut);
for (const [name, data] of Object.entries(teamsOut)) {
  writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2) + "\n");
  console.log(name);
}
