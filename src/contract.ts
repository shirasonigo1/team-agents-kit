/**
 * Shared contract between the Worker (src/*) and the UI (public/*.html).
 *
 * The UI is plain JavaScript, so it relies on these shapes exactly as documented here: change a
 * shape only together with the pages that read it. This file has no runtime dependencies, so Node
 * can import it directly (scripts and public/fixtures/check-fixtures.mjs do).
 *
 * Principles the shapes encode:
 * - One role → one id and one colour, everywhere.
 * - Every team has a Critic, and the Critic only comments.
 * - Memory is part of every agent, not a tool.
 * - A consult is ask-and-reply along a handoff rule, so consult rules are always two-way.
 * - On the free plan there is no money cost: meters show tokens and turns. Every total is
 *   derived from the span list, so two screens can never disagree.
 */

// =====================================================================================
// Roles & tools — the global role catalog. A role's id, name and colour never change;
// a team version may change its personality, responsibilities and tools.
// =====================================================================================

/** Product squad: PL, R, D, E. Research lab: PI, MS, DA, ER. The Critic (C) is in every team. */
export type RoleId = "PL" | "R" | "D" | "E" | "C" | "PI" | "MS" | "DA" | "ER";

export type Role = {
  id: RoleId;
  name: string;
  initials: string;
  /** Background colour for the role's chips; white text on it has a contrast of at least 5.5:1. */
  color: string;
  coordinator: boolean;
  personality: string;
  responsibleFor: string;
  /** Default tools (a team version may change them within ALLOWED_TOOLS). */
  tools: ToolId[];
};

export type ToolId = "shared_draft" | "task_list" | "read_files" | "github_repo" | "comment" | "sample_size";

export const TOOL_LABELS: Record<ToolId, string> = {
  shared_draft: "Shared draft",
  task_list: "Task list",
  read_files: "Read uploaded files",
  github_repo: "GitHub repository (read-only, public repos)",
  comment: "Comment on draft",
  sample_size: "Sample-size calculator"
};

export const ROLES: Record<RoleId, Role> = {
  PL: {
    id: "PL", name: "Product lead", initials: "PL", color: "#3B5BDB", coordinator: true,
    personality: "Clear and decisive. Keeps scope tight.",
    responsibleFor: "Writes the brief, assigns sections, assembles the final document.",
    tools: ["shared_draft", "task_list"]
  },
  R: {
    id: "R", name: "Researcher", initials: "R", color: "#237032", coordinator: false,
    personality: "Evidence first. Always cites sources.",
    responsibleFor: "Context, user needs, dependencies.",
    tools: ["read_files", "shared_draft"]
  },
  D: {
    id: "D", name: "Designer", initials: "D", color: "#B02358", coordinator: false,
    personality: "User-centred. Thinks in flows.",
    responsibleFor: "Scope from the user's side, milestones that ship value.",
    tools: ["shared_draft"]
  },
  E: {
    id: "E", name: "Engineer", initials: "E", color: "#5F3DC4", coordinator: false,
    personality: "Pragmatic. Flags effort and risk early.",
    responsibleFor: "Timeline, technical risks, feasibility. Reads the code when a public GitHub repo is linked.",
    tools: ["github_repo", "shared_draft"]
  },
  C: {
    id: "C", name: "Critic", initials: "C", color: "#C2410C", coordinator: false,
    personality: "Strict but fair. Has no tools for making things.",
    responsibleFor: "Reviews every section against the brief.",
    tools: ["comment"]
  },
  PI: {
    id: "PI", name: "Principal investigator", initials: "PI", color: "#0B7285", coordinator: true,
    personality: "Rigorous and focused. States the question before the method.",
    responsibleFor: "Writes the brief, owns the hypothesis, assembles the experiment design.",
    tools: ["shared_draft", "task_list"]
  },
  MS: {
    id: "MS", name: "Methods specialist", initials: "MS", color: "#8C5A00", coordinator: false,
    personality: "Precise. Prefers the simplest design that answers the question.",
    responsibleFor: "Variables, method, sample and controls.",
    tools: ["read_files", "shared_draft"]
  },
  DA: {
    id: "DA", name: "Data analyst", initials: "DA", color: "#495057", coordinator: false,
    personality: "Quantitative and sceptical. Names the test and the numbers behind it.",
    responsibleFor: "Measurements, analysis plan, sample size.",
    tools: ["sample_size", "read_files", "shared_draft"]
  },
  ER: {
    id: "ER", name: "Ethics reviewer", initials: "ER", color: "#9C36B5", coordinator: false,
    personality: "Protective of participants. Asks who could be harmed and how consent works.",
    responsibleFor: "Risks and ethics: consent, privacy, harm, data handling.",
    tools: ["read_files", "shared_draft"]
  }
};

/** Which tools each role may be given. The Critic can only comment: it has no tools for making things. */
export const ALLOWED_TOOLS: Record<RoleId, ToolId[]> = {
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

/**
 * Input of the sample-size tool. The tool is deterministic code (src/sample-size.ts), not a model:
 * the model only chooses these parameters. Two-sided tests, normal approximation, equal groups.
 */
export type SampleSizeRequest =
  | { test: "two_proportions"; p1: number; p2: number; alpha?: number; power?: number }
  | { test: "two_means"; effectSize: number; alpha?: number; power?: number }; // effectSize = Cohen's d

export type SampleSizeResult = { perGroup: number; total: number; alpha: number; power: number; explanation: string };

// =====================================================================================
// Templates & outputs — a template fixes a team's members, coordinator, output document,
// fixed handoff rules and the consult pairs that may be switched on.
// =====================================================================================

export type OutputId = "work-plan" | "lab-experiment";
export type TemplateId = "product-squad" | "research-lab";

/** One section of an output document. Owners are fixed by the output. */
export type SectionPlan = {
  id: string;
  name: string;
  owner: RoleId;
  /** Who the owner may consult (a consult only happens if the team's rules allow it both ways). */
  consults: RoleId[];
  /** What the section must contain — given to the writer and to the Critic. */
  guidance: string;
};

export const WORK_PLAN: SectionPlan[] = [
  { id: "goal", name: "Goal", owner: "PL", consults: [], guidance: "One or two sentences: the outcome and the deadline." },
  { id: "scope", name: "Scope and non-goals", owner: "D", consults: ["R"], guidance: "What is in scope, and explicit non-goals." },
  { id: "milestones", name: "Milestones", owner: "D", consults: ["E"], guidance: "3–5 milestones that each ship user value." },
  { id: "owners", name: "Owners", owner: "PL", consults: [], guidance: "Who owns what. Use [PLACEHOLDER] names, never invent people." },
  { id: "timeline", name: "Timeline", owner: "E", consults: ["D"], guidance: "Phases with rough dates up to the deadline." },
  { id: "risks", name: "Risks", owner: "E", consults: ["R"], guidance: "Top risks, each with a likelihood and a concrete mitigation." },
  { id: "deps", name: "Dependencies", owner: "R", consults: ["E"], guidance: "Things that must happen or be decided first." },
  { id: "open", name: "Open questions", owner: "PL", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];

export const LAB_EXPERIMENT: SectionPlan[] = [
  { id: "hypothesis", name: "Hypothesis", owner: "PI", consults: [], guidance: "One testable hypothesis with a direction and a null hypothesis." },
  { id: "variables", name: "Variables", owner: "MS", consults: ["DA"], guidance: "Independent, dependent and controlled variables, each with how it is operationalised." },
  { id: "method", name: "Method", owner: "MS", consults: ["ER"], guidance: "Design (e.g. randomised A/B, within-subjects), procedure step by step, duration." },
  { id: "sample", name: "Sample and controls", owner: "MS", consults: ["DA"], guidance: "Who takes part, how they are recruited and assigned, the control condition, and the sample size with its justification." },
  { id: "measurements", name: "Measurements", owner: "DA", consults: ["MS"], guidance: "Each metric with its exact definition, unit, time window and data source." },
  { id: "analysis", name: "Analysis plan", owner: "DA", consults: ["MS"], guidance: "Primary test, significance level, power, how missing data and multiple comparisons are handled, and the decision rule." },
  { id: "ethics", name: "Risks and ethics", owner: "ER", consults: ["MS"], guidance: "Consent, privacy and data retention, possible harms and how they are mitigated, and stop conditions." },
  { id: "open", name: "Open questions", owner: "PI", consults: [], guidance: "Questions raised during the run that no agent could answer. Not reviewed." }
];

export const OUTPUTS: Record<OutputId, { id: OutputId; name: string; sections: SectionPlan[] }> = {
  "work-plan": { id: "work-plan", name: "Work plan", sections: WORK_PLAN },
  "lab-experiment": { id: "lab-experiment", name: "Lab experiment design", sections: LAB_EXPERIMENT }
};

/** Handoff rule = who may message whom. Directed; "*" means any member. Consults need both directions. */
export type HandoffRule = { from: RoleId | "*"; to: RoleId | "*"; what: string };

/**
 * The Product squad's default rules. Also the fallback for `canMessage` and for runs stored
 * without a team snapshot (the UI fixtures include such a run).
 */
export const HANDOFF_RULES: HandoffRule[] = [
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

/** True when some rule lets `from` message `to`. Nobody messages themselves. */
export function canMessage(from: RoleId, to: RoleId, rules: HandoffRule[] = HANDOFF_RULES): boolean {
  if (from === to) return false;
  return rules.some((r) => (r.from === from || r.from === "*") && (r.to === to || r.to === "*"));
}

/** The section's consults that the team's rules allow in both directions. */
export function effectiveConsults(plan: SectionPlan, rules: HandoffRule[]): RoleId[] {
  return plan.consults.filter((r) => canMessage(plan.owner, r, rules) && canMessage(r, plan.owner, rules));
}

/** Coordinator → everyone, everyone → coordinator, Critic ↔ everyone. These rules can never be edited. */
export function fixedRulesFor(coordinator: RoleId): HandoffRule[] {
  return [
    { from: coordinator, to: "*", what: "Assigns sections" },
    { from: "*", to: coordinator, what: "Returns finished sections and open questions" },
    { from: "C", to: "*", what: "Approves or sends a section back" },
    { from: "*", to: "C", what: "Submits a section for review" }
  ];
}

/** An editable consult rule between two specialists; stored as two directed rules. */
export type ConsultPair = { a: RoleId; b: RoleId; what: string };

export type Template = {
  templateId: TemplateId;
  name: string;
  description: string;
  outputId: OutputId;
  coordinator: RoleId;
  /** Team members in display order (coordinator first, Critic last). */
  members: RoleId[];
  /** The consult pairs a team of this template may switch on. */
  consultPairs: ConsultPair[];
  /** The pairs switched on in a new team copied from this template. */
  defaultConsults: ConsultPair[];
  guardrails: Guardrails;
};

/** Default guardrails of every template (ranges a team version may use: see `Guardrails`). */
export const DEFAULT_GUARDRAILS: Guardrails = {
  maxTurns: 60,
  maxTokens: 120_000,
  criticRounds: 2,
  noProgressTurns: 5
};

const SQUAD_PAIRS: ConsultPair[] = [
  { a: "R", b: "D", what: "Consult: findings and user needs" },
  { a: "D", b: "E", what: "Consult: feasibility check" },
  { a: "R", b: "E", what: "Consult: technical dependencies" }
];
const LAB_PAIRS: ConsultPair[] = [
  { a: "MS", b: "DA", what: "Consult: measurement and sample size" },
  { a: "MS", b: "ER", what: "Consult: participant risk in the procedure" },
  { a: "DA", b: "ER", what: "Consult: data privacy and retention" }
];

export const TEMPLATES: Record<TemplateId, Template> = {
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

/** A team's rules: the template's fixed rules plus each enabled consult pair in both directions. */
export function rulesFor(template: Template, enabled: ConsultPair[]): HandoffRule[] {
  return [
    ...fixedRulesFor(template.coordinator),
    ...enabled.flatMap((p) => [{ from: p.a, to: p.b, what: p.what }, { from: p.b, to: p.a, what: p.what }])
  ];
}

// =====================================================================================
// Teams & versions — saved in D1. Versions are immutable: saving creates version N+1, and a
// run keeps a snapshot of the version it used, so old traces stay explainable after edits.
// =====================================================================================

export type Guardrails = {
  maxTurns: number;        // 10–120
  maxTokens: number;       // 10,000–300,000 input + output tokens for the run (stands in for a budget cap)
  criticRounds: number;    // 0–3: how many times the Critic may send one section back
  noProgressTurns: number; // 2–20: stop after this many model turns in a row that did not move the document forward
};

/** Editable per-member settings. The role itself (id, name, colour) is fixed by ROLES. */
export type MemberConfig = {
  role: RoleId;
  personality: string;      // ≤ 300 chars
  responsibleFor: string;   // ≤ 300 chars
  tools: ToolId[];          // a subset of ALLOWED_TOOLS[role]
  /** Workers AI model this member runs on; one of MODELS. Missing = DEFAULT_MODEL_ID. */
  model?: ModelId;
};

/** One immutable version of a team. */
export type TeamConfig = {
  teamId: string;           // slug, e.g. "squad"
  name: string;             // ≤ 60 chars
  version: number;          // 1, 2, 3…
  versionLabel: string;     // "v1", "v2"…
  note: string;             // change note, ≤ 200 chars ("Copied from the Product squad template" for v1)
  createdAt: string;
  coordinator: RoleId;      // the template's coordinator
  members: MemberConfig[];  // the template's members, in template order
  rules: HandoffRule[];     // rulesFor(template, enabled consult pairs)
  guardrails: Guardrails;
  /** Missing in versions stored before templates existed: read as "product-squad". */
  templateId?: TemplateId;
  /** Missing in versions stored before templates existed: read as "work-plan". */
  outputId?: OutputId;
};

/** One row of GET /api/teams. The optional fields are always present in responses. */
export type TeamSummary = {
  teamId: string;
  name: string;
  version: number;          // latest version
  versionLabel: string;
  updatedAt: string;
  runCount: number;         // runs across all versions
  lastRunAt: string | null;
  templateId?: TemplateId;
  outputId?: OutputId;
  coordinator?: RoleId;
  members?: RoleId[];
};

export type TeamVersionSummary = { version: number; versionLabel: string; note: string; createdAt: string; runCount: number };

/** The built-in Product squad, used for runs stored without a team snapshot. */
export const TEAM = {
  id: "squad",
  name: "Mobile Product Squad",
  version: "v1",
  coordinator: "PL" as RoleId,
  members: ["PL", "R", "D", "E", "C"] as RoleId[]
};

// =====================================================================================
// Runs & spans — RunState is the RunAgent's state, pushed to clients as `cf_agent_state`.
// =====================================================================================

export type RunStatus =
  | "drafting_brief"     // the coordinator is writing the brief
  | "awaiting_approval"  // brief checkpoint: the user must approve
  | "running"            // autonomous
  | "completed"
  | "stopped"            // the user pressed Stop, or a guardrail fired (see stopReason)
  | "failed";            // unrecoverable error (see stopReason)

export type Brief = {
  goal: string;
  audience: string;
  assumptions: string;
  outOfScope: string;
  doneWhen: string;
};

export type SectionStatus = "pending" | "drafting" | "in_review" | "sent_back" | "approved" | "open";

export type SectionState = SectionPlan & {
  status: SectionStatus;
  /** Number of drafts written (1 = approved first time). */
  rounds: number;
  /** Current content as bullet lines. */
  content: string[];
  /** Roles actually consulted during the run. */
  consulted: RoleId[];
  /** What it was built from: tool results, files, consult answers, a Critic's note kept at the limit. */
  sources: string[];
  /** Send-backs only (never approvals): the note and the draft before the revision. */
  reviews: { round: number; verdict: "approved" | "sent_back"; note: string; before: string[] }[];
  spanIds: number[];
  tokens: number;
};

export type SpanKind = "work" | "msg" | "tool" | "review" | "system";
export type SpanStatus = "running" | "done" | "approved" | "sent_back" | "failed";

/**
 * One agent turn, tool call, message or engine step — like a span in a distributed trace.
 * A span with `model !== null` is a turn (it called a model).
 */
export type Span = {
  id: number;
  parentId: number | null;
  role: RoleId;
  kind: SpanKind;
  /** Short label, e.g. "Draft Risks", "Ask Engineer: is X feasible?". */
  action: string;
  /** The agent's own reason for this step (from the model's JSON when there is one). */
  why: string;
  status: SpanStatus;
  /** Milliseconds since the run was created (the brief checkpoint shows as a gap). */
  startMs: number;
  durMs: number;
  depth: number;
  sectionId: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  /** Cut to ~1500 chars in state; the full text is in the RunAgent's SQLite `spans` table (GET …/spans). */
  input: string;
  output: string;
  gatewayLogId: string | null;
  /** The MemberAgent that handled this span (e.g. "squad--R"); absent on engine and message spans. */
  agent?: string | null;
  /** Ids of the member's MemoryItems put in this turn's prompt. */
  memoriesUsed?: number[];
  /** Message spans only: what was delivered to whose inbox. */
  delivered?: { to: RoleId; kind: InboxMessage["kind"] };
};

export type RunState = {
  runId: string;
  title: string;
  task: string;
  output: OutputId;
  team: { name: string; version: string };
  repo: { name: string; branch: string } | null;
  /** The exact team version this run used (absent on runs stored without a team snapshot). */
  teamRef?: { teamId: string; version: number };
  /** Snapshot of that team version: editing the team never changes a running or finished run. */
  teamConfig?: TeamConfig;
  /** Context files attached to the run (read by members with the read_files tool). */
  files?: FileMeta[];
  /** Role → MemberAgent name used in this run. */
  memberAgents?: Partial<Record<RoleId, string>>;
  status: RunStatus;
  stopReason: string | null;
  brief: Brief | null;
  guardrails: Guardrails;
  sections: SectionState[];
  openQuestions: { question: string; raisedBy: RoleId }[];
  spans: Span[];
  /** Always derived from `spans` (and the sections' statuses and reviews). */
  totals: { turns: number; inputTokens: number; outputTokens: number; sectionsApproved: number; reviewRoundsUsed: number };
  activeRole: RoleId | null;
  createdAt: string;
  startedAt: string | null; // when the brief was approved
  endedAt: string | null;
};

/** One row of GET /api/runs (stored in D1). The optional fields are absent only on rows without a team. */
export type RunSummary = {
  runId: string;
  title: string;
  status: RunStatus;
  stopReason: string | null;
  createdAt: string;
  turns: number;
  tokens: number;
  sectionsApproved: number;
  /** Reviewed sections (Open questions is never approved). */
  sectionCount: number;
  teamId?: string;
  teamName?: string;
  teamVersion?: number;
  fileCount?: number;
  outputId?: OutputId;
};

// =====================================================================================
// Member agents & memory — every team member is its own Agent (a Durable Object with SQLite),
// named memberAgentName(teamId, role) and shared by every run and version of that team.
//
// The RunAgent coordinates one run (hub and spoke): it decides the step order, enforces the
// team's handoff rules on every message, and records the trace and the guardrails. For every
// model turn it sends the member a task over Durable Object RPC; the member builds its own prompt
// (persona from the run's team version + its inbox for this run + relevant memories), calls
// Workers AI with its own model, and returns the result.
//
// Memory rules (cheap and visible — no extra model calls except the reflection):
//   - Section approved → the owner stores an "outcome" (section, rounds, one-line gist).
//   - Each send-back → the owner stores a "lesson" = the note, prefixed by the section name.
//   - Completed run → each member that worked makes ONE "Reflect on the run" turn that stores
//     ≤ 2 "lesson"/"note" items (skipped if it would break the token or turn guardrail).
//   - Before each turn the member puts ≤ 5 relevant memories from earlier runs in its prompt.
// =====================================================================================

/** Durable Object name of a team member's agent, e.g. "squad--R". */
export function memberAgentName(teamId: string, role: RoleId): string {
  return `${teamId}--${role}`;
}

export type MemoryKind =
  | "lesson"       // a send-back note about this member's section, or the member's own reflection
  | "note"         // a stable fact the member chose to keep (e.g. "the team has 4 engineers")
  | "outcome";     // a short summary of a section it delivered (name, verdict, rounds)

export type MemoryItem = {
  id: number;
  kind: MemoryKind;
  text: string;            // ≤ 300 chars
  runId: string;
  teamVersion: number;
  sectionId: string | null;
  createdAt: string;
};

export type InboxMessage = {
  id: number;
  runId: string;
  from: RoleId | "user";
  kind: "assign" | "question" | "answer" | "review" | "brief" | "files" | "tool_result";
  text: string;            // ≤ 2000 chars stored
  spanId: number | null;   // the span that delivered it
  createdAt: string;
};

/** GET /api/teams/<teamId>/members[/<role>]. */
export type MemberView = {
  agentName: string;       // "squad--R" — the Durable Object name in the Cloudflare dashboard
  teamId: string;
  role: RoleId;
  stats: { runs: number; turns: number; inputTokens: number; outputTokens: number; lastActiveAt: string | null };
  memoryCount?: number;    // total memories stored (the list may be cut)
  memories: MemoryItem[];  // newest first, ≤ 100
  recentInbox: InboxMessage[]; // newest first, ≤ 20 (across runs)
};

// =====================================================================================
// Files — context files uploaded for a run. Only the extracted Markdown is kept (in D1).
// =====================================================================================

export type FileStatus = "ready" | "failed";

export type FileMeta = {
  fileId: string;
  name: string;
  mimeType: string;
  bytes: number;            // original upload size (max 2 MB)
  chars: number;            // length of the extracted Markdown (stored up to 60,000 chars)
  truncated: boolean;
  status: FileStatus;
  error: string | null;
  createdAt: string;
};

// =====================================================================================
// Models — the Workers AI text models a member can run on (all on the free allowance).
// Smaller models use fewer neurons per token, so giving drafting roles a small model stretches
// the daily allowance; a large model is best kept for the Critic.
// =====================================================================================

export type ModelId = string;

export type ModelInfo = {
  id: ModelId;
  label: string;
  size: "small" | "medium" | "large";
  /**
   * Accepts `response_format: { type: "json_schema" }` (from the model's input schema in the
   * Workers AI catalog). Without it, JSON is requested in the prompt only.
   */
  jsonMode: boolean;
  /** Has completed a full run with this app; the UI shows unverified models with a warning. */
  verified: boolean;
  note: string;
  /**
   * Request and reply follow OpenAI Chat Completions: `json_schema` is `{ name, schema }` and the
   * reply is in `choices[0].message.content`. Missing = the classic Workers AI shape (`{ response }`).
   */
  openAiFormat?: boolean;
  /** Output token cap; reasoning models need room to think before they answer. Missing = 500. */
  maxTokens?: number;
  /** Extra request fields for this model (e.g. switching thinking off to save tokens). */
  extra?: Record<string, unknown>;
};

export const DEFAULT_MODEL_ID: ModelId = "@cf/meta/llama-4-scout-17b-16e-instruct";

export const MODELS: ModelInfo[] = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", size: "medium", jsonMode: true, verified: true, note: "Default. Reliable JSON; good all-rounder." },
  {
    id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B (4B active)", size: "small", jsonMode: true, verified: false,
    note: "Mixture-of-experts; cheap per token. Runs with thinking switched off.",
    openAiFormat: true, extra: { chat_template_kwargs: { enable_thinking: false } }
  },
  {
    id: "@cf/openai/gpt-oss-20b", label: "gpt-oss 20B", size: "small", jsonMode: true, verified: false,
    note: "Small open-weight reasoning model; always reasons first, so it uses more output tokens.", maxTokens: 1500
  },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B", size: "medium", jsonMode: false, verified: false, note: "Good instruction following." },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", size: "large", jsonMode: true, verified: false, note: "Strongest, but uses the allowance fastest — best kept for the Critic." }
];

/** The model with this id, or the default model when the id is missing or no longer offered. */
export function modelInfo(id: ModelId | null | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}

// =====================================================================================
// HTTP API — every route except /login, /logout and /api/health is behind the access gate
// (src/access.ts). Errors are JSON { error } with 400, 401, 404, 405, 409, 413, 415 or 500.
//
// GET    /api/health                              → { ok, model: DEFAULT_MODEL_ID, gateway }   (public)
// GET    /api/models                              → ModelInfo[] (MODELS)
// GET    /api/templates                           → (Template & { roles: Role[], sections: SectionPlan[], outputName })[]
// GET    /api/team                                → { team, roles, rules, sections, guardrails } for the latest "squad" version
// GET    /api/teams                               → TeamSummary[] (seeds "squad" and "ux-research" v1 when missing)
// POST   /api/teams                               body { name, templateId? = "product-squad" } → 201 TeamConfig (v1)
// GET    /api/teams/<teamId>                      → { team: TeamConfig (latest), versions: TeamVersionSummary[] (newest first) }
// GET    /api/teams/<teamId>/versions/<n>         → TeamConfig
// POST   /api/teams/<teamId>/versions             body { note, name?, members?, consultRules?, guardrails? } → 201 TeamConfig (latest + 1)
//          members:      { role, personality?, responsibleFor?, tools?, model? }[]  merged onto the latest version by role;
//                        model must be a MODELS id (null = back to the default)
//          consultRules: { a, b, what? }[]  replaces the consult rules; pairs must be the template's consultPairs
//          guardrails:   partial Guardrails, integers in the documented ranges
// GET    /api/teams/<teamId>/members              → MemberView[] for the latest version's members (≤ 5 memories each)
// GET    /api/teams/<teamId>/members/<role>       → MemberView (≤ 100 memories, ≤ 20 inbox messages)
// DELETE /api/teams/<teamId>/members/<role>/memory → { cleared: number }  (keeps stats and inbox)
// POST   /api/files                               multipart, field "file" (pdf, docx, xlsx, csv, txt, md, html; ≤ 2 MB) → 201 FileMeta
// GET    /api/files/<fileId>                      → FileMeta & { preview: string }  (first 2000 chars of the Markdown)
// POST   /api/runs                                body { task, title?, repo?: "owner/name", branch?, teamId? = "squad",
//                                                        teamVersion? = latest, fileIds?: string[] (≤ 5, status "ready") }
//                                                  → 201 { runId }  (the run starts in "drafting_brief"; output = the team's outputId)
// GET    /api/runs                                → RunSummary[] (newest first, max 100)
// GET    /agents/run-agent/<runId>                → RunState
// POST   /agents/run-agent/<runId>/approve        body { brief?: Partial<Brief> } → RunState  (only from "awaiting_approval")
// POST   /agents/run-agent/<runId>/stop           → RunState  (status "stopped"; a model call in flight finishes, nothing new starts)
// GET    /agents/run-agent/<runId>/spans          → Span[] with the full input and output text
// GET    /agents/run-agent/<runId>/document       → the document as Markdown
// WS     /agents/run-agent/<runId>                → `cf_agent_state` messages carrying RunState on every change (read-only)
// *      /agents/hello-agent/<name>               → plumbing check (src/server.ts)
// MemberAgents are not exposed: /agents/member-agent/* → 404.
//
// AI Gateway: every model call carries metadata { runId, role, section, spanId, agent }, so the
// gateway's logs can be filtered by run, role or member.
// =====================================================================================
