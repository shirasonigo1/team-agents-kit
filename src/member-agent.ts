import { Agent, type Connection } from "agents";
import {
  modelInfo,
  OUTPUTS,
  ROLES,
  type Brief,
  type InboxMessage,
  type MemberView,
  type MemoryItem,
  type MemoryKind,
  type OutputId,
  type RoleId,
  type SectionPlan,
  type TeamConfig
} from "./contract";
import {
  callModel,
  coerceAnswer,
  coerceBrief,
  coerceDecide,
  coerceDraft,
  coerceMerge,
  coerceReflect,
  coerceReview,
  coerceSizing,
  errMsg,
  trunc,
  type ReflectOut
} from "./llm";
import {
  answerPrompt,
  briefPrompt,
  decidePrompt,
  draftPrompt,
  memoryBlock,
  mergeQuestionsPrompt,
  reflectPrompt,
  reviewPrompt,
  revisePrompt,
  runContext,
  SCHEMAS,
  sizingPrompt,
  systemPrompt
} from "./prompts";
import { member } from "./teams";

/**
 * One MemberAgent (Durable Object + SQLite) per team member, named memberAgentName(teamId, role),
 * e.g. "squad--R". Shared by every run and every version of the team.
 *
 * The RunAgent (coordinator) sends it one task per model turn over Durable Object RPC (`turn`).
 * The member reads its own inbox for that run (assignment, consult question/answer, Critic's note,
 * brief), picks ≤ 5 relevant memories, builds its own prompt (persona from the run's team version),
 * calls Workers AI on its own model (the version's `members[].model`, default DEFAULT_MODEL_ID)
 * through AI Gateway, logs the turn and returns the result.
 *
 * SQLite tables:
 *   memories      long-term memory (MemoryItem), shared across runs of the team
 *   inbox         messages delivered by the coordinator, per run (InboxMessage + section_id)
 *   turns         one row per model turn (stats, and "what I did" for the end-of-run reflection)
 *   turn_results  the result of each turn keyed by (run_id, span_id): a repeated call for the same
 *                 span returns it instead of calling the model again (recovery after a coordinator
 *                 restart). Deleted when the run ends (`endRun`) and after 7 days anyway.
 *
 * Not reachable by clients: the Worker returns 404 for /agents/member-agent/*, and this class has
 * no @callable methods; it answers HTTP with 404 and closes WebSockets.
 */

/** What a member is asked to do in one turn. */
export type TaskKind =
  | "brief" | "decide_consult" | "answer" | "draft" | "revise" | "review" | "decide_sizing" | "merge_questions" | "reflect";

/** One turn's task, sent by the coordinator. Fields after `refs` are used by some task kinds only. */
export type TurnRequest = {
  runId: string;
  spanId: number;
  teamVersion: number;
  /** The run's team version snapshot: the member's persona and tools come from here. */
  team: TeamConfig;
  output: OutputId;
  kind: TaskKind;
  /** The span's action (for the turns log). */
  label: string;
  sectionId: string | null;
  /** Task, brief (fallback when the brief isn't in the inbox, e.g. for the coordinator) and approved sections. */
  ctx: { task: string; brief: Brief | null; approved: { name: string; content: string[] }[] };
  plan?: SectionPlan;
  /** Inbox messages this turn should read, by the span that delivered them. */
  refs?: { assign?: number | null; question?: number | null; answer?: number | null; review?: number | null };
  // brief
  repoLine?: string | null;
  fileNames?: string[];
  // decide_consult
  hints?: string[];
  // answer / draft / revise / review / decide_sizing: engine-run tool results the member gets to see
  repoContext?: string | null;
  files?: string;
  sizing?: string;
  // review
  draft?: string[];
  sentBacks?: number;
  maxRounds?: number;
  // revise
  before?: string[];
  // decide_sizing
  earlier?: string[];
  // merge_questions
  questions?: { question: string; raisedBy: RoleId }[];
  // reflect
  outcome?: string;
};

/** What a turn produced; stored per (runId, spanId) so a repeated call returns the same result. */
export type TurnResult = {
  data: unknown;
  raw: string;
  attempts: number;
  error: string | null;
  quota: boolean;
  inputTokens: number;
  outputTokens: number;
  gatewayLogId: string | null;
  memoriesUsed: number[];
  /** The model the member ran on (its configured model, or the default). */
  model: string;
  /** The full prompt the member built (system + user), for the span's input. */
  prompt: string;
  /** True when this is the stored result of an earlier call for the same (runId, spanId). */
  cached: boolean;
  /** reflect: ids of the memories stored from this turn. */
  stored: number[];
};

/** A message for this member's inbox. */
export type DeliverInput = {
  runId: string;
  from: RoleId | "user";
  kind: InboxMessage["kind"];
  text: string;
  spanId: number | null;
  sectionId: string | null;
};

/** A memory item to store (the coordinator writes outcomes and lessons). */
export type RememberInput = {
  kind: MemoryKind;
  text: string;
  runId: string;
  teamVersion: number;
  sectionId: string | null;
  /** Idempotency key, e.g. "outcome:<runId>:<sectionId>". */
  key: string;
};

const MEMORY_LIMIT = 5;
const MEMORY_CAP = 200;
const RESULT_TTL_MS = 7 * 24 * 3600 * 1000;
const STOP = new Set(("the and for with that this from into each your their what when where which will would should could have has " +
  "been were are was not but all any one two its they them then than also only more most such must just over very about after before " +
  "section sections run runs team approved draft drafts drafted gist round rounds").split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

type MemoryRow = { id: number; kind: string; text: string; run_id: string; team_version: number; section_id: string | null; created_at: string };
type InboxRow = { id: number; run_id: string; from_role: string; kind: string; text: string; span_id: number | null; section_id: string | null; created_at: string };

const toMemory = (r: MemoryRow): MemoryItem => ({
  id: r.id, kind: r.kind as MemoryKind, text: r.text, runId: r.run_id, teamVersion: r.team_version, sectionId: r.section_id, createdAt: r.created_at
});
const toInbox = (r: InboxRow): InboxMessage => ({
  id: r.id, runId: r.run_id, from: r.from_role as RoleId | "user", kind: r.kind as InboxMessage["kind"], text: r.text, spanId: r.span_id, createdAt: r.created_at
});

/** A team member's own agent: inbox, long-term memory and model turns. See the file comment. */
export class MemberAgent extends Agent<Env> {
  private ready = false;
  private inflight = new Map<string, Promise<TurnResult>>();

  private tables() {
    if (this.ready) return;
    this.sql`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, run_id TEXT NOT NULL,
      team_version INTEGER NOT NULL, section_id TEXT, created_at TEXT NOT NULL, source_key TEXT UNIQUE)`;
    this.sql`CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, from_role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      span_id INTEGER, section_id TEXT, created_at TEXT NOT NULL)`;
    this.sql`CREATE UNIQUE INDEX IF NOT EXISTS inbox_once ON inbox (run_id, span_id, kind)`;
    this.sql`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, span_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
      summary TEXT NOT NULL, section_id TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      memories_used TEXT NOT NULL, ok INTEGER NOT NULL, created_at TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS turn_results (
      run_id TEXT NOT NULL, span_id INTEGER NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, span_id))`;
    this.ready = true;
  }

  /** "squad--R" → { teamId: "squad", role: "R" }. */
  private identity(): { teamId: string; role: RoleId } {
    const i = this.name.lastIndexOf("--");
    return { teamId: this.name.slice(0, i), role: this.name.slice(i + 2) as RoleId };
  }

  // Not exposed to clients (the Worker also blocks /agents/member-agent/*).
  async onRequest(): Promise<Response> {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  async onConnect(connection: Connection) {
    connection.close(1008, "Not available");
  }

  // ---------- RPC: messages and memory ----------

  /** The coordinator delivers a message to this member's inbox (idempotent per run + span + kind). */
  async deliver(msg: DeliverInput): Promise<{ id: number | null }> {
    this.tables();
    const now = new Date().toISOString();
    const text = trunc(msg.text, 2000);
    this.sql`INSERT OR IGNORE INTO inbox (run_id, from_role, kind, text, span_id, section_id, created_at)
      VALUES (${msg.runId}, ${msg.from}, ${msg.kind}, ${text}, ${msg.spanId}, ${msg.sectionId}, ${now})`;
    const [row] = this.sql<{ id: number }>`SELECT id FROM inbox WHERE run_id = ${msg.runId} AND span_id IS ${msg.spanId} AND kind = ${msg.kind} ORDER BY id DESC LIMIT 1`;
    return { id: row?.id ?? null };
  }

  /** Store one memory item (outcome / lesson / note). Skips a repeated key or a near-identical text. */
  async remember(item: RememberInput): Promise<{ id: number | null }> {
    this.tables();
    return { id: this.store(item) };
  }

  private store(item: RememberInput): number | null {
    const text = trunc(item.text.replace(/\s+/g, " ").trim(), 300);
    if (!text) return null;
    const [dupKey] = this.sql<{ id: number }>`SELECT id FROM memories WHERE source_key = ${item.key}`;
    if (dupKey) return dupKey.id;
    const w = words(text);
    // Lessons and notes that say the same thing again are not stored twice (outcomes are per run and section).
    if (item.kind !== "outcome") for (const m of this.sql<{ id: number; text: string }>`SELECT id, text FROM memories WHERE kind = ${item.kind} ORDER BY id DESC LIMIT ${MEMORY_CAP}`) {
      const o = words(m.text);
      const inter = [...w].filter((x) => o.has(x)).length;
      if (w.size && inter / Math.max(w.size, o.size) >= 0.85) return null; // already known
    }
    const now = new Date().toISOString();
    const [row] = this.sql<{ id: number }>`INSERT INTO memories (kind, text, run_id, team_version, section_id, created_at, source_key)
      VALUES (${item.kind}, ${text}, ${item.runId}, ${item.teamVersion}, ${item.sectionId}, ${now}, ${item.key}) RETURNING id`;
    this.sql`DELETE FROM memories WHERE id NOT IN (SELECT id FROM memories ORDER BY id DESC LIMIT ${MEMORY_CAP})`;
    return row.id;
  }

  /** GET /api/teams/<id>/members[/<role>]: stats, newest memories, recent inbox. */
  async view(limits: { memories: number; inbox: number } = { memories: 100, inbox: 20 }): Promise<MemberView & { memoryCount: number }> {
    this.tables();
    const { teamId, role } = this.identity();
    const [s] = this.sql<{ runs: number; turns: number; i: number | null; o: number | null; last: string | null }>`
      SELECT COUNT(DISTINCT run_id) AS runs, COUNT(*) AS turns, SUM(input_tokens) AS i, SUM(output_tokens) AS o, MAX(created_at) AS last FROM turns`;
    const [inboxLast] = this.sql<{ last: string | null }>`SELECT MAX(created_at) AS last FROM inbox`;
    const last = [s?.last, inboxLast?.last].filter(Boolean).sort().pop() ?? null;
    const [mc] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memories`;
    return {
      agentName: this.name,
      memoryCount: mc?.n ?? 0,
      teamId,
      role,
      stats: { runs: s?.runs ?? 0, turns: s?.turns ?? 0, inputTokens: s?.i ?? 0, outputTokens: s?.o ?? 0, lastActiveAt: last },
      memories: this.sql<MemoryRow>`SELECT * FROM memories ORDER BY id DESC LIMIT ${Math.min(100, limits.memories)}`.map(toMemory),
      recentInbox: this.sql<InboxRow>`SELECT * FROM inbox ORDER BY id DESC LIMIT ${Math.min(20, limits.inbox)}`.map(toInbox)
    };
  }

  /** DELETE /api/teams/<id>/members/<role>/memory: wipes memories, keeps stats and inbox. */
  async clearMemory(): Promise<{ cleared: number }> {
    this.tables();
    const [c] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memories`;
    this.sql`DELETE FROM memories`;
    return { cleared: c?.n ?? 0 };
  }

  /** The run ended: its stored turn results are no longer needed for recovery. */
  async endRun(runId: string): Promise<void> {
    this.tables();
    this.sql`DELETE FROM turn_results WHERE run_id = ${runId}`;
  }

  // ---------- RPC: one model turn ----------

  /**
   * Runs one model turn. Idempotent per (runId, spanId): a stored result is returned with
   * `cached: true`, and a call that arrives while the same turn is running waits for it.
   */
  async turn(req: TurnRequest): Promise<TurnResult> {
    this.tables();
    const key = `${req.runId}:${req.spanId}`;
    const [stored] = this.sql<{ result: string }>`SELECT result FROM turn_results WHERE run_id = ${req.runId} AND span_id = ${req.spanId}`;
    if (stored) return { ...(JSON.parse(stored.result) as TurnResult), cached: true };
    // The coordinator restarted while this turn was still running here: wait for the same call.
    const running = this.inflight.get(key);
    if (running) return { ...(await running), cached: true };
    const p = this.doTurn(req);
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async doTurn(req: TurnRequest): Promise<TurnResult> {
    const { teamId, role } = this.identity();
    const model = modelInfo(member(req.team, role).model);
    const base: TurnResult = {
      data: null, raw: "", attempts: 0, error: null, quota: false, inputTokens: 0, outputTokens: 0, gatewayLogId: null,
      memoriesUsed: [], model: model.id, prompt: "", cached: false, stored: []
    };
    if (req.team.teamId !== teamId || !req.team.members.some((m) => m.role === role)) {
      return { ...base, error: `Task for ${req.team.teamId}/${role} sent to ${this.name}` };
    }
    let built: { prompt: string; schema: object; coerce: (x: unknown) => unknown; memories: MemoryItem[] };
    try {
      built = this.build(req);
    } catch (e) {
      return { ...base, error: `Could not build the prompt: ${errMsg(e)}` };
    }
    const system = systemPrompt(role, req.team, req.output);
    const res = await callModel(this.env, {
      model, system, prompt: built.prompt, schema: built.schema, coerce: built.coerce,
      // AI Gateway custom metadata, max 5 keys: filter the logs by run, role, section, span or agent.
      metadata: { runId: req.runId, role, section: req.sectionId ?? "run", spanId: req.spanId, agent: this.name }
    });
    const result: TurnResult = {
      ...base, data: res.data, raw: res.raw, attempts: res.attempts, error: res.error, quota: res.quota,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens, gatewayLogId: res.gatewayLogId,
      memoriesUsed: built.memories.map((m) => m.id), prompt: `[system]\n${system}\n\n[user]\n${built.prompt}`
    };
    if (req.kind === "reflect" && res.data) {
      const items = (res.data as ReflectOut).items;
      result.stored = items
        .map((it, i) => this.store({ kind: it.kind, text: it.text, runId: req.runId, teamVersion: req.teamVersion, sectionId: null, key: `reflect:${req.runId}:${req.spanId}:${i}` }))
        .filter((x): x is number => x !== null);
    }
    const now = new Date().toISOString();
    this.sql`INSERT INTO turns (run_id, span_id, kind, label, summary, section_id, input_tokens, output_tokens, memories_used, ok, created_at)
      VALUES (${req.runId}, ${req.spanId}, ${req.kind}, ${req.label}, ${this.summarize(req, res.data)}, ${req.sectionId},
        ${res.inputTokens}, ${res.outputTokens}, ${JSON.stringify(result.memoriesUsed)}, ${res.data ? 1 : 0}, ${now})`;
    this.sql`INSERT OR REPLACE INTO turn_results (run_id, span_id, result, created_at) VALUES (${req.runId}, ${req.spanId}, ${JSON.stringify(result)}, ${now})`;
    const cutoff = new Date(Date.now() - RESULT_TTL_MS).toISOString();
    this.sql`DELETE FROM turn_results WHERE created_at < ${cutoff}`;
    return result;
  }

  /** One line per turn for the reflection ("what you did in this run"). */
  private summarize(req: TurnRequest, data: unknown): string {
    if (!data) return `${req.label} (failed)`;
    const d = data as Record<string, unknown>;
    if (req.kind === "review") return trunc(`${req.label}: ${d.verdict === "approved" ? "approved" : "sent back"} — ${String(d.note ?? "")}`, 300);
    if (req.kind === "decide_consult") return trunc(`${req.label}: ${d.consult ? `asked ${String(d.role)}: ${String(d.question ?? "")}` : "drafted alone"}`, 300);
    if (req.kind === "draft" || req.kind === "revise") return trunc(`${req.label}: ${String(d.why ?? "")}`, 300);
    return trunc(req.label, 300);
  }

  // ---------- prompt building: inbox + memories + the task ----------

  private inboxBySpan(runId: string, spanId: number | null | undefined, kind: InboxMessage["kind"]): InboxRow | null {
    if (spanId == null) return null;
    const [r] = this.sql<InboxRow>`SELECT * FROM inbox WHERE run_id = ${runId} AND span_id = ${spanId} AND kind = ${kind} ORDER BY id DESC LIMIT 1`;
    return r ?? null;
  }

  private briefFromInbox(runId: string): string | null {
    const [r] = this.sql<{ text: string }>`SELECT text FROM inbox WHERE run_id = ${runId} AND kind = 'brief' ORDER BY id DESC LIMIT 1`;
    return r?.text ?? null;
  }

  /**
   * ≤ 5 memories from earlier runs: lessons/outcomes for the same section id first, then lessons and
   * notes by keyword overlap with the section and task (outcomes of other sections are left out). Memories from the current run are left out (the inbox already has them).
   */
  private selectMemories(req: TurnRequest): MemoryItem[] {
    const rows = this.sql<MemoryRow>`SELECT * FROM memories WHERE run_id != ${req.runId} ORDER BY id DESC LIMIT ${MEMORY_CAP}`;
    if (!rows.length) return [];
    const q = words([req.plan?.name ?? "", req.plan?.guidance ?? "", req.ctx.task, req.label].join(" "));
    const scored = rows.map((r) => {
      const overlap = [...words(r.text)].filter((w) => q.has(w)).length;
      const same = !!req.sectionId && r.section_id === req.sectionId;
      const score = overlap + (same ? (r.kind === "lesson" ? 4 : 3) : 0) + (r.kind === "note" || (r.kind === "lesson" && !r.section_id) ? 1 : 0);
      return { r, score, same };
    });
    // Outcomes are only relevant to the same section (another section's gist is noise in the prompt);
    // lessons and notes qualify by keyword overlap.
    return scored
      .filter((x) => x.same || (x.r.kind !== "outcome" && x.score >= 3))
      .sort((a, b) => b.score - a.score || b.r.id - a.r.id)
      .slice(0, MEMORY_LIMIT)
      .map((x) => toMemory(x.r));
  }

  private build(req: TurnRequest) {
    const plan = req.plan!;
    const sectionName = (id: string | null) => (id ? OUTPUTS[req.output]?.sections.find((s) => s.id === id)?.name ?? id : null);
    const ctx = () => runContext(req.ctx.task, this.briefFromInbox(req.runId) ?? req.ctx.brief ?? "(no brief)", req.ctx.approved);
    const roleName = (r: string) => (ROLES as Record<string, { name: string }>)[r]?.name ?? r;
    let prompt: string;
    let schema: object;
    let coerce: (x: unknown) => unknown;
    let memories = req.kind === "reflect" ? [] : this.selectMemories(req);
    switch (req.kind) {
      case "brief":
        prompt = briefPrompt(req.ctx.task, req.output, req.repoLine ?? null, req.fileNames ?? []);
        [schema, coerce] = [SCHEMAS.brief, coerceBrief];
        break;
      case "decide_consult":
        prompt = decidePrompt(ctx(), plan, req.hints ?? []);
        [schema, coerce] = [SCHEMAS.decide, coerceDecide];
        break;
      case "answer": {
        const q = this.inboxBySpan(req.runId, req.refs?.question, "question");
        if (!q) throw new Error(`no question in the inbox for span #${req.refs?.question}`);
        prompt = answerPrompt(ctx(), plan, q.text, req.repoContext ?? null, req.sizing ?? "");
        [schema, coerce] = [SCHEMAS.answer, coerceAnswer];
        break;
      }
      case "decide_sizing": {
        const q = this.inboxBySpan(req.runId, req.refs?.question, "question");
        prompt = sizingPrompt(ctx(), plan, q?.text ?? null, req.earlier ?? [], req.files ?? "");
        [schema, coerce] = [SCHEMAS.sizing, coerceSizing];
        break;
      }
      case "draft": {
        const a = this.inboxBySpan(req.runId, req.refs?.answer, "answer");
        const asg = this.inboxBySpan(req.runId, req.refs?.assign, "assign");
        const consult = a ? `The ${roleName(a.from_role)} answered your question (from your inbox):\n${a.text}` : null;
        prompt = draftPrompt(ctx(), plan, consult, req.repoContext ?? null, req.files ?? "", req.output, req.sizing ?? "", asg ? `From your inbox: ${asg.text}` : null);
        [schema, coerce] = [SCHEMAS.draft, coerceDraft];
        break;
      }
      case "revise": {
        const n = this.inboxBySpan(req.runId, req.refs?.review, "review");
        if (!n) throw new Error(`no Critic's note in the inbox for span #${req.refs?.review}`);
        prompt = revisePrompt(ctx(), plan, req.before ?? [], n.text, req.sentBacks ?? 1, req.maxRounds ?? 1, req.repoContext ?? null, req.files ?? "", req.sizing ?? "");
        [schema, coerce] = [SCHEMAS.draft, coerceDraft];
        break;
      }
      case "review":
        prompt = reviewPrompt(ctx(), plan, req.draft ?? [], req.sentBacks ?? 0, req.maxRounds ?? 0, req.output, req.sizing ?? "");
        [schema, coerce] = [SCHEMAS.review, coerceReview];
        break;
      case "merge_questions":
        prompt = mergeQuestionsPrompt(ctx(), req.questions ?? []);
        [schema, coerce] = [SCHEMAS.merge, coerceMerge(req.questions ?? [])];
        break;
      case "reflect": {
        const did = this.sql<{ summary: string }>`SELECT summary FROM turns WHERE run_id = ${req.runId} AND kind != 'reflect' ORDER BY id`.map((r) => r.summary);
        const notes = this.sql<{ text: string; section_id: string | null }>`SELECT text, section_id FROM inbox WHERE run_id = ${req.runId} AND kind = 'review' ORDER BY id`
          .map((r) => `${sectionName(r.section_id) ?? "Section"}: ${trunc(r.text, 250)}`);
        memories = this.sql<MemoryRow>`SELECT * FROM memories WHERE run_id != ${req.runId} AND kind != 'outcome' ORDER BY id DESC LIMIT ${MEMORY_LIMIT}`.map(toMemory);
        prompt = reflectPrompt(req.ctx.task, req.outcome ?? "", did.slice(-12), notes.slice(-4), memories.map((m) => m.text));
        [schema, coerce] = [SCHEMAS.reflect, coerceReflect];
        break;
      }
      default:
        throw new Error(`unknown task kind ${(req as { kind: string }).kind}`);
    }
    if (req.kind !== "reflect" && memories.length) {
      prompt = `${memoryBlock(memories.map((m) => ({ kind: m.kind, text: m.text, sectionName: sectionName(m.sectionId) })))}\n\n${prompt}`;
    }
    return { prompt, schema, coerce, memories };
  }
}
