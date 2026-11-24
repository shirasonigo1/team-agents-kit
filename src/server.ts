import { Agent, getAgentByName, routeAgentRequest } from "agents";
/**
 * The Worker: access gate, JSON API (/api/*), agent routing (/agents/*) and static pages.
 * Route list: the HTTP API block at the end of src/contract.ts.
 */
import { ALLOWED_TOOLS, DEFAULT_MODEL_ID, memberAgentName, MODELS, ROLES, type FileMeta, type MemberView, type RoleId } from "./contract";
import { accessGate } from "./access";
import { getFileMeta, getFileWithPreview, MAX_RUN_FILES, uploadFile } from "./files";
import { listRuns } from "./runs-db";
import {
  createTeam, createVersion, DEFAULT_TEAM_ID, ensureSeed, getVersion, HttpError, listTeams, listTemplates, listVersions, teamOverview
} from "./teams";

// Durable Object classes must be exported from the Worker's main module.
/** One per run: the coordinator (step machine, trace, guardrails). */
export { RunAgent } from "./run-agent";
/** One per team member, reached only through the RunAgent and /api/teams/<id>/members. */
export { MemberAgent } from "./member-agent";

/** One recorded model call of the plumbing check. */

export type Call = {
  id: number;
  at: string;
  model: string;
  prompt: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  gatewayLogId: string | null;
};

/** The plumbing check's running totals (pushed to its WebSocket clients). */
export type HelloState = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastCallAt: string | null;
};

const SYSTEM_PROMPT =
  "You are the Product lead of a small agent team. Answer in two or three short sentences.";

/**
 * Plumbing check (public/plumbing.html): one Agent (a Durable Object with its own SQLite) that
 * calls the default Workers AI model through AI Gateway and records every call. It proves the
 * stack works end to end without starting a run.
 */
export class HelloAgent extends Agent<Env, HelloState> {
  initialState: HelloState = { calls: 0, inputTokens: 0, outputTokens: 0, lastCallAt: null };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      reply TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      gateway_log_id TEXT
    )`;
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") return Response.json(this.history());
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let prompt = "";
    try {
      prompt = String(((await request.json()) as { prompt?: unknown }).prompt ?? "").trim();
    } catch {
      return Response.json({ error: "Body must be JSON: { \"prompt\": \"...\" }" }, { status: 400 });
    }
    if (!prompt) return Response.json({ error: "Prompt is empty" }, { status: 400 });
    if (prompt.length > 2000) return Response.json({ error: "Prompt is too long (max 2000 characters)" }, { status: 400 });

    try {
      return Response.json(await this.ask(prompt));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Model call failed: ${message}` }, { status: 502 });
    }
  }

  private async ask(prompt: string): Promise<Call> {
    const model = DEFAULT_MODEL_ID;
    const started = Date.now();

    const result = (await this.env.AI.run(
      model as keyof AiModels,
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        max_tokens: 300
      },
      { gateway: { id: this.env.GATEWAY_ID } }
    )) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };

    const ms = Date.now() - started;
    const reply = typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? result);
    const inputTokens = result.usage?.prompt_tokens ?? 0;
    const outputTokens = result.usage?.completion_tokens ?? 0;
    const gatewayLogId = this.env.AI.aiGatewayLogId ?? null;
    const at = new Date().toISOString();

    const [row] = this.sql<{ id: number }>`
      INSERT INTO calls (at, model, prompt, reply, input_tokens, output_tokens, ms, gateway_log_id)
      VALUES (${at}, ${model}, ${prompt}, ${reply}, ${inputTokens}, ${outputTokens}, ${ms}, ${gatewayLogId})
      RETURNING id`;

    // setState persists the totals and pushes them to every connected WebSocket client.
    this.setState({
      calls: this.state.calls + 1,
      inputTokens: this.state.inputTokens + inputTokens,
      outputTokens: this.state.outputTokens + outputTokens,
      lastCallAt: at
    });

    return { id: row.id, at, model, prompt, reply, inputTokens, outputTokens, ms, gatewayLogId };
  }

  private history() {
    const rows = this.sql<{
      id: number; at: string; model: string; prompt: string; reply: string;
      input_tokens: number; output_tokens: number; ms: number; gateway_log_id: string | null;
    }>`SELECT * FROM calls ORDER BY id DESC LIMIT 20`;
    return {
      state: this.state,
      calls: rows.map((r) => ({
        id: r.id, at: r.at, model: r.model, prompt: r.prompt, reply: r.reply,
        inputTokens: r.input_tokens, outputTokens: r.output_tokens, ms: r.ms, gatewayLogId: r.gateway_log_id
      }))
    };
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

/** A random 20-character run id (lowercase letters and digits without look-alikes). */
function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** POST /api/runs — validate, load the team version and files, create the RunAgent, return 201 { runId }. */
async function createRun(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Body must be a JSON object: { "task": "...", "title"?, "repo"?: "owner/name", "branch"?, "teamId"?, "teamVersion"?, "fileIds"? }' }, 400);
  }
  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) return json({ error: "task is required (a non-empty string)" }, 400);
  if (task.length > 4000) return json({ error: "task is too long (max 4000 characters)" }, 400);
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 120)) {
    return json({ error: "title must be a string of at most 120 characters" }, 400);
  }
  const title = (typeof body.title === "string" && body.title.trim()) || (task.length > 60 ? task.slice(0, 59).trimEnd() + "…" : task);
  let repo: string | null = null;
  if (body.repo !== undefined && body.repo !== null && body.repo !== "") {
    if (typeof body.repo !== "string" || !REPO_RE.test(body.repo.trim())) {
      return json({ error: 'repo must look like "owner/name"' }, 400);
    }
    repo = body.repo.trim();
  }
  let branch: string | null = null;
  if (body.branch !== undefined && body.branch !== null && body.branch !== "") {
    if (typeof body.branch !== "string" || !BRANCH_RE.test(body.branch) || body.branch.includes("..")) {
      return json({ error: "branch must be a valid git branch name" }, 400);
    }
    if (!repo) return json({ error: "branch needs a repo" }, 400);
    branch = body.branch;
  }

  // Team version (default: latest version of "squad").
  const teamId = body.teamId === undefined || body.teamId === null || body.teamId === "" ? DEFAULT_TEAM_ID : body.teamId;
  if (typeof teamId !== "string" || !TEAM_ID_RE.test(teamId)) return json({ error: "teamId must be a team id such as \"squad\"" }, 400);
  let teamVersion: number | undefined;
  if (body.teamVersion !== undefined && body.teamVersion !== null) {
    if (typeof body.teamVersion !== "number" || !Number.isInteger(body.teamVersion) || body.teamVersion < 1) {
      return json({ error: "teamVersion must be a positive integer" }, 400);
    }
    teamVersion = body.teamVersion;
  }
  await ensureSeed(env.DB);
  const team = await getVersion(env.DB, teamId, teamVersion);
  if (!team) {
    return json({ error: teamVersion === undefined ? `Team "${teamId}" not found` : `Team "${teamId}" has no version ${teamVersion}` }, 400);
  }

  // A repo can only be linked when the team has a member who can read one (the Engineer).
  if (repo && !team.members.some((m) => ALLOWED_TOOLS[m.role].includes("github_repo"))) {
    const roles = (Object.keys(ALLOWED_TOOLS) as (keyof typeof ALLOWED_TOOLS)[]).filter((r) => ALLOWED_TOOLS[r].includes("github_repo")).map((r) => ROLES[r].name);
    return json({ error: `Team "${team.name}" has no ${roles.join(" or ")}, so a repository can't be linked` }, 400);
  }

  // Context files: ≤ 5, each must exist and be "ready".
  const files: FileMeta[] = [];
  if (body.fileIds !== undefined && body.fileIds !== null) {
    if (!Array.isArray(body.fileIds) || body.fileIds.some((f) => typeof f !== "string")) {
      return json({ error: "fileIds must be an array of file ids" }, 400);
    }
    const ids = [...new Set(body.fileIds as string[])];
    if (ids.length > MAX_RUN_FILES) return json({ error: `At most ${MAX_RUN_FILES} files per run` }, 400);
    for (const id of ids) {
      const meta = await getFileMeta(env.DB, id);
      if (!meta) return json({ error: `File "${id}" not found` }, 400);
      if (meta.status !== "ready") return json({ error: `File "${meta.name}" (${id}) could not be read (${meta.error ?? meta.status}); remove it from the run` }, 400);
      files.push(meta);
    }
  }

  const runId = newRunId();
  const agent = await getAgentByName(env.RunAgent, runId);
  const res = await agent.create({ task, title, repo, branch, team, files });
  if (!res.ok) return json({ error: res.error ?? "Could not create the run" }, 500);
  return json({ runId }, 201);
}

/** The request body as a JSON object; HttpError 400 otherwise. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

/** /api/models, /api/templates, /api/teams… and /api/files… Returns null when the path isn't one of them. */
async function teamAndFileRoutes(request: Request, env: Env, path: string): Promise<Response | null> {
  const m = request.method;
  if (path === "/api/models") {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(MODELS);
  }
  if (path === "/api/templates") {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(listTemplates());
  }
  if (path === "/api/teams") {
    if (m === "GET") {
      await ensureSeed(env.DB);
      return json(await listTeams(env.DB));
    }
    if (m === "POST") return json(await createTeam(env.DB, await readJson(request)), 201);
    return json({ error: "Method not allowed" }, 405);
  }
  let match = path.match(/^\/api\/teams\/([^/]+)$/);
  if (match) {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    await ensureSeed(env.DB);
    const teamId = decodeURIComponent(match[1]);
    const team = await getVersion(env.DB, teamId);
    if (!team) return json({ error: `Team "${teamId}" not found` }, 404);
    return json({ team, versions: await listVersions(env.DB, teamId) });
  }
  match = path.match(/^\/api\/teams\/([^/]+)\/versions$/);
  if (match) {
    if (m !== "POST") return json({ error: "Method not allowed" }, 405);
    return json(await createVersion(env.DB, decodeURIComponent(match[1]), await readJson(request)), 201);
  }
  match = path.match(/^\/api\/teams\/([^/]+)\/versions\/([^/]+)$/);
  if (match) {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    await ensureSeed(env.DB);
    const teamId = decodeURIComponent(match[1]);
    const n = Number(match[2].replace(/^v/i, ""));
    if (!Number.isInteger(n) || n < 1) return json({ error: "Version must be a positive integer" }, 400);
    const team = await getVersion(env.DB, teamId, n);
    if (!team) return json({ error: `Team "${teamId}" has no version ${n}` }, 404);
    return json(team);
  }
  // Team members (one MemberAgent per role).
  match = path.match(/^\/api\/teams\/([^/]+)\/members(?:\/([^/]+)(\/memory)?)?$/);
  if (match) return memberRoutes(request, env, decodeURIComponent(match[1]), match[2] ? decodeURIComponent(match[2]) : null, !!match[3]);
  if (path === "/api/files") {
    if (m !== "POST") return json({ error: "Method not allowed" }, 405);
    return json(await uploadFile(request, env), 201);
  }
  match = path.match(/^\/api\/files\/([^/]+)$/);
  if (match) {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    const file = await getFileWithPreview(env.DB, decodeURIComponent(match[1]));
    return file ? json(file) : json({ error: "File not found" }, 404);
  }
  return null;
}

/**
 * GET    /api/teams/<id>/members               → MemberView[] (latest version's members; ≤ 5 memories each)
 * GET    /api/teams/<id>/members/<role>        → MemberView
 * DELETE /api/teams/<id>/members/<role>/memory → { cleared }
 * 404 for an unknown team or a role that isn't a member of the team's latest version.
 */
async function memberRoutes(request: Request, env: Env, teamId: string, role: string | null, memory: boolean): Promise<Response> {
  const m = request.method;
  await ensureSeed(env.DB);
  const team = await getVersion(env.DB, teamId);
  if (!team) return json({ error: `Team "${teamId}" not found` }, 404);
  const stub = (r: RoleId) => getAgentByName(env.MemberAgent, memberAgentName(team.teamId, r));
  if (!role) {
    if (m !== "GET") return json({ error: "Method not allowed" }, 405);
    const views = await Promise.all(team.members.map(async (x) => (await stub(x.role)).view({ memories: 5, inbox: 0 }) as Promise<MemberView & { memoryCount: number }>));
    return json(views);
  }
  if (!team.members.some((x) => x.role === role)) return json({ error: `"${role}" is not a member of team "${teamId}"` }, 404);
  const member = await stub(role as RoleId);
  if (memory) {
    if (m !== "DELETE") return json({ error: "Method not allowed" }, 405);
    return json(await member.clearMemory());
  }
  if (m !== "GET") return json({ error: "Method not allowed" }, 405);
  return json(await member.view({ memories: 100, inbox: 20 }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Access control runs first for every request (pages, static files, API, agents, WebSockets).
    const denied = await accessGate(request, env);
    if (denied) return denied;
    return handleApp(request, env);
  }
} satisfies ExportedHandler<Env>;

/** Everything after the access gate: health, API, agents, static files. */
async function handleApp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/api/health") {
    return Response.json({ ok: true, model: DEFAULT_MODEL_ID, gateway: env.GATEWAY_ID });
  }
  try {
    if (path === "/api/team") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      await ensureSeed(env.DB);
      return json(teamOverview((await getVersion(env.DB, DEFAULT_TEAM_ID))!));
    }
    if (path === "/api/runs") {
      if (request.method === "POST") return await createRun(request, env);
      if (request.method === "GET") return json(await listRuns(env.DB));
      return json({ error: "Method not allowed" }, 405);
    }
    const routed = await teamAndFileRoutes(request, env, path);
    if (routed) return routed;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("API error", e);
    return json({ error: `Server error: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
  // Members are not exposed to clients (only through the coordinator and /api/teams/<id>/members).
  if (path.split("/")[2] === "member-agent") return json({ error: "Not found" }, 404);
  if (path.startsWith("/agents/")) return (await routeAgentRequest(request, env)) ?? json({ error: "Not found" }, 404);
  // Static pages and files (served only after the access gate, since run_worker_first is true).
  return env.ASSETS.fetch(request);
}
