import { Agent, getAgentByName, type Connection } from "agents";
import {
  ALLOWED_TOOLS,
  canMessage,
  DEFAULT_GUARDRAILS,
  effectiveConsults,
  memberAgentName,
  modelInfo,
  OUTPUTS,
  ROLES,
  TEAM,
  TOOL_LABELS,
  type Brief,
  type InboxMessage,
  type OutputId,
  type SampleSizeRequest,
  type SampleSizeResult,
  type FileMeta,
  type RoleId,
  type RunState,
  type RunStatus,
  type RunSummary,
  type SectionPlan,
  type TeamConfig,
  type SectionState,
  type Span,
  type SpanKind,
  type SpanStatus
} from "./contract";
import { briefText, filesBlock, repoLine, sizingBlock } from "./prompts";
import { getFileMarkdown, selectExcerpts, type Excerpt } from "./files";
import {
  asText, errMsg, LLM_TIMEOUT_MS, obj, trunc,
  type BriefOut, type DecideOut, type AnswerOut, type DraftOut, type ReviewOut, type SizingOut, type MergeOut, type ReflectOut, type LlmOutcome
} from "./llm";
import type { TurnRequest, TurnResult } from "./member-agent";
import { upsertRun } from "./runs-db";
import { describeRequest, sampleSize } from "./sample-size";
import { DEFAULT_TEAM_ID, hasTool, member, normalizeConfig, outputOf, templateConfig, withTool } from "./teams";
import { sampleSizeCheckNote, SAMPLE_SIZE_CHECK_WHY, unverifiedSampleSizes } from "./checks";

/**
 * The run engine: one RunAgent (Durable Object + SQLite) per run, the coordinator of that run.
 *
 * The pipeline order is fixed in code; the models make the decisions inside each step (whether to
 * consult, what to write, approve or send back). Nothing here is specific to one team: the
 * coordinator is the team version's coordinator, the sections are OUTPUTS[state.output].sections,
 * and the Critic ("C") reviews every section.
 *
 *   brief ─(approve)→ split → per section: assign → [decide → answer] → draft → review ⇄ revise
 *         → open → reflect → assemble → done
 *
 * Step machine: a small cursor (phase + section index + a few span ids) lives in the SQLite
 * `run_kv` table. Every step is its own scheduled task (`this.schedule(0, "step", { seq })`), does
 * at most ONE model call (plus tool calls and messages), persists the result, then schedules the
 * next step. So the run survives eviction, never blocks a request, and Stop takes effect at the
 * next step. Each phase is one method (`brief`, `split`, … `assemble`); a phase returns the next cursor.
 *
 * Members: the RunAgent never calls Workers AI itself. Every model turn is an RPC to the member's
 * own MemberAgent (`member.turn({ kind, … })`), which reads its inbox, picks its memories, builds
 * the prompt and calls its model. The RunAgent is the only writer of the trace, state and
 * guardrails; it delivers every message (assign, question, answer, review note, brief) to the
 * recipient's inbox along the team's handoff rules, stores outcomes and lessons in the owners'
 * memories, and asks every member that worked for one reflection at the end.
 *
 * Tools run in the engine, not in a model: the GitHub reader, read_files and the sample-size
 * calculator (a member turn decides the parameters, the engine computes the number). Before the
 * Critic's model review of a section that needs a sample size, an automatic check (src/checks.ts)
 * sends back drafts that state a sample size the calculator did not compute.
 *
 * Definitions:
 * - startMs is measured from `createdAt` for every span, so the brief checkpoint shows as a gap.
 * - turns = spans that called a model (`model !== null`), failed ones included.
 * - "no progress" = consecutive model turns that did not move the document forward
 *   (failed turns, send-backs, revisions identical to the previous draft).
 */

const STATE_TEXT_LIMIT = 1500;
/** A member turn is at most two model attempts of LLM_TIMEOUT_MS each; past this the coordinator gives up on the RPC. */
const MEMBER_TIMEOUT_MS = 2 * LLM_TIMEOUT_MS + 15_000;
/** Rough cost of one reflection turn, for the token guardrail check before it. */
const REFLECT_TOKENS = 1500;
const ACTIVE: RunStatus[] = ["drafting_brief", "running"];
const TERMINAL: RunStatus[] = ["completed", "stopped", "failed"];

type Phase = "brief" | "split" | "assign" | "decide" | "answer" | "draft" | "review" | "revise" | "open" | "reflect" | "assemble" | "done";

type Cursor = {
  phase: Phase;
  seq: number;
  section: number; // index into OUTPUTS[state.output].sections
  splitSpanId: number | null;
  assignSpanId: number | null; // parent of the owner's work in the current section
  lastSpanId: number | null; // the span the next review / revision hangs under
  consult: { role: RoleId; question: string; askSpanId: number; answer: string | null; answerSpanId?: number | null } | null;
  sentBacks: number;
  failures: number; // consecutive failed attempts at the current phase
  noProgress: number;
  /** The sample-size decision for the current section was made (missing = not yet). */
  sizingDone?: boolean;
  /** Calculator result for the current section, if the tool ran successfully. */
  sizing?: SizingNote | null;
  /** The automatic check sent the section back and no calculator result exists for it: one more sizing decision before revising. */
  sizingRetry?: boolean;
  /** End-of-run reflections still to do, under the "Collect lessons" span. */
  reflect?: { collectSpanId: number; queue: RoleId[] } | null;
};

/** The member turn in flight for step `seq` (a restarted step resumes the same span). */
type PendingTurn = { seq: number; spanId: number; action: string; role: RoleId };
type InboxKind = InboxMessage["kind"];
/** What a phase sends a member; the coordinator adds run, team, span and context. */
type MemberTask = Omit<TurnRequest, "runId" | "spanId" | "teamVersion" | "team" | "output" | "label" | "sectionId" | "ctx">;
type SpanMeta = Pick<Span, "agent" | "memoriesUsed" | "delivered">;

/** A successful calculator run: the tool span, the request and the result, and the section it was for. */
type SizingNote = { toolSpanId: number; label: string; request: SampleSizeRequest; result: SampleSizeResult; sectionId: string };

/** The Critic reviews every section, in every template. */
const CRITIC: RoleId = "C";
/** Sections before which the sample-size calculator is offered (Lab experiment design). */
const SIZING_SECTIONS = ["sample", "analysis"];
const SIZING_QUESTION = /sample|power|participant|how many|\bsize\b|per group|n per/i;

/** What the GitHub reader found (stored once per run). `skipped` = the reader has no github_repo tool. */
type RepoData = { ok: boolean; text: string; note: string; branch: string; spanId: number; skipped?: boolean };

/** Character budget for file excerpts in one prompt (all files together). */
const FILE_BUDGET = 6000;

/** An error that fails the run with its message as the stopReason. */
class RunError extends Error {}

/** What the Worker passes to `RunAgent.create` after validating POST /api/runs. */
export type CreateRunInput = {
  task: string; title: string; repo: string | null; branch: string | null;
  /** The team version snapshot and the (ready) context files. */
  team: TeamConfig; files: FileMeta[];
};

function emptyState(): RunState {
  return {
    runId: "",
    title: "",
    task: "",
    output: "work-plan",
    team: { name: TEAM.name, version: TEAM.version },
    repo: null,
    status: "drafting_brief",
    stopReason: null,
    brief: null,
    guardrails: { ...DEFAULT_GUARDRAILS },
    sections: [],
    openQuestions: [],
    spans: [],
    totals: { turns: 0, inputTokens: 0, outputTokens: 0, sectionsApproved: 0, reviewRoundsUsed: 0 },
    activeRole: null,
    createdAt: "",
    startedAt: null,
    endedAt: null
  };
}

/** The output's section with its consults limited to what the team's rules allow. */
function planFor(sections: SectionPlan[], i: number, rules: TeamConfig["rules"]): SectionPlan {
  const p = sections[i];
  return { ...p, consults: effectiveConsults(p, rules) };
}

function initSection(p: SectionPlan): SectionState {
  return { ...p, consults: [...p.consults], status: "pending", rounds: 0, content: [], consulted: [], sources: [], reviews: [], spanIds: [], tokens: 0 };
}

/** Totals, section tokens and section spanIds are always derived from the span list. */
function derive(s: RunState): RunState {
  const turns = s.spans.filter((x) => x.model !== null).length;
  const inputTokens = s.spans.reduce((a, x) => a + x.inputTokens, 0);
  const outputTokens = s.spans.reduce((a, x) => a + x.outputTokens, 0);
  const sections = s.sections.map((sec) => {
    const mine = s.spans.filter((x) => x.sectionId === sec.id);
    return { ...sec, spanIds: mine.map((x) => x.id), tokens: mine.reduce((a, x) => a + x.inputTokens + x.outputTokens, 0) };
  });
  return {
    ...s,
    sections,
    totals: {
      turns,
      inputTokens,
      outputTokens,
      sectionsApproved: sections.filter((x) => x.status === "approved").length,
      reviewRoundsUsed: sections.reduce((a, x) => a + x.reviews.filter((r) => r.verdict === "sent_back").length, 0)
    }
  };
}

const roleName = (r: RoleId) => ROLES[r].name;

// ---------- GitHub (public, unauthenticated, read-only) ----------

async function readRepo(full: string, branch: string | null): Promise<Omit<RepoData, "spanId">> {
  const headers = { "User-Agent": "team-agents-kit-prototype", Accept: "application/vnd.github+json" };
  const get = (path: string, accept?: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: accept ? { ...headers, Accept: accept } : headers,
      signal: AbortSignal.timeout(8000)
    });
  const explain = (r: Response) =>
    r.status === 404
      ? "not found or not public (HTTP 404)"
      : r.status === 403 || r.status === 429
        ? `rate limited by GitHub (HTTP ${r.status}${r.headers.get("x-ratelimit-remaining") === "0" ? ", the unauthenticated limit of 60 requests/hour is used up" : ""})`
        : `HTTP ${r.status}`;

  const notes: string[] = [];
  let meta: Response;
  try {
    meta = await get(`/repos/${full}`);
  } catch (e) {
    return { ok: false, text: "", note: `Could not reach GitHub: ${errMsg(e)}`, branch: branch ?? "" };
  }
  if (!meta.ok) return { ok: false, text: "", note: `Repository ${full}: ${explain(meta)}`, branch: branch ?? "" };
  const m = (await meta.json()) as Record<string, unknown>;
  const ref = branch || String(m.default_branch ?? "main");
  const lines = [
    `Repository: ${m.full_name} — ${m.description ?? "no description"}`,
    `Language: ${m.language ?? "?"}; stars: ${m.stargazers_count}; open issues: ${m.open_issues_count}; last push: ${m.pushed_at}; branch read: ${ref}`
  ];
  if (Array.isArray(m.topics) && m.topics.length) lines.push(`Topics: ${m.topics.join(", ")}`);

  let names: string[] = [];
  try {
    const r = await get(`/repos/${full}/contents?ref=${encodeURIComponent(ref)}`);
    if (r.ok) {
      const items = (await r.json()) as { name: string; type: string }[];
      names = items.map((i) => (i.type === "dir" ? `${i.name}/` : i.name));
      lines.push(`Top-level files: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}`);
    } else notes.push(`top-level listing: ${explain(r)}`);
  } catch (e) {
    notes.push(`top-level listing failed: ${errMsg(e)}`);
  }

  try {
    const r = await get(`/repos/${full}/readme?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");
    if (r.ok) {
      const md = (await r.text()).replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n");
      lines.push(`README (start):\n${trunc(md.trim(), 1500)}`);
    } else notes.push(`README: ${explain(r)}`);
  } catch (e) {
    notes.push(`README failed: ${errMsg(e)}`);
  }

  if (names.includes("package.json")) {
    try {
      const r = await get(`/repos/${full}/contents/package.json?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");
      if (r.ok) lines.push(`package.json (start):\n${trunc(await r.text(), 600)}`);
      else notes.push(`package.json: ${explain(r)}`);
    } catch (e) {
      notes.push(`package.json failed: ${errMsg(e)}`);
    }
  }
  return { ok: true, text: lines.join("\n"), note: notes.join("; "), branch: ref };
}

// ---------- The agent ----------

/** The coordinator of one run (named by its run id). See the file comment. */
export class RunAgent extends Agent<Env, RunState> {
  initialState: RunState = emptyState();
  private stepping = false;
  private tablesReady = false;
  /** seq of the step being run (for resuming a member turn after a restart). */
  private currentSeq = -1;

  private tables() {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS spans (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      why TEXT NOT NULL,
      status TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      dur_ms INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      section_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      model TEXT,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      gateway_log_id TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS run_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    // agent / memoriesUsed / delivered per span, as JSON. Older run databases lack the column: add it.
    const cols = this.sql<{ name: string }>`PRAGMA table_info(spans)`;
    if (!cols.some((c) => c.name === "meta")) this.sql`ALTER TABLE spans ADD COLUMN meta TEXT`;
    this.tablesReady = true;
  }

  /** Clients may watch the run over WebSocket but never write its state. */
  validateStateChange(_next: RunState, source: Connection | "server") {
    if (source !== "server") throw new Error("Run state is read-only for clients");
  }

  /** On wake-up: queues a step for an active run that has none queued (e.g. evicted mid-step). */
  async onStart() {
    this.tables();
    // Watchdog: if the run is active but no step is queued (e.g. evicted mid-step), queue one.
    const s = this.state;
    if (s.runId && ACTIVE.includes(s.status)) {
      const pending = (await this.listSchedules()).some((x) => x.callback === "step");
      const cur = this.loadCursor();
      if (!pending && cur && cur.phase !== "done") await this.queueStep(cur.seq, 2);
    }
  }

  // ----- kv helpers -----
  private kvGet<T>(k: string): T | null {
    const [row] = this.sql<{ v: string }>`SELECT v FROM run_kv WHERE k = ${k}`;
    return row ? (JSON.parse(row.v) as T) : null;
  }
  private kvSet(k: string, v: unknown) {
    const json = JSON.stringify(v);
    this.sql`INSERT INTO run_kv (k, v) VALUES (${k}, ${json}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  }
  private kvDel(k: string) {
    this.sql`DELETE FROM run_kv WHERE k = ${k}`;
  }
  private loadCursor() {
    return this.kvGet<Cursor>("cursor");
  }

  // ----- state helpers -----
  private commit(patch: Partial<RunState>) {
    this.setState(derive({ ...this.state, ...patch }));
  }
  private patchSection(id: string, fn: (s: SectionState) => SectionState) {
    this.commit({ sections: this.state.sections.map((s) => (s.id === id ? fn(s) : s)) });
  }
  private section(id: string) {
    return this.state.sections.find((s) => s.id === id)!;
  }
  /** The team version this run uses (a run stored without a snapshot uses the Product squad template). */
  private teamConfig(): TeamConfig {
    return normalizeConfig(this.state.teamConfig ?? templateConfig(DEFAULT_TEAM_ID, TEAM.name));
  }
  /** The output this run produces (a run stored without one is a Work plan). */
  private output(): OutputId {
    return this.state.output && OUTPUTS[this.state.output] ? this.state.output : "work-plan";
  }
  private outputName() {
    return OUTPUTS[this.output()].name;
  }
  private sectionPlans(): SectionPlan[] {
    return OUTPUTS[this.output()].sections;
  }
  private coordinator(): RoleId {
    return this.teamConfig().coordinator;
  }
  /** The model a member runs on in this run's team version (shown on its spans). */
  private modelOf(role: RoleId): string {
    return modelInfo(member(this.teamConfig(), role).model).id;
  }
  private plan(i: number): SectionPlan {
    return planFor(this.sectionPlans(), Math.max(0, Math.min(i, this.sectionPlans().length - 1)), this.teamConfig().rules);
  }
  /** The member who may read a linked GitHub repo (a role whose allowed tools include github_repo; the Engineer). */
  private repoRole(): RoleId | null {
    return this.teamConfig().members.find((m) => ALLOWED_TOOLS[m.role].includes("github_repo"))?.role ?? null;
  }
  private elapsed() {
    return Date.now() - Date.parse(this.state.createdAt);
  }

  private startSpan(p: {
    role: RoleId; kind: SpanKind; action: string; why: string; parentId: number | null;
    sectionId: string | null; input: string; model: string | null; agent?: string;
  }): number {
    const id = this.state.spans.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    const parent = p.parentId == null ? null : this.state.spans.find((s) => s.id === p.parentId);
    const span: Span = {
      id, parentId: parent ? parent.id : null, role: p.role, kind: p.kind, action: trunc(p.action, 120), why: p.why,
      status: "running", startMs: this.elapsed(), durMs: 0, depth: parent ? parent.depth + 1 : 0, sectionId: p.sectionId,
      inputTokens: 0, outputTokens: 0, model: p.model, input: trunc(p.input, STATE_TEXT_LIMIT), output: "", gatewayLogId: null,
      ...(p.agent ? { agent: p.agent } : {})
    };
    const meta = p.agent ? JSON.stringify({ agent: p.agent }) : null;
    this.sql`INSERT INTO spans (id, parent_id, role, kind, action, why, status, start_ms, dur_ms, depth, section_id,
        input_tokens, output_tokens, model, input, output, gateway_log_id, meta)
      VALUES (${id}, ${span.parentId}, ${span.role}, ${span.kind}, ${span.action}, ${span.why}, ${span.status}, ${span.startMs},
        0, ${span.depth}, ${span.sectionId}, 0, 0, ${span.model}, ${p.input}, '', NULL, ${meta})`;
    this.commit({ spans: [...this.state.spans, span], activeRole: p.role });
    return id;
  }

  private finishSpan(id: number, p: {
    status: SpanStatus; output: string; why?: string; action?: string;
    inputTokens?: number; outputTokens?: number; gatewayLogId?: string | null;
    /** The prompt the member actually built (replaces the placeholder input). */
    input?: string; memoriesUsed?: number[]; delivered?: Span["delivered"];
    /** The model the member reports it used (replaces the one recorded at the start). */
    model?: string;
  }) {
    const span = this.state.spans.find((s) => s.id === id);
    if (!span) return;
    if (p.input !== undefined) this.sql`UPDATE spans SET input = ${p.input} WHERE id = ${id}`;
    const done: Span = {
      ...span,
      ...(p.input !== undefined ? { input: trunc(p.input, STATE_TEXT_LIMIT) } : {}),
      ...(p.memoriesUsed ? { memoriesUsed: p.memoriesUsed } : {}),
      ...(p.delivered ? { delivered: p.delivered } : {}),
      ...(p.model ? { model: p.model } : {}),
      status: p.status,
      output: trunc(p.output, STATE_TEXT_LIMIT),
      why: p.why || span.why,
      action: p.action ? trunc(p.action, 120) : span.action,
      durMs: Math.max(0, this.elapsed() - span.startMs),
      inputTokens: p.inputTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      gatewayLogId: p.gatewayLogId ?? null
    };
    this.sql`UPDATE spans SET status = ${done.status}, output = ${p.output}, why = ${done.why}, action = ${done.action},
      dur_ms = ${done.durMs}, input_tokens = ${done.inputTokens}, output_tokens = ${done.outputTokens},
      gateway_log_id = ${done.gatewayLogId}, model = ${done.model} WHERE id = ${id}`;
    this.saveMeta(done);
    this.commit({ spans: this.state.spans.map((s) => (s.id === id ? done : s)) });
  }

  private saveMeta(span: Span) {
    const m: SpanMeta = {};
    if (span.agent) m.agent = span.agent;
    if (span.memoriesUsed) m.memoriesUsed = span.memoriesUsed;
    if (span.delivered) m.delivered = span.delivered;
    const json = Object.keys(m).length ? JSON.stringify(m) : null;
    this.sql`UPDATE spans SET meta = ${json} WHERE id = ${span.id}`;
  }

  /** Change a finished span without touching its tokens (delivery result, failure of a delivery). */
  private patchSpan(id: number, p: { status?: SpanStatus; output?: string; delivered?: Span["delivered"] }) {
    const span = this.state.spans.find((s) => s.id === id);
    if (!span) return;
    const next: Span = {
      ...span,
      ...(p.status ? { status: p.status } : {}),
      ...(p.output !== undefined ? { output: trunc(p.output, STATE_TEXT_LIMIT) } : {}),
      ...(p.delivered ? { delivered: p.delivered } : {})
    };
    if (p.status) this.sql`UPDATE spans SET status = ${p.status} WHERE id = ${id}`;
    if (p.output !== undefined) this.sql`UPDATE spans SET output = ${p.output} WHERE id = ${id}`;
    this.saveMeta(next);
    this.commit({ spans: this.state.spans.map((s) => (s.id === id ? next : s)) });
  }

  /** A span with no model call (message, system step): recorded as already done. */
  private instantSpan(p: {
    role: RoleId; kind: SpanKind; action: string; why: string; parentId: number | null;
    sectionId: string | null; input?: string; output: string; status?: SpanStatus;
  }): number {
    const id = this.startSpan({ ...p, input: p.input ?? "", model: null });
    this.finishSpan(id, { status: p.status ?? "done", output: p.output });
    return id;
  }

  private failRunningSpans(reason: string, keep: number | null = null) {
    for (const s of this.state.spans) if (s.status === "running" && s.id !== keep) this.finishSpan(s.id, { status: "failed", output: reason, inputTokens: s.inputTokens, outputTokens: s.outputTokens });
  }

  private summary(): RunSummary {
    const s = this.state;
    return {
      runId: s.runId, title: s.title, status: s.status, stopReason: s.stopReason, createdAt: s.createdAt,
      turns: s.totals.turns, tokens: s.totals.inputTokens + s.totals.outputTokens,
      sectionsApproved: s.totals.sectionsApproved,
      sectionCount: s.sections.filter((x) => x.id !== "open").length,
      teamId: s.teamRef?.teamId, teamName: s.teamConfig?.name ?? s.team.name, teamVersion: s.teamRef?.version,
      fileCount: s.files?.length ?? 0,
      outputId: this.output()
    };
  }

  /** Writes the run's row of the runs list in D1 (on create, every status change, after every step). */
  private async syncRunRow() {
    try {
      await upsertRun(this.env.DB, this.summary());
    } catch (e) {
      console.error("D1 runs update failed", e);
    }
  }

  private async queueStep(seq: number, delaySeconds = 0) {
    await this.schedule(delaySeconds, "step", { seq }, { retry: { maxAttempts: 1 } });
  }

  private async finish(status: RunStatus, reason: string | null) {
    if (!this.stepping) this.failRunningSpans(reason ?? "Run ended");
    this.commit({ status, stopReason: reason, endedAt: new Date().toISOString(), activeRole: null });
    for (const s of await this.listSchedules()) if (s.callback === "step") await this.cancelSchedule(s.id);
    await this.syncRunRow();
    // The members no longer need this run's stored turn results (kept only for recovery).
    const names = Object.values(this.state.memberAgents ?? {});
    await Promise.allSettled(names.map(async (n) => (await getAgentByName(this.env.MemberAgent, n)).endRun(this.state.runId)));
  }

  // ---------- public entry points ----------

  /** Called by the Worker (RPC) right after POST /api/runs. */
  async create(input: CreateRunInput): Promise<{ ok: boolean; error?: string }> {
    this.tables();
    if (this.state.runId) return { ok: false, error: "Run already exists" };
    const team = normalizeConfig(input.team);
    const output = outputOf(team);
    this.setState(
      derive({
        ...emptyState(),
        runId: this.name,
        title: input.title,
        task: input.task,
        output,
        team: { name: team.name, version: team.versionLabel },
        teamRef: { teamId: team.teamId, version: team.version },
        teamConfig: team,
        memberAgents: Object.fromEntries(team.members.map((m) => [m.role, memberAgentName(team.teamId, m.role)])),
        files: input.files,
        guardrails: { ...team.guardrails },
        repo: input.repo ? { name: input.repo, branch: input.branch ?? "main" } : null,
        status: "drafting_brief",
        sections: OUTPUTS[output].sections.map((_, i) => initSection(planFor(OUTPUTS[output].sections, i, team.rules))),
        activeRole: team.coordinator,
        createdAt: new Date().toISOString()
      })
    );
    this.kvSet("branchExplicit", !!input.branch);
    this.kvSet("cursor", {
      phase: "brief", seq: 0, section: 0, splitSpanId: null, assignSpanId: null, lastSpanId: null,
      consult: null, sentBacks: 0, failures: 0, noProgress: 0
    } satisfies Cursor);
    await this.queueStep(0);
    await this.syncRunRow();
    if (input.files.length) {
      try {
        await this.env.DB.batch(
          input.files.map((f) => this.env.DB.prepare("INSERT OR IGNORE INTO run_files (run_id, file_id) VALUES (?, ?)").bind(this.name, f.fileId))
        );
      } catch (e) {
        console.error("D1 run_files insert failed", e);
      }
    }
    return { ok: true };
  }

  /** HTTP under /agents/run-agent/<runId>: state, approve, stop, spans, document. */
  async onRequest(request: Request): Promise<Response> {
    this.tables();
    const url = new URL(request.url);
    const sub = url.pathname.replace(/^\/agents\/run-agent\/[^/]+/, "").replace(/\/$/, "") || "/";
    if (!this.state.runId) return Response.json({ error: "Run not found" }, { status: 404 });

    if (sub === "/") {
      if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
      return Response.json(this.state);
    }
    if (sub === "/approve" || sub === "/stop") {
      if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
      return sub === "/approve" ? this.approve(request) : this.stop();
    }
    if (sub === "/spans" && request.method === "GET") return Response.json(this.fullSpans());
    if (sub === "/document" && request.method === "GET") {
      return new Response(this.markdown(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async approve(request: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (!obj(parsed)) throw new Error();
        body = parsed;
      } catch {
        return Response.json({ error: 'Body must be a JSON object: { "brief"?: { goal?, audience?, assumptions?, outOfScope?, doneWhen? } }' }, { status: 400 });
      }
    }
    if (this.state.status !== "awaiting_approval") {
      return Response.json({ error: `Run is "${this.state.status}"; approve only works from "awaiting_approval"` }, { status: 409 });
    }
    const edits: Partial<Brief> = {};
    if (body.brief !== undefined) {
      const b = obj(body.brief);
      if (!b) return Response.json({ error: "brief must be an object" }, { status: 400 });
      for (const k of ["goal", "audience", "assumptions", "outOfScope", "doneWhen"] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "string" || !(b[k] as string).trim() || (b[k] as string).length > 1000) {
          return Response.json({ error: `brief.${k} must be a non-empty string of at most 1000 characters` }, { status: 400 });
        }
        edits[k] = (b[k] as string).trim();
      }
    }
    this.commit({ brief: { ...this.state.brief!, ...edits }, status: "running", startedAt: new Date().toISOString(), activeRole: this.coordinator() });
    const cur = this.loadCursor()!;
    await this.queueStep(cur.seq);
    await this.syncRunRow();
    return Response.json(this.state);
  }

  private async stop(): Promise<Response> {
    if (TERMINAL.includes(this.state.status)) {
      return Response.json({ error: `Run is already "${this.state.status}"` }, { status: 409 });
    }
    await this.finish("stopped", "Stopped by user");
    return Response.json(this.state);
  }

  private fullSpans() {
    return this.sql<Record<string, string | number | null>>`SELECT * FROM spans ORDER BY id`.map((r) => ({
      id: r.id, parentId: r.parent_id, role: r.role, kind: r.kind, action: r.action, why: r.why, status: r.status,
      startMs: r.start_ms, durMs: r.dur_ms, depth: r.depth, sectionId: r.section_id, inputTokens: r.input_tokens,
      outputTokens: r.output_tokens, model: r.model, input: r.input, output: r.output, gatewayLogId: r.gateway_log_id,
      ...(r.meta ? (JSON.parse(String(r.meta)) as SpanMeta) : {})
    }));
  }

  // ---------- the step machine ----------

  /**
   * One step of the step machine (a scheduled task). Ignored unless `seq` matches the stored cursor,
   * so a step never runs twice; checks the guardrails, runs the phase, stores the next cursor and
   * schedules the next step (or finishes the run).
   */
  async step(payload: { seq: number }) {
    this.tables();
    if (this.stepping) return;
    const cur = this.loadCursor();
    if (!cur || payload?.seq !== cur.seq || !ACTIVE.includes(this.state.status)) return;
    if (this.state.status === "running" && cur.phase === "brief") return;
    this.stepping = true;
    this.currentSeq = cur.seq;
    // A member turn that was in flight when the agent restarted is resumed with the same span id
    // (the member returns its stored result instead of calling the model again).
    const pending = this.kvGet<PendingTurn>("pendingTurn");
    try {
      this.failRunningSpans("Interrupted (the agent restarted); the step is retried", pending && pending.seq === cur.seq ? pending.spanId : null);
      if (this.state.status === "running") {
        const reason = this.guardrail(cur);
        if (reason) return void (await this.finish("stopped", reason));
      }
      let next: Cursor;
      try {
        next = await this.runPhase({ ...cur });
      } catch (e) {
        const reason = e instanceof RunError ? e.message : `Unexpected error in step "${cur.phase}": ${errMsg(e)}`;
        console.error(reason, e);
        if (ACTIVE.includes(this.state.status)) await this.finish("failed", reason);
        return;
      }
      next.seq = cur.seq + 1;
      this.kvSet("cursor", next);
      if (!ACTIVE.includes(this.state.status)) return void (await this.syncRunRow()); // stopped mid-step, or brief ready
      if (next.phase === "done") return void (await this.finish("completed", null));
      await this.queueStep(next.seq);
      await this.syncRunRow();
    } finally {
      this.dropPending("Interrupted (the step took another path); the step is retried");
      this.stepping = false;
    }
  }

  /** A pending member turn that no phase picked up again: fail its span. */
  private dropPending(reason: string) {
    const p = this.kvGet<PendingTurn>("pendingTurn");
    if (!p) return;
    const span = this.state.spans.find((x) => x.id === p.spanId);
    if (span?.status === "running") this.finishSpan(span.id, { status: "failed", output: reason });
    this.kvDel("pendingTurn");
  }

  private guardrail(cur: Cursor): string | null {
    const t = this.state.totals;
    const g = this.state.guardrails;
    const tokens = t.inputTokens + t.outputTokens;
    if (t.turns >= g.maxTurns) return `Guardrail: turn limit reached (${t.turns} of ${g.maxTurns} turns)`;
    if (tokens >= g.maxTokens) return `Guardrail: token budget used up (${tokens} of ${g.maxTokens} tokens)`;
    if (cur.noProgress >= g.noProgressTurns) return `Guardrail: no progress for ${cur.noProgress} turns in a row`;
    return null;
  }

  private nextSection(cur: Cursor): Cursor {
    const plans = this.sectionPlans();
    let i = cur.section + 1;
    while (i < plans.length && plans[i].id === "open") i++;
    const base = { ...cur, assignSpanId: null, lastSpanId: null, consult: null, sentBacks: 0, failures: 0, sizingDone: false, sizing: null, sizingRetry: false };
    return i < plans.length ? { ...base, section: i, phase: "assign" } : { ...base, phase: "open" };
  }

  /** A failed model turn: retry the phase once at the next step; then fail the run or skip ahead. */
  private failed(cur: Cursor, res: LlmOutcome<unknown>, what: string, skipTo: Cursor | null): Cursor {
    if (res.quota) throw new RunError(`Workers AI refused the call (free allowance used up?): ${res.error}`);
    if (cur.failures < 1) return { ...cur, failures: cur.failures + 1, noProgress: cur.noProgress + 1 };
    if (!skipTo) throw new RunError(`${what} failed twice: ${res.error}`);
    return { ...skipTo, failures: 0, noProgress: cur.noProgress + 1 };
  }

  private repoData(): RepoData | null {
    return this.kvGet<RepoData>("repo");
  }
  /** True the first time the repo reader (the Engineer) works on a run with a linked repo. */
  private needsRepo(role: RoleId) {
    return role === this.repoRole() && !!this.state.repo && !this.repoData();
  }
  private repoContext(role: RoleId): string | null {
    const r = role === this.repoRole() && hasTool(this.teamConfig(), role, "github_repo") ? this.repoData() : null;
    return r?.ok ? trunc(r.text, 1800) : null;
  }
  private noteRepoSource(sectionId: string) {
    const r = this.repoData();
    const reader = this.repoRole();
    if (!r || !reader) return;
    const who = roleName(reader);
    const src = r.ok
      ? `GitHub ${this.state.repo!.name}@${r.branch}: metadata, top-level files, README (span #${r.spanId})`
      : r.skipped
        ? `GitHub ${this.state.repo!.name}: not read, the ${who} has no github_repo tool in ${this.teamConfig().versionLabel}; ${who} worked in technical-questions-only mode`
        : `GitHub ${this.state.repo!.name}: not readable (${r.note}); ${who} worked in technical-questions-only mode`;
    this.patchSection(sectionId, (s) => (s.sources.includes(src) ? s : { ...s, sources: [...s.sources, src] }));
  }

  /** The Engineer's github_repo tool: runs once per run as its own step, the first time the reader works. */
  private async repoTool(cur: Cursor, parentId: number | null, sectionId: string): Promise<Cursor> {
    const repo = this.state.repo!;
    const reader = this.repoRole()!;
    const who = roleName(reader);
    if (!hasTool(this.teamConfig(), reader, "github_repo")) {
      // The team version took the tool away: say so once, and work in technical-questions-only mode.
      const v = this.teamConfig().versionLabel;
      const id = this.instantSpan({
        role: reader, kind: "system", action: `Skip GitHub repo ${repo.name} (no github_repo tool)`, sectionId, parentId,
        why: `The ${who} has no github_repo tool in ${this.teamConfig().name} ${v}`,
        input: `Linked repo: ${repo.name}`,
        output: `Not read: the github_repo tool is not enabled for the ${who} in ${v}. The ${who} answers technical questions only.`
      });
      this.kvSet("repo", { ok: false, text: "", note: "no github_repo tool", branch: repo.branch, spanId: id, skipped: true } satisfies RepoData);
      return { ...cur, failures: 0 };
    }
    const explicit = this.kvGet<boolean>("branchExplicit");
    const id = this.startSpan({
      role: reader, kind: "tool", action: `Read GitHub repo ${repo.name}`, sectionId, parentId, model: null,
      why: "Check feasibility and effort against the real code before answering",
      input: `GET api.github.com/repos/${repo.name} (metadata, top-level contents, README${explicit ? `, ref ${repo.branch}` : ""})`
    });
    const r = await readRepo(repo.name, explicit ? repo.branch : null);
    this.kvSet("repo", { ...r, spanId: id } satisfies RepoData);
    this.finishSpan(id, {
      status: r.ok ? "done" : "failed",
      output: r.ok ? r.text + (r.note ? `\n\nPartial: ${r.note}` : "") : `${r.note}. The ${who} continues without the code.`
    });
    if (r.ok && r.branch !== repo.branch) this.commit({ repo: { ...repo, branch: r.branch } });
    return { ...cur, failures: 0 };
  }

  // ----- read_files tool -----

  private markdownCache = new Map<string, string>();
  private async fileText(fileId: string): Promise<string> {
    let t = this.markdownCache.get(fileId);
    if (t === undefined) {
      t = await getFileMarkdown(this.env.DB, fileId);
      this.markdownCache.set(fileId, t);
    }
    return t;
  }
  private filesReadBy(): RoleId[] {
    return this.kvGet<RoleId[]>("filesRead") ?? [];
  }
  /** True the first time an owner with read_files drafts on a run that has files. */
  private needsFiles(role: RoleId) {
    return !!this.state.files?.length && hasTool(this.teamConfig(), role, "read_files") && !this.filesReadBy().includes(role);
  }

  /**
   * The read_files tool: one "Read <filename>" tool span per file, once per run per role that
   * owns sections (the first time it drafts). Per-section excerpts are then chosen without new
   * spans (see `fileExcerpts`), so spans aren't repeated for every section.
   */
  private async filesTool(cur: Cursor, role: RoleId, parentId: number | null, sectionId: string): Promise<Cursor> {
    for (const f of this.state.files ?? []) {
      const id = this.startSpan({
        role, kind: "tool", action: `Read ${f.name}`, sectionId, parentId, model: null,
        why: "Ground the sections in the uploaded context files",
        input: `read_files: ${f.name} (${f.fileId}, ${f.mimeType})`
      });
      try {
        const text = await this.fileText(f.fileId);
        this.finishSpan(id, {
          status: text ? "done" : "failed",
          output: text
            ? `${f.chars.toLocaleString("en-US")} characters of Markdown from a ${f.bytes.toLocaleString("en-US")}-byte file${f.truncated ? " (cut at 60,000 characters on upload)" : ""}.\n\nExcerpt:\n${trunc(text, 400)}`
            : "The file has no extracted text."
        });
      } catch (e) {
        this.finishSpan(id, { status: "failed", output: `Could not read the file: ${errMsg(e)}` });
      }
    }
    this.kvSet("filesRead", [...this.filesReadBy(), role]);
    return { ...cur, failures: 0 };
  }

  /** Relevant file text for one section (≤ FILE_BUDGET chars) if the owner has read the files. */
  private async fileExcerpts(role: RoleId, plan: SectionPlan): Promise<Excerpt[]> {
    const files = this.state.files ?? [];
    if (!files.length || !hasTool(this.teamConfig(), role, "read_files") || !this.filesReadBy().includes(role)) return [];
    const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, markdown: await this.fileText(f.fileId) })));
    const query = `${plan.name} ${plan.guidance} ${this.state.brief?.goal ?? ""} ${this.state.task}`;
    return selectExcerpts(loaded, query, FILE_BUDGET);
  }
  private noteFileSources(sectionId: string, excerpts: Excerpt[]) {
    if (!excerpts.length) return;
    const add = excerpts.map((e) => (e.whole ? e.name : `${e.name}, excerpt`));
    this.patchSection(sectionId, (s) => ({ ...s, sources: [...s.sources, ...add.filter((a) => !s.sources.includes(a))] }));
  }

  // ----- sample_size tool -----

  private sampleSizes(): SizingNote[] {
    return this.kvGet<SizingNote[]>("sampleSizes") ?? [];
  }
  /**
   * True when `role` has the sample_size tool and hasn't decided yet for this section, and either
   * the section is one that needs a sample size (Sample and controls, Analysis plan) or the
   * question asked of the role is about sample size.
   */
  private needsSizing(cur: Cursor, role: RoleId, plan: SectionPlan, question: string | null): boolean {
    if (cur.sizingDone || !hasTool(this.teamConfig(), role, "sample_size")) return false;
    return SIZING_SECTIONS.includes(plan.id) || (!!question && SIZING_QUESTION.test(question));
  }
  /** The calculator result that applies to this section: its own, else (for sizing sections) the run's latest. */
  private sizingFor(cur: Cursor, plan: SectionPlan): SizingNote | null {
    if (cur.sizing) return cur.sizing;
    if (!SIZING_SECTIONS.includes(plan.id)) return null;
    const all = this.sampleSizes();
    return all.length ? all[all.length - 1] : null;
  }
  private sizingText(n: SizingNote | null): string {
    return n ? sizingBlock(n.label, n.result) : "";
  }
  private noteSizingSource(sectionId: string, n: SizingNote | null) {
    if (!n) return;
    const src = `Sample size: ${n.result.perGroup.toLocaleString("en-US")} per group, ${n.result.total.toLocaleString("en-US")} total (${TOOL_LABELS.sample_size}, ${n.label}; span #${n.toolSpanId})`;
    this.patchSection(sectionId, (s) => (s.sources.includes(src) ? s : { ...s, sources: [...s.sources, src] }));
  }

  /**
   * One model turn: the role decides whether to use the calculator and with which request.
   * If it does, the engine computes it (no model) and records a "tool" span whose input is the
   * SampleSizeRequest (JSON) and whose output is the SampleSizeResult (JSON) or the validation error.
   */
  private async sizingTool(cur: Cursor, role: RoleId, parentId: number | null, plan: SectionPlan, question: string | null, askSpanId: number | null = null): Promise<Cursor> {
    const earlier = this.sampleSizes().map((n) => `${n.result.perGroup} per group, ${n.result.total} total (${n.label}), for ${this.section(n.sectionId)?.name ?? n.sectionId}`);
    // Give the decision the data it needs: excerpts chosen for baseline rates and effect sizes.
    const sizingPlan = { ...plan, guidance: `${plan.guidance} baseline rate retention conversion percentage cohort minimum detectable effect ${question ?? ""}` };
    const excerpts = await this.fileExcerpts(role, sizingPlan);
    this.noteFileSources(plan.id, excerpts);
    // The member reads the consult question (if any) from its own inbox.
    const res = await this.memberSpan<SizingOut>({
      role, kind: "work", action: `Decide on sample size (${plan.name})`, parentId, sectionId: plan.id,
      why: "Decide whether the sample-size calculator is needed, and with which parameters",
      task: { kind: "decide_sizing", plan, refs: { question: askSpanId }, earlier, files: filesBlock(excerpts) },
      show: (d) => (d.use && d.request ? `Use calculator: ${describeRequest(d.request)}` : "Calculator not needed")
    });
    const done = (sizing: SizingNote | null): Cursor => ({ ...cur, failures: 0, sizingDone: true, sizing });
    if (!res.data) return this.failed(cur, res, "Sample-size decision", done(null));
    if (!res.data.use || !res.data.request) return done(null);
    const request = res.data.request;
    // Don't call the calculator with missing inputs (e.g. no baseline rate found): the decision
    // span says why, and the drafter works without a computed number instead of a failed tool call.
    const missing = request.test === "two_means" ? !(Number.isFinite(request.effectSize))
      : !(Number.isFinite(request.p1) && Number.isFinite(request.p2));
    if (missing) {
      this.finishSpan(res.spanId, { status: "done", output: "Calculator not run: the inputs it needs (baseline and target rates, or an effect size) were not found in the brief or files." });
      return done(null);
    }
    const label = describeRequest(request);
    const toolSpanId = this.startSpan({
      role, kind: "tool", action: `Sample size: ${label}`, sectionId: plan.id, parentId: res.spanId, model: null,
      why: res.data.why || "Compute the sample size in code instead of estimating it",
      input: JSON.stringify(request)
    });
    const result = sampleSize(request);
    if ("error" in result) {
      this.finishSpan(toolSpanId, { status: "failed", output: `Invalid request: ${result.error}` });
      return done(null);
    }
    this.finishSpan(toolSpanId, { status: "done", output: JSON.stringify(result) });
    const note: SizingNote = { toolSpanId, label, request, result, sectionId: plan.id };
    this.kvSet("sampleSizes", [...this.sampleSizes(), note]);
    return done(note);
  }

  // ---------- members (RPC to MemberAgent) ----------

  private teamId(): string {
    return this.state.teamRef?.teamId ?? DEFAULT_TEAM_ID;
  }
  private agentName(role: RoleId): string {
    return this.state.memberAgents?.[role] ?? memberAgentName(this.teamId(), role);
  }
  private member(role: RoleId) {
    return getAgentByName(this.env.MemberAgent, this.agentName(role));
  }

  /** Task, approved brief and the sections approved so far (minus the one being worked on). */
  private contextFor(excludeId: string | null): TurnRequest["ctx"] {
    const approved = this.state.sections.filter((s) => s.status === "approved" && s.id !== excludeId).map((s) => ({ name: s.name, content: s.content }));
    return { task: this.state.task, brief: this.state.brief, approved };
  }

  /** member.turn over DO RPC, with a coordinator-side timeout so a hung member can't stall the run. */
  private async callMember(role: RoleId, req: TurnRequest): Promise<TurnResult> {
    const name = this.agentName(role);
    const fail = (error: string): TurnResult => ({
      data: null, raw: "", attempts: 0, error, quota: false, inputTokens: 0, outputTokens: 0, gatewayLogId: null,
      memoriesUsed: [], model: this.modelOf(role), prompt: "", cached: false, stored: []
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stub = await this.member(role);
      const call = stub.turn(req) as unknown as Promise<TurnResult>;
      const timeout = new Promise<TurnResult>((resolve) => {
        timer = setTimeout(() => resolve(fail(`no reply from ${name} within ${MEMBER_TIMEOUT_MS / 1000} s`)), MEMBER_TIMEOUT_MS);
      });
      return await Promise.race([call, timeout]);
    } catch (e) {
      return fail(`RPC to ${name} failed: ${errMsg(e)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * One member turn recorded as one span (both attempts of a JSON retry live inside it). The span is
   * the coordinator's record; the member builds the prompt, calls the model and returns the result.
   */
  private async memberSpan<T>(p: {
    role: RoleId; kind: SpanKind; action: string; why: string; parentId: number | null; sectionId: string | null;
    task: MemberTask; status?: (d: T) => SpanStatus; show?: (d: T) => string;
  }): Promise<LlmOutcome<T> & { spanId: number; stored: number[] }> {
    const agent = this.agentName(p.role);
    const pending = this.kvGet<PendingTurn>("pendingTurn");
    const resumed = pending && pending.seq === this.currentSeq && pending.action === p.action && pending.role === p.role
      ? this.state.spans.find((s) => s.id === pending.spanId && s.status === "running")
      : undefined;
    const spanId = resumed
      ? resumed.id
      : this.startSpan({ ...p, input: `Task "${p.task.kind}" sent to ${agent}`, model: this.modelOf(p.role), agent });
    if (!resumed) this.kvSet("pendingTurn", { seq: this.currentSeq, spanId, action: p.action, role: p.role } satisfies PendingTurn);
    const res = await this.callMember(p.role, {
      ...p.task,
      runId: this.state.runId, spanId, teamVersion: this.state.teamRef?.version ?? 1, team: this.teamConfig(), output: this.output(),
      label: p.action, sectionId: p.sectionId, ctx: this.contextFor(p.sectionId)
    });
    const d = res.data as T | null;
    this.finishSpan(spanId, {
      status: d ? (p.status ? p.status(d) : "done") : "failed",
      output: d ? (p.show ? p.show(d) : res.raw) : `Failed after ${res.attempts} attempt(s): ${res.error}${res.raw ? `\n\n${res.raw}` : ""}`,
      why: d ? asText((d as { why?: unknown }).why) || undefined : undefined,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens, gatewayLogId: res.gatewayLogId,
      input: res.prompt || undefined, memoriesUsed: res.memoriesUsed, model: res.model || undefined
    });
    this.kvDel("pendingTurn");
    return {
      ok: !!d, data: d, raw: res.raw, error: res.error, quota: res.quota, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      gatewayLogId: res.gatewayLogId, attempts: res.attempts, spanId, stored: res.stored
    };
  }

  /**
   * Deliver a message to a member's inbox, only along the team's handoff rules (by construction it
   * always holds; if not, nothing is delivered). Returns null on success, else the reason.
   */
  private async deliver(spanId: number, from: RoleId, to: RoleId, kind: InboxKind, text: string, sectionId: string | null): Promise<string | null> {
    if (!canMessage(from, to, this.teamConfig().rules)) {
      return `${roleName(from)} may not message ${roleName(to)} under ${this.teamConfig().versionLabel}'s handoff rules`;
    }
    try {
      await (await this.member(to)).deliver({ runId: this.state.runId, from, kind, text, spanId, sectionId });
      return null;
    } catch (e) {
      console.error("deliver failed", e);
      return `delivery to ${this.agentName(to)} failed: ${errMsg(e)}`;
    }
  }

  /** A message span (no model call) whose text is delivered to the recipient's inbox. */
  private async msgSpan(p: {
    role: RoleId; action: string; why: string; parentId: number | null; sectionId: string | null; output: string;
    to: RoleId; inbox: InboxKind; text: string;
  }): Promise<number> {
    const id = this.startSpan({ role: p.role, kind: "msg", action: p.action, why: p.why, parentId: p.parentId, sectionId: p.sectionId, input: "", model: null });
    const err = await this.deliver(id, p.role, p.to, p.inbox, p.text, p.sectionId);
    this.finishSpan(id, err
      ? { status: "failed", output: `${p.output}\n\nNot delivered: ${err}` }
      : { status: "done", output: p.output, delivered: { to: p.to, kind: p.inbox } });
    return id;
  }

  /**
   * Deliver the result of a model span (consult answer, Critic's note). `delivered` is only set on
   * msg spans (contract/UI), so here only a failed delivery is recorded (span failed, reason in output).
   */
  private async deliverFromSpan(spanId: number, from: RoleId, to: RoleId, kind: InboxKind, text: string, sectionId: string | null) {
    const err = await this.deliver(spanId, from, to, kind, text, sectionId);
    if (err) {
      const span = this.state.spans.find((s) => s.id === spanId);
      this.patchSpan(spanId, { status: "failed", output: `${span?.output ?? ""}\n\nNot delivered: ${err}` });
    }
    return !err;
  }

  /** Store an outcome / lesson in a member's memory (no model call). */
  private async remember(role: RoleId, kind: "outcome" | "lesson", text: string, sectionId: string, key: string) {
    try {
      await (await this.member(role)).remember({ kind, text, runId: this.state.runId, teamVersion: this.state.teamRef?.version ?? 1, sectionId, key });
    } catch (e) {
      console.error("remember failed", e);
    }
  }

  /** Runs the cursor's phase (one step) and returns the next cursor. */
  private async runPhase(cur: Cursor): Promise<Cursor> {
    switch (cur.phase) {
      case "brief": return this.briefPhase(cur);
      case "split": return this.splitPhase(cur);
      case "assign": return this.assignPhase(cur);
      case "decide": return this.decidePhase(cur);
      case "answer": return this.answerPhase(cur);
      case "draft": return this.draftPhase(cur);
      case "review": return this.reviewPhase(cur);
      case "revise": return this.revisePhase(cur);
      case "open": return this.openQuestionsPhase(cur);
      case "reflect": return this.reflectPhase(cur);
      case "assemble": return this.assemblePhase(cur);
      default: return cur;
    }
  }

  /** The cursor after a successful phase: `patch` applied, the failure count reset. */
  private advance(cur: Cursor, patch: Partial<Cursor>): Cursor {
    return { ...cur, ...patch, failures: 0 };
  }

  /** The coordinator drafts the brief; the run then waits for the user's approval. */
  private async briefPhase(cur: Cursor): Promise<Cursor> {
    const repo = this.state.repo ? this.state.repo.name : null;
    const reader = this.repoRole();
    const res = await this.memberSpan<BriefOut>({
      role: this.coordinator(), kind: "work", action: "Draft brief", parentId: null, sectionId: null,
      why: `Turn the task into a brief for the ${this.outputName()} that the user can approve`,
      task: {
        kind: "brief",
        repoLine: repoLine(repo, reader && roleName(reader), !!reader && hasTool(this.teamConfig(), reader, "github_repo")),
        fileNames: (this.state.files ?? []).map((f) => f.name)
      },
      show: (d) => briefText(d.brief)
    });
    if (!res.data) return this.failed(cur, res, "Drafting the brief", null);
    if (this.state.status !== "drafting_brief") return this.advance(cur, { phase: "split" });
    this.commit({ brief: res.data.brief, status: "awaiting_approval", activeRole: null });
    return this.advance(cur, { phase: "split" });
  }

  /** After approval: one system span lists who does what, and the brief goes to every member's inbox. */
  private async splitPhase(cur: Cursor): Promise<Cursor> {
    const team = this.teamConfig();
    const plans = this.sectionPlans();
    const lines = plans.map((tpl, i) => {
      const s = this.plan(i);
      const off = tpl.consults.filter((r) => !s.consults.includes(r));
      return `${s.name} → ${roleName(s.owner)}${s.consults.length ? ` (may consult ${s.consults.map(roleName).join(", ")})` : ""}` +
        `${off.length ? ` (no consult with ${off.map(roleName).join(", ")}: not allowed by ${team.versionLabel}'s handoff rules)` : ""}` +
        `${s.id === "open" ? " — compiled at the end, not reviewed" : ""}`;
    });
    lines.unshift(`Team: ${team.name} ${team.versionLabel} (${team.note})`, "");
    const files = this.state.files ?? [];
    const reader = this.repoRole();
    if (this.state.repo && reader && !hasTool(team, reader, "github_repo")) {
      lines.push("", `Repo ${this.state.repo.name} is linked, but the ${roleName(reader)} has no github_repo tool in ${team.versionLabel}: technical questions only.`);
    }
    const sizers = withTool(team, "sample_size");
    if (sizers.length && plans.some((p) => SIZING_SECTIONS.includes(p.id))) {
      lines.push("", `${sizers.map(roleName).join(", ")}: ${TOOL_LABELS.sample_size} offered before ${plans.filter((p) => SIZING_SECTIONS.includes(p.id)).map((p) => p.name).join(" and ")} (and when consulted about sample size).`);
    }
    if (files.length) {
      const owners = [...new Set(plans.map((s) => s.owner))];
      const readers = owners.filter((r) => hasTool(team, r, "read_files"));
      lines.push("", readers.length
        ? `${files.length} context file(s) (${files.map((f) => f.name).join(", ")}): read by ${readers.map(roleName).join(", ")} before drafting.`
        : `${files.length} context file(s) attached, but no section owner has the read_files tool in ${team.versionLabel}; they are not read.`);
    }
    const id = this.startSpan({
      role: this.coordinator(), kind: "system", action: "Split brief into sections", parentId: null, sectionId: null,
      why: `The ${this.outputName()} template fixes the sections; each goes to the role responsible for it`,
      input: briefText(this.state.brief!), model: null
    });
    const sent: string[] = [];
    const notSent: string[] = [];
    for (const m of team.members.filter((x) => x.role !== this.coordinator())) {
      const err = await this.deliver(id, this.coordinator(), m.role, "brief", briefText(this.state.brief!), null);
      if (err) notSent.push(`${m.role} (${err})`);
      else sent.push(m.role);
    }
    lines.push("", `Approved brief delivered to the inboxes of ${sent.join(", ") || "nobody"}${notSent.length ? `; not delivered to ${notSent.join(", ")}` : ""}.`);
    this.finishSpan(id, { status: "done", output: lines.join("\n") });
    return this.nextSection({ ...cur, section: -1, splitSpanId: id });
  }

  /** The coordinator assigns the section to its owner (a message span, skipped for its own sections). */
  private async assignPhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const owner = plan.owner;
    this.patchSection(plan.id, (s) => ({ ...s, status: "drafting" }));
    let assignSpanId = cur.splitSpanId;
    if (owner !== this.coordinator()) {
      assignSpanId = await this.msgSpan({
        role: this.coordinator(), action: `Assign ${plan.name} to ${roleName(owner)}`, parentId: cur.splitSpanId,
        sectionId: plan.id, why: `${roleName(owner)} is responsible for this section`,
        output: `Guidance: ${plan.guidance}`,
        to: owner, inbox: "assign", text: `The ${roleName(this.coordinator())} assigned you "${plan.name}". Guidance: ${plan.guidance}`
      });
    }
    this.commit({ activeRole: owner });
    return this.advance(cur, { assignSpanId, phase: plan.consults.length ? "decide" : "draft" });
  }

  /** The owner decides whether to ask one allowed consult a question before drafting. */
  private async decidePhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const owner = plan.owner;
    const rules = this.teamConfig().rules;
    const res = await this.memberSpan<DecideOut>({
      role: owner, kind: "work", action: `Plan ${plan.name}`, parentId: cur.assignSpanId, sectionId: plan.id,
      why: "Decide whether to consult before drafting",
      task: { kind: "decide_consult", plan, hints: this.consultHints(plan) },
      show: (d) => (d.consult ? `Consult ${d.role}: ${d.question}` : "Draft alone")
    });
    if (!res.data) return this.failed(cur, res, "Planning", this.advance(cur, { phase: "draft" }));
    const d = res.data;
    const role = (Object.keys(ROLES) as RoleId[]).find(
      (r) => r === d.role || ROLES[r].name.toUpperCase() === d.role || d.role.startsWith(`${r} `) || d.role.startsWith(`"${r}"`)
    );
    const allowed = !!role && plan.consults.includes(role) && canMessage(owner, role, rules) && canMessage(role, owner, rules);
    if (d.consult && role && allowed && d.question) {
      const askSpanId = await this.msgSpan({
        role: owner, action: `Ask ${roleName(role)}: ${trunc(d.question, 90)}`, parentId: res.spanId,
        sectionId: plan.id, why: d.why || "Their answer improves the section", output: d.question,
        to: role, inbox: "question", text: d.question
      });
      return this.advance(cur, { phase: "answer", consult: { role, question: d.question, askSpanId, answer: null } });
    }
    if (d.consult && !allowed) console.warn(`Ignored consult of "${d.role}" for ${plan.id}: not allowed by the handoff rules`);
    return this.advance(cur, { phase: "draft" });
  }

  /**
   * The consulted member answers (reading the question from its inbox). Its tools run first, one
   * step each: the GitHub repo, and for a sample-size question the files and the calculator.
   */
  private async answerPhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const owner = plan.owner;
    const c = cur.consult!;
    if (this.needsRepo(c.role)) return this.repoTool(cur, c.askSpanId, plan.id);
    if (this.needsSizing(cur, c.role, plan, c.question)) {
      // The calculator needs real inputs (e.g. a baseline rate from the attached data), so a
      // consulted role with read_files reads the files first — a visible step in the trace.
      if (this.needsFiles(c.role)) return this.filesTool(cur, c.role, c.askSpanId, plan.id);
      return this.sizingTool(cur, c.role, c.askSpanId, plan, c.question, c.askSpanId);
    }
    const res = await this.memberSpan<AnswerOut>({
      role: c.role, kind: "work", action: `Answer ${roleName(owner)}`, parentId: c.askSpanId, sectionId: plan.id,
      why: `${roleName(owner)} asked for input on ${plan.name}`,
      task: { kind: "answer", plan, refs: { question: c.askSpanId }, repoContext: this.repoContext(c.role), sizing: this.sizingText(cur.sizing ?? null) },
      show: (d) => d.answer
    });
    if (!res.data) return this.failed(cur, res, "Consult answer", this.advance(cur, { phase: "draft", consult: null }));
    const answer = res.data.answer;
    await this.deliverFromSpan(res.spanId, c.role, owner, "answer", `Re: "${c.question}"\n${answer}`, plan.id);
    this.patchSection(plan.id, (s) => ({
      ...s,
      consulted: s.consulted.includes(c.role) ? s.consulted : [...s.consulted, c.role],
      sources: [...s.sources, `Consulted ${roleName(c.role)}: "${trunc(answer, 200)}" (span #${res.spanId})`]
    }));
    if (c.role === this.repoRole()) this.noteRepoSource(plan.id);
    return this.advance(cur, { phase: "draft", consult: { ...c, answer, answerSpanId: res.spanId }, noProgress: 0 });
  }

  /** The owner drafts the section (its tools run first, one step each). */
  private async draftPhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const owner = plan.owner;
    if (this.needsRepo(owner)) return this.repoTool(cur, cur.assignSpanId, plan.id);
    if (this.needsFiles(owner)) return this.filesTool(cur, owner, cur.assignSpanId, plan.id);
    if (this.needsSizing(cur, owner, plan, null)) return this.sizingTool(cur, owner, cur.assignSpanId, plan, null);
    const excerpts = await this.fileExcerpts(owner, plan);
    const sizing = this.sizingFor(cur, plan);
    // The owner reads its assignment and the consult answer from its own inbox.
    const res = await this.memberSpan<DraftOut>({
      role: owner, kind: "work", action: `Draft ${plan.name}`, parentId: cur.assignSpanId, sectionId: plan.id,
      why: plan.guidance,
      task: {
        kind: "draft", plan,
        refs: { assign: cur.assignSpanId, answer: cur.consult?.answer ? cur.consult.answerSpanId ?? null : null },
        repoContext: this.repoContext(owner), files: filesBlock(excerpts), sizing: this.sizingText(sizing)
      },
      show: showDraft
    });
    if (!res.data) return this.failed(cur, res, `Drafting ${plan.name}`, null);
    const d = res.data;
    this.patchSection(plan.id, (s) => ({
      ...s, status: "in_review", rounds: s.rounds + 1, content: d.bullets,
      sources: s.sources.includes("Approved brief") ? s.sources : ["Approved brief", ...s.sources]
    }));
    if (owner === this.repoRole()) this.noteRepoSource(plan.id);
    this.noteFileSources(plan.id, excerpts);
    this.noteSizingSource(plan.id, sizing);
    this.addQuestions(d.openQuestions, owner);
    return this.advance(cur, { phase: "review", lastSpanId: res.spanId, noProgress: 0 });
  }

  /**
   * The Critic reviews the draft. The automatic sample-size check runs first and, when it objects,
   * takes the place of the model review for this round. After `criticRounds` send-backs the review
   * is the last: an objection then approves the section with the note kept.
   */
  private async reviewPhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const sec = this.section(plan.id);
    const max = this.state.guardrails.criticRounds;
    const atLimit = cur.sentBacks >= max;
    const action = `Review ${plan.name}${cur.sentBacks ? ` (round ${cur.sentBacks + 1})` : ""}`;

    const check = this.sampleSizeCheck(plan, sec.content);
    if (check) {
      const output = atLimit
        ? `Automatic check still objects: ${check.note}\nApproved anyway: the limit of ${max} send-backs is reached, so the note is kept on the section. Returned to ${roleName(this.coordinator())}.`
        : `Sent back to ${roleName(plan.owner)} (round ${cur.sentBacks + 1} of ${max}): ${check.note}`;
      const spanId = this.instantSpan({
        role: CRITIC, kind: "review", action: `${action} (automatic check)`, why: SAMPLE_SIZE_CHECK_WHY,
        parentId: cur.lastSpanId, sectionId: plan.id, input: `Stated sample size(s) not computed by the calculator: ${check.claims.join(", ")}`,
        output, status: atLimit ? "approved" : "sent_back"
      });
      if (atLimit) return this.approveSection(cur, plan, spanId, check.note);
      // One more sizing decision on revise if nobody has computed a sample size for this section yet.
      const computed = !!cur.sizing || this.sampleSizes().some((n) => n.sectionId === plan.id);
      return this.sendBack(cur, plan, spanId, check.note, { sizingRetry: !computed });
    }

    const res = await this.memberSpan<ReviewOut>({
      role: CRITIC, kind: "review", action,
      parentId: cur.lastSpanId, sectionId: plan.id, why: "Check the section against the brief and its guidance",
      task: { kind: "review", plan, draft: sec.content, sentBacks: cur.sentBacks, maxRounds: max, sizing: this.sizingText(this.sizingFor(cur, plan)) },
      status: (d) => (d.verdict === "approved" || atLimit ? "approved" : "sent_back"),
      show: (d) =>
        d.verdict === "approved"
          ? `Approved: ${d.note}\nReturned to ${roleName(this.coordinator())}.`
          : atLimit
            ? `Critic still objects: ${d.note}\nApproved anyway: the limit of ${max} send-backs is reached, so the note is kept on the section. Returned to ${roleName(this.coordinator())}.`
            : `Sent back to ${roleName(plan.owner)} (round ${cur.sentBacks + 1} of ${max}): ${d.note}`
    });
    if (!res.data) return this.failed(cur, res, `Reviewing ${plan.name}`, null);
    const d = res.data;
    if (d.verdict === "approved") return this.approveSection(cur, plan, res.spanId, null);
    if (atLimit) return this.approveSection(cur, plan, res.spanId, d.note);
    return this.sendBack(cur, plan, res.spanId, d.note, {});
  }

  /**
   * The sample-size guard: in a section that needs a sample size, on a team with the calculator,
   * the draft may only state participant counts the calculator produced in this run (± 1).
   * Returns the objection, or null when there is nothing to object to.
   */
  private sampleSizeCheck(plan: SectionPlan, content: string[]): { claims: number[]; note: string } | null {
    if (!SIZING_SECTIONS.includes(plan.id) || !withTool(this.teamConfig(), "sample_size").length) return null;
    const results = this.sampleSizes().map((n) => n.result);
    const claims = unverifiedSampleSizes(content.join("\n"), results);
    return claims.length ? { claims, note: sampleSizeCheckNote(claims, results) } : null;
  }

  /**
   * Approves the section after a review span. `keptNote` is the objection at the send-back limit:
   * it is kept in the section's sources. The owner remembers the outcome; then the next section.
   */
  private async approveSection(cur: Cursor, plan: SectionPlan, reviewSpanId: number, keptNote: string | null): Promise<Cursor> {
    // section.reviews only holds send-backs (the UI relies on that).
    this.patchSection(plan.id, (s) => ({
      ...s, status: "approved",
      sources: keptNote ? [...s.sources, `Critic's note kept at the send-back limit: "${trunc(keptNote, 300)}" (span #${reviewSpanId})`] : s.sources
    }));
    const done = this.section(plan.id);
    const lastNote = done.reviews[done.reviews.length - 1]?.note;
    await this.remember(plan.owner, "outcome",
      `${plan.name}: approved after ${done.rounds} draft(s)${keptNote ? " with the Critic's note kept" : ""}` +
        `${lastNote ? `; the Critic had asked: ${trunc(lastNote, 110)}` : ""}. Gist: ${trunc(done.content[0] ?? "", 120)}`,
      plan.id, `outcome:${this.state.runId}:${plan.id}`);
    return { ...this.nextSection(cur), noProgress: 0 };
  }

  /** Sends the section back after a review span: the note goes to the owner's inbox and memory. */
  private async sendBack(cur: Cursor, plan: SectionPlan, reviewSpanId: number, note: string, patch: Partial<Cursor>): Promise<Cursor> {
    this.patchSection(plan.id, (s) => ({
      ...s, status: "sent_back",
      reviews: [...s.reviews, { round: cur.sentBacks + 1, verdict: "sent_back" as const, note, before: s.content }]
    }));
    await this.deliverFromSpan(reviewSpanId, CRITIC, plan.owner, "review", note, plan.id);
    await this.remember(plan.owner, "lesson", `${plan.name}: ${note}`, plan.id, `lesson:${this.state.runId}:${reviewSpanId}`);
    return this.advance(cur, { ...patch, phase: "revise", lastSpanId: reviewSpanId, sentBacks: cur.sentBacks + 1, noProgress: cur.noProgress + 1 });
  }

  /**
   * The owner revises against the note (read from its inbox). After an automatic sample-size
   * send-back with no calculator result for the section, one more sizing decision runs first.
   */
  private async revisePhase(cur: Cursor): Promise<Cursor> {
    const plan = this.plan(cur.section);
    const owner = plan.owner;
    if (cur.sizingRetry) return this.retrySizing(cur, plan);
    const sec = this.section(plan.id);
    const note = sec.reviews[sec.reviews.length - 1]?.note ?? "";
    const max = this.state.guardrails.criticRounds;
    this.patchSection(plan.id, (s) => ({ ...s, status: "drafting" }));
    const excerpts = await this.fileExcerpts(owner, plan);
    const sizing = this.sizingFor(cur, plan);
    const res = await this.memberSpan<DraftOut>({
      role: owner, kind: "work", action: `Revise ${plan.name} (round ${cur.sentBacks})`, parentId: cur.lastSpanId,
      sectionId: plan.id, why: `Address the Critic's note: ${trunc(note, 200)}`,
      task: {
        kind: "revise", plan, before: sec.content, sentBacks: cur.sentBacks, maxRounds: max, refs: { review: cur.lastSpanId },
        repoContext: this.repoContext(owner), files: filesBlock(excerpts), sizing: this.sizingText(sizing)
      },
      show: showDraft
    });
    if (!res.data) return this.failed(cur, res, `Revising ${plan.name}`, null);
    const d = res.data;
    const same = JSON.stringify(d.bullets) === JSON.stringify(sec.content);
    this.patchSection(plan.id, (s) => ({ ...s, status: "in_review", rounds: s.rounds + 1, content: d.bullets }));
    this.noteSizingSource(plan.id, sizing);
    this.addQuestions(d.openQuestions, owner);
    return this.advance(cur, { phase: "review", lastSpanId: res.spanId, noProgress: same ? cur.noProgress + 1 : 0 });
  }

  /**
   * One more sample-size decision for the section being revised: by the owner if it has the
   * calculator, otherwise by a consult that has it (the owner asks it in a message span first).
   * Without anyone able to compute it, the owner just revises.
   */
  private async retrySizing(cur: Cursor, plan: SectionPlan): Promise<Cursor> {
    const next: Cursor = { ...cur, sizingRetry: false, sizingDone: false };
    const owner = plan.owner;
    if (hasTool(this.teamConfig(), owner, "sample_size")) {
      return this.sizingTool(next, owner, cur.lastSpanId, plan, null);
    }
    const sizer = plan.consults.find((r) => hasTool(this.teamConfig(), r, "sample_size"));
    if (!sizer) return next;
    const question = `The automatic check sent "${plan.name}" back for a sample size the calculator did not compute. Please compute the sample size for this section.`;
    const askSpanId = await this.msgSpan({
      role: owner, action: `Ask ${roleName(sizer)}: compute the sample size`, parentId: cur.lastSpanId, sectionId: plan.id,
      why: "The section needs a sample size from the calculator", output: question,
      to: sizer, inbox: "question", text: question
    });
    return this.sizingTool(next, sizer, askSpanId, plan, question, askSpanId);
  }

  /** The coordinator compiles Open questions (merging duplicates in one turn when more than 5 were raised). */
  private async openQuestionsPhase(cur: Cursor): Promise<Cursor> {
    const raw = this.state.openQuestions;
    let qs = raw;
    let mergedNote = "";
    if (raw.length > 5 && !this.kvGet<boolean>("questionsMerged")) {
      // One coordinator turn merges duplicates into ≤ 6 questions; on failure the raw list is kept.
      this.commit({ activeRole: this.coordinator() });
      const res = await this.memberSpan<MergeOut>({
        role: this.coordinator(), kind: "work", action: `Merge open questions (${raw.length} raised)`, parentId: cur.splitSpanId, sectionId: "open",
        why: "Several agents raised overlapping questions; merge duplicates before compiling",
        task: { kind: "merge_questions", questions: raw },
        show: (d) => d.questions.map((q) => `- ${q.question} (${roleName(q.raisedBy)})`).join("\n")
      });
      if (res.quota) throw new RunError(`Workers AI refused the call (free allowance used up?): ${res.error}`);
      this.kvSet("questionsMerged", true);
      if (res.data) {
        this.kvSet("rawOpenQuestions", raw);
        qs = res.data.questions;
        this.commit({ openQuestions: qs });
        mergedNote = ` (merged from ${raw.length} raised)`;
      } else mergedNote = ` (merge failed; kept all ${raw.length} as raised)`;
    }
    const bullets = qs.length
      ? qs.map((q) => `${q.question} (raised by ${roleName(q.raisedBy)})`)
      : ["No open questions were raised during the run."];
    const open = this.sectionPlans().find((s) => s.id === "open");
    this.commit({ activeRole: this.coordinator() });
    this.instantSpan({
      role: this.coordinator(), kind: "work", action: "Compile open questions", parentId: cur.splitSpanId, sectionId: open ? open.id : null,
      why: "Questions no agent could answer go to the coordinator, then into Open questions",
      input: `${qs.length} question(s)${mergedNote || " raised"}`, output: bullets.map((b) => `- ${b}`).join("\n")
    });
    if (open) {
      const raisedBy = [...new Set(qs.map((q) => roleName(q.raisedBy)))];
      this.patchSection(open.id, (s) => ({
        ...s, status: "open", rounds: 1, content: bullets,
        sources: qs.length ? [`Raised during the run by ${raisedBy.join(", ")}`] : []
      }));
    }
    return this.advance(cur, { phase: "reflect", reflect: null });
  }

  /**
   * End of run: a coordinator "Collect lessons" system span, then ONE "Reflect on the run" turn per
   * member that worked (one per step); the member stores ≤ 2 items in its own memory. The rest is
   * skipped when the next turn would break the token or turn guardrail; then assemble.
   */
  private async reflectPhase(cur: Cursor): Promise<Cursor> {
    const s = this.state;
    if (!cur.reflect) {
      const worked = this.teamConfig().members.map((m) => m.role)
        .filter((r) => s.spans.some((x) => x.role === r && x.model !== null));
      this.commit({ activeRole: this.coordinator() });
      const id = this.instantSpan({
        role: this.coordinator(), kind: "system", action: "Collect lessons", parentId: null, sectionId: null,
        why: "Each member that worked writes down at most two lessons for future runs of this team",
        input: `${worked.length} member(s) worked in this run`,
        output: worked.length ? `Asking ${worked.map(roleName).join(", ")} to reflect (one turn each).` : "Nobody to ask."
      });
      return this.advance(cur, { reflect: { collectSpanId: id, queue: worked } });
    }
    const [role, ...rest] = cur.reflect.queue;
    if (!role) return this.advance(cur, { phase: "assemble", reflect: null });
    const t = s.totals;
    const g = s.guardrails;
    const tokens = t.inputTokens + t.outputTokens;
    if (tokens + REFLECT_TOKENS > g.maxTokens || t.turns + 1 >= g.maxTurns) {
      this.instantSpan({
        role: this.coordinator(), kind: "system", action: "Skip remaining reflections", parentId: cur.reflect.collectSpanId, sectionId: null,
        why: "Reflecting would break a guardrail",
        output: `Not asked: ${cur.reflect.queue.map(roleName).join(", ")} (${tokens} of ${g.maxTokens} tokens, ${t.turns} of ${g.maxTurns} turns used).`
      });
      return this.advance(cur, { phase: "assemble", reflect: null });
    }
    const secs = s.sections.filter((x) => x.id !== "open");
    const mine = secs.filter((x) => x.owner === role)
      .map((x) => `${x.name} (${x.rounds} draft(s), ${x.reviews.length ? `sent back ${x.reviews.length}×` : "approved first time"})`);
    const outcome = `${this.outputName()}: ${t.sectionsApproved} of ${secs.length} sections approved, ${t.reviewRoundsUsed} send-back(s) in the run.` +
      (mine.length ? ` Your sections: ${mine.join("; ")}.` : "");
    this.commit({ activeRole: role });
    const res = await this.memberSpan<ReflectOut>({
      role, kind: "work", action: "Reflect on the run", parentId: cur.reflect.collectSpanId, sectionId: null,
      why: "Keep at most two lessons for future runs of this team",
      task: { kind: "reflect", outcome },
      show: (d) => d.items.length
        ? d.items.map((i) => `- (${i.kind}) ${i.text}`).join("\n") + (d.dropped ? `\n(${d.dropped} item(s) dropped: they named people)` : "")
        : "Nothing new worth keeping."
    });
    if (res.quota) throw new RunError(`Workers AI refused the call (free allowance used up?): ${res.error}`);
    // A failed reflection is not retried: it only costs this member's lessons.
    return this.advance(cur, { reflect: { ...cur.reflect, queue: rest } });
  }

  /** The coordinator puts the document together (no model call). */
  private async assemblePhase(cur: Cursor): Promise<Cursor> {
    const md = this.markdown();
    this.instantSpan({
      role: this.coordinator(), kind: "system", action: `Assemble ${this.outputName()}`, parentId: null, sectionId: null,
      why: `All sections are approved; put the ${this.outputName()} together in template order`,
      input: `${this.state.totals.sectionsApproved} approved section(s)`, output: md
    });
    return this.advance(cur, { phase: "done" });
  }

  /** Adds new open questions (case- and punctuation-insensitive duplicates are skipped). */
  private addQuestions(questions: string[], raisedBy: RoleId) {
    if (!questions.length) return;
    const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const have = new Set(this.state.openQuestions.map((q) => norm(q.question)));
    const add = questions.filter((q) => !have.has(norm(q))).map((question) => ({ question, raisedBy }));
    if (add.length) this.commit({ openQuestions: [...this.state.openQuestions, ...add] });
  }

  /** Decide-prompt hints: a consultable role's tool that matters for this section (the sample-size calculator). */
  private consultHints(plan: SectionPlan): string[] {
    if (!SIZING_SECTIONS.includes(plan.id)) return [];
    return plan.consults
      .filter((r) => hasTool(this.teamConfig(), r, "sample_size"))
      .map((r) => `The ${roleName(r)} has a ${TOOL_LABELS.sample_size}; ask them if this section needs a sample size.`);
  }

  /** The document as Markdown (also returned by GET /agents/run-agent/<id>/document). */
  private markdown(): string {
    const s = this.state;
    const files = s.files?.length ? ` · files ${s.files.map((f) => f.name).join(", ")}` : "";
    const out = [`# ${s.title}`, "", `_${this.outputName()} · ${s.team.name} ${s.team.version} · run ${s.runId}${s.repo ? ` · repo ${s.repo.name}@${s.repo.branch}` : ""}${files}_`, ""];
    if (s.brief) out.push("## Brief", "", briefText(s.brief), "");
    for (const sec of s.sections) {
      out.push(`## ${sec.name}`, "");
      if (sec.content.length) out.push(...sec.content.map((b) => `- ${b}`));
      else out.push("_Not written._");
      const meta = [`Written by ${roleName(sec.owner)}`];
      if (sec.consulted.length) meta.push(`consulted ${sec.consulted.map(roleName).join(", ")}`);
      if (sec.id !== "open") meta.push(`${sec.rounds} draft(s)`, `status ${sec.status}`);
      out.push("", `_${meta.join(" · ")}_`, "");
    }
    return out.join("\n");
  }
}

function showDraft(d: DraftOut): string {
  const parts = [d.bullets.map((b) => `- ${b}`).join("\n")];
  if (d.openQuestions.length) parts.push(`Open questions:\n${d.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  return parts.join("\n\n");
}
