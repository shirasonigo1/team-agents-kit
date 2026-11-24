/**
 * Saved, versioned teams in D1.
 *
 * - `teams` holds one row per team (name and latest version, for the list).
 * - `team_versions` holds immutable TeamConfig snapshots; saving creates version latest+1.
 * - Every team comes from a template (TEMPLATES[templateId]), which fixes its roles, output,
 *   fixed rules and the consult pairs it may switch on. Versions stored before templates existed
 *   have no templateId and are read as the Product squad.
 * - "squad" (Mobile Product Squad, product-squad) and "ux-research" (UX Research Team,
 *   research-lab) are seeded when missing.
 */
import {
  ALLOWED_TOOLS,
  MODELS,
  OUTPUTS,
  ROLES,
  TEMPLATES,
  effectiveConsults,
  rulesFor,
  type ConsultPair,
  type Guardrails,
  type HandoffRule,
  type MemberConfig,
  type OutputId,
  type RoleId,
  type TeamConfig,
  type TeamSummary,
  type TeamVersionSummary,
  type Template,
  type TemplateId,
  type ToolId
} from "./contract";

export const DEFAULT_TEAM_ID = "squad";
export const DEFAULT_TEMPLATE_ID: TemplateId = "product-squad";
const ROLE_IDS = Object.keys(ROLES) as RoleId[];
const SEEDS: { teamId: string; name: string; templateId: TemplateId }[] = [
  { teamId: "squad", name: "Mobile Product Squad", templateId: "product-squad" },
  { teamId: "ux-research", name: "UX Research Team", templateId: "research-lab" }
];

/** An error with an HTTP status; the Worker turns it into `{ error }` with that status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The template a team version was made from (missing templateId = Product squad). */
export function templateOf(cfg: { templateId?: TemplateId } | null | undefined): Template {
  return TEMPLATES[cfg?.templateId ?? DEFAULT_TEMPLATE_ID] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
}
/** The output document a team version produces. */
export function outputOf(cfg: TeamConfig): OutputId {
  return cfg.outputId ?? templateOf(cfg).outputId;
}

const defaultMember = (role: RoleId): MemberConfig => ({
  role, personality: ROLES[role].personality, responsibleFor: ROLES[role].responsibleFor, tools: [...ROLES[role].tools]
});

/** Version 1 of a new team, copied from a template: the roles' default settings, no `model` (= the default model). */
export function templateConfig(
  teamId: string, name: string, createdAt = new Date().toISOString(), templateId: TemplateId = DEFAULT_TEMPLATE_ID
): TeamConfig {
  const t = TEMPLATES[templateId];
  return {
    teamId,
    name,
    version: 1,
    versionLabel: "v1",
    note: `Copied from the ${t.name} template`,
    createdAt,
    templateId: t.templateId,
    outputId: t.outputId,
    coordinator: t.coordinator,
    members: t.members.map(defaultMember),
    rules: rulesFor(t, t.defaultConsults),
    guardrails: { ...t.guardrails }
  };
}

/**
 * A stored version in its complete form, without changing what it means: templateId / outputId
 * default to the Product squad, and members are the template's members in template order.
 * A member's missing `model` stays missing (it means DEFAULT_MODEL_ID).
 */
export function normalizeConfig(cfg: TeamConfig): TeamConfig {
  const t = templateOf(cfg);
  return {
    ...cfg,
    templateId: t.templateId,
    outputId: cfg.outputId ?? t.outputId,
    coordinator: cfg.coordinator ?? t.coordinator,
    members: t.members.map((r) => cfg.members?.find((m) => m.role === r) ?? defaultMember(r))
  };
}

/** A member's settings in a team version (the role's defaults if the version doesn't list it). */
export function member(cfg: TeamConfig, role: RoleId): MemberConfig {
  return cfg.members.find((m) => m.role === role) ?? defaultMember(role);
}

/** True when `role` is a member of the version and has `tool`. */
export function hasTool(cfg: TeamConfig, role: RoleId, tool: ToolId): boolean {
  return cfg.members.some((m) => m.role === role) && member(cfg, role).tools.includes(tool);
}

/** Members of the team that have a tool (e.g. who can run the sample-size calculator). */
export function withTool(cfg: TeamConfig, tool: ToolId): RoleId[] {
  return cfg.members.filter((m) => m.tools.includes(tool)).map((m) => m.role);
}

async function insertTeam(db: D1Database, cfg: TeamConfig, orIgnore = false) {
  const json = JSON.stringify(cfg);
  const verb = orIgnore ? "INSERT OR IGNORE" : "INSERT";
  await db.batch([
    db.prepare(`${verb} INTO teams (team_id, name, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .bind(cfg.teamId, cfg.name, cfg.createdAt, cfg.createdAt),
    db.prepare(`${verb} INTO team_versions (team_id, version, note, config, created_at) VALUES (?, 1, ?, ?, ?)`)
      .bind(cfg.teamId, cfg.note, json, cfg.createdAt)
  ]);
}

/** Seeds "squad" and "ux-research" v1 when missing (idempotent, race-safe; existing versions untouched). */
export async function ensureSeed(db: D1Database) {
  const { results } = await db.prepare(`SELECT team_id FROM teams WHERE team_id IN (${SEEDS.map(() => "?").join(", ")})`)
    .bind(...SEEDS.map((s) => s.teamId)).all<{ team_id: string }>();
  const have = new Set(results.map((r) => r.team_id));
  for (const s of SEEDS) {
    if (!have.has(s.teamId)) await insertTeam(db, templateConfig(s.teamId, s.name, undefined, s.templateId), true);
  }
}

/** GET /api/templates: each template with its roles, sections and output name. */
export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    ...t,
    roles: t.members.map((r) => ROLES[r]),
    sections: OUTPUTS[t.outputId].sections,
    outputName: OUTPUTS[t.outputId].name
  }));
}

/** A team version (default: the latest), normalised; null if the team or version doesn't exist. */
export async function getVersion(db: D1Database, teamId: string, version?: number): Promise<TeamConfig | null> {
  const row = version === undefined
    ? await db.prepare("SELECT v.config FROM teams t JOIN team_versions v ON v.team_id = t.team_id AND v.version = t.latest_version WHERE t.team_id = ?").bind(teamId).first<{ config: string }>()
    : await db.prepare("SELECT config FROM team_versions WHERE team_id = ? AND version = ?").bind(teamId, version).first<{ config: string }>();
  return row ? normalizeConfig(JSON.parse(row.config) as TeamConfig) : null;
}

/** GET /api/teams: every team's latest version with run counts, most recently updated first. */
export async function listTeams(db: D1Database): Promise<TeamSummary[]> {
  const { results } = await db.prepare(
    `SELECT t.team_id, t.name, t.latest_version, t.updated_at, v.config,
            (SELECT COUNT(*) FROM runs r WHERE r.team_id = t.team_id) AS run_count,
            (SELECT MAX(r.created_at) FROM runs r WHERE r.team_id = t.team_id) AS last_run_at
       FROM teams t LEFT JOIN team_versions v ON v.team_id = t.team_id AND v.version = t.latest_version
      ORDER BY t.updated_at DESC`
  ).all<{ team_id: string; name: string; latest_version: number; updated_at: string; config: string | null; run_count: number; last_run_at: string | null }>();
  return results.map((r) => {
    let cfg: TeamConfig | null = null;
    try {
      cfg = r.config ? normalizeConfig(JSON.parse(r.config) as TeamConfig) : null;
    } catch {
      cfg = null;
    }
    const t = templateOf(cfg);
    return {
      teamId: r.team_id, name: r.name, version: r.latest_version, versionLabel: `v${r.latest_version}`,
      updatedAt: r.updated_at, runCount: r.run_count, lastRunAt: r.last_run_at ?? null,
      templateId: t.templateId, outputId: cfg ? outputOf(cfg) : t.outputId,
      coordinator: cfg?.coordinator ?? t.coordinator, members: cfg ? cfg.members.map((m) => m.role) : [...t.members]
    };
  });
}

/** A team's versions, newest first, each with its run count. */
export async function listVersions(db: D1Database, teamId: string): Promise<TeamVersionSummary[]> {
  const { results } = await db.prepare(
    `SELECT v.version, v.note, v.created_at,
            (SELECT COUNT(*) FROM runs r WHERE r.team_id = v.team_id AND r.team_version = v.version) AS run_count
       FROM team_versions v WHERE v.team_id = ? ORDER BY v.version DESC`
  ).bind(teamId).all<{ version: number; note: string; created_at: string; run_count: number }>();
  return results.map((r) => ({ version: r.version, versionLabel: `v${r.version}`, note: r.note, createdAt: r.created_at, runCount: r.run_count }));
}

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "team";
}

function checkName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 60) throw new HttpError(400, "name must be a non-empty string of at most 60 characters");
  return v.trim();
}

/** POST /api/teams { name, templateId? } → new team, v1 copied from the template (default Product squad). */
export async function createTeam(db: D1Database, body: Record<string, unknown>): Promise<TeamConfig> {
  const name = checkName(body.name);
  const templateId = body.templateId === undefined || body.templateId === null ? DEFAULT_TEMPLATE_ID : body.templateId;
  if (typeof templateId !== "string" || !(templateId in TEMPLATES)) {
    throw new HttpError(400, `templateId must be one of ${Object.keys(TEMPLATES).join(", ")}`);
  }
  await ensureSeed(db);
  const base = slugify(name);
  for (let i = 1; i < 50; i++) {
    const teamId = i === 1 ? base : `${base}-${i}`;
    const exists = await db.prepare("SELECT 1 FROM teams WHERE team_id = ?").bind(teamId).first();
    if (exists) continue;
    const cfg = templateConfig(teamId, name, undefined, templateId as TemplateId);
    try {
      await insertTeam(db, cfg);
      return cfg;
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e))) throw e; // lost a race for this slug: try the next one
    }
  }
  throw new HttpError(409, "Could not find a free team id for that name");
}

const GUARDRAIL_RANGES: Record<keyof Guardrails, [number, number]> = {
  maxTurns: [10, 120],
  maxTokens: [10_000, 300_000],
  criticRounds: [0, 3],
  noProgressTurns: [2, 20]
};

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new HttpError(400, `${field} must be a non-empty string of at most ${max} characters`);
  return v.trim();
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

const samePair = (p: { a: RoleId; b: RoleId }, a: RoleId, b: RoleId) => (p.a === a && p.b === b) || (p.a === b && p.b === a);

/** Consult pairs of the template currently enabled in a rule list (enabled = both directions present). */
export function consultPairs(rules: HandoffRule[], template: Template): ConsultPair[] {
  const has = (from: RoleId, to: RoleId) => rules.find((r) => r.from === from && r.to === to);
  const out: ConsultPair[] = [];
  for (const p of template.consultPairs) {
    const r = has(p.a, p.b) ?? has(p.b, p.a);
    if (has(p.a, p.b) || has(p.b, p.a)) out.push({ a: p.a, b: p.b, what: r?.what ?? p.what });
  }
  return out;
}

/** POST /api/teams/<id>/versions — validates the edit and stores version latest+1. */
export async function createVersion(db: D1Database, teamId: string, body: Record<string, unknown>): Promise<TeamConfig> {
  await ensureSeed(db);
  const latest = await getVersion(db, teamId);
  if (!latest) throw new HttpError(404, `Team "${teamId}" not found`);
  const template = templateOf(latest);

  const note = text(body.note, "note", 200);
  const name = body.name === undefined ? latest.name : checkName(body.name);

  // members: a list of (partial) MemberConfig, merged onto the latest version by role.
  const members = latest.members.map((m) => ({ ...m, tools: [...m.tools] }));
  if (body.members !== undefined) {
    if (!Array.isArray(body.members)) throw new HttpError(400, "members must be an array of { role, personality?, responsibleFor?, tools?, model? }");
    const seen = new Set<string>();
    for (const m of body.members) {
      if (!isObj(m) || typeof m.role !== "string" || !ROLE_IDS.includes(m.role as RoleId)) {
        throw new HttpError(400, `each member needs a role, one of ${template.members.join(", ")}`);
      }
      const role = m.role as RoleId;
      if (!template.members.includes(role)) {
        throw new HttpError(400, `${ROLES[role].name} (${role}) is not a member of the ${template.name} template; members: ${template.members.join(", ")}`);
      }
      if (seen.has(role)) throw new HttpError(400, `member ${role} is listed twice`);
      seen.add(role);
      const target = members.find((x) => x.role === role)!;
      if (m.personality !== undefined) target.personality = text(m.personality, `members.${role}.personality`, 300);
      if (m.responsibleFor !== undefined) target.responsibleFor = text(m.responsibleFor, `members.${role}.responsibleFor`, 300);
      if (m.tools !== undefined) {
        if (!Array.isArray(m.tools) || m.tools.some((t) => typeof t !== "string")) throw new HttpError(400, `members.${role}.tools must be an array of tool ids`);
        const bad = (m.tools as string[]).filter((t) => !ALLOWED_TOOLS[role].includes(t as ToolId));
        if (bad.length) throw new HttpError(400, `${ROLES[role].name} may not have tool(s) ${bad.join(", ")}; allowed: ${ALLOWED_TOOLS[role].join(", ")}`);
        target.tools = [...new Set(m.tools as ToolId[])];
      }
      if (m.model !== undefined) {
        if (m.model === null || m.model === "") delete target.model;
        else if (typeof m.model !== "string" || !MODELS.some((x) => x.id === m.model)) {
          throw new HttpError(400, `members.${role}.model must be one of ${MODELS.map((x) => x.id).join(", ")} (or null for the default)`);
        } else target.model = m.model;
      }
    }
  }

  // consultRules: replaces the whole set of consult rules; only the template's consult pairs are allowed.
  let pairs = consultPairs(latest.rules, template);
  if (body.consultRules !== undefined) {
    if (!Array.isArray(body.consultRules)) throw new HttpError(400, "consultRules must be an array of { a, b, what }");
    const allowed = template.consultPairs.map((p) => `${p.a}↔${p.b}`).join(", ");
    pairs = [];
    for (const r of body.consultRules) {
      if (!isObj(r) || typeof r.a !== "string" || typeof r.b !== "string" || r.a === r.b) {
        throw new HttpError(400, `consultRules entries must be { a, b, what } with two different roles; allowed pairs: ${allowed}`);
      }
      const [a, b] = [r.a as RoleId, r.b as RoleId];
      const tpl = template.consultPairs.find((p) => samePair(p, a, b));
      if (!tpl) throw new HttpError(400, `consult rule ${a}↔${b} is not a consult pair of the ${template.name} template; allowed pairs: ${allowed}`);
      const what = r.what === undefined || r.what === null || r.what === "" ? tpl.what : text(r.what, "consultRules.what", 120);
      if (pairs.some((p) => samePair(p, a, b))) throw new HttpError(400, `consult rule ${a}↔${b} is listed twice`);
      pairs.push({ a, b, what });
    }
  }

  // guardrails: partial, merged onto the latest version.
  const guardrails = { ...latest.guardrails };
  if (body.guardrails !== undefined) {
    if (!isObj(body.guardrails)) throw new HttpError(400, "guardrails must be an object");
    for (const [k, v] of Object.entries(body.guardrails)) {
      const range = GUARDRAIL_RANGES[k as keyof Guardrails];
      if (!range) throw new HttpError(400, `unknown guardrail "${k}"; allowed: ${Object.keys(GUARDRAIL_RANGES).join(", ")}`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < range[0] || v > range[1]) {
        throw new HttpError(400, `guardrails.${k} must be an integer from ${range[0]} to ${range[1]}`);
      }
      guardrails[k as keyof Guardrails] = v;
    }
  }

  const version = latest.version + 1;
  const createdAt = new Date().toISOString();
  const cfg: TeamConfig = {
    teamId, name, version, versionLabel: `v${version}`, note, createdAt,
    templateId: template.templateId, outputId: outputOf(latest), coordinator: template.coordinator,
    members, rules: rulesFor(template, pairs), guardrails
  };
  try {
    await db.batch([
      db.prepare("INSERT INTO team_versions (team_id, version, note, config, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(teamId, version, note, JSON.stringify(cfg), createdAt),
      db.prepare("UPDATE teams SET name = ?, latest_version = ?, updated_at = ? WHERE team_id = ?").bind(name, version, createdAt, teamId)
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "Another version was saved at the same time; reload and try again");
    throw e;
  }
  return cfg;
}

/**
 * GET /api/team: one team version as { team, roles, rules, sections, guardrails } — roles carry the
 * version's member settings and each section's consults are the effective ones under its rules.
 */
export function teamOverview(cfg: TeamConfig) {
  const roles = Object.fromEntries(
    cfg.members.map((m) => [m.role, { ...ROLES[m.role], personality: m.personality, responsibleFor: m.responsibleFor, tools: [...m.tools] }])
  );
  return {
    team: { id: cfg.teamId, name: cfg.name, version: cfg.versionLabel, coordinator: cfg.coordinator, members: cfg.members.map((m) => m.role) },
    roles,
    rules: cfg.rules,
    sections: OUTPUTS[outputOf(cfg)].sections.map((s) => ({ ...s, consults: effectiveConsults(s, cfg.rules) })),
    guardrails: cfg.guardrails
  };
}
