/**
 * The runs list (GET /api/runs), stored in the D1 table `runs`. Each RunAgent upserts its own row
 * on create, on every status change and after every step.
 */
import type { OutputId, RunStatus, RunSummary } from "./contract";

/** Inserts or updates a run's row. */
export async function upsertRun(db: D1Database, s: RunSummary): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO runs (run_id, title, status, stop_reason, created_at, updated_at, turns, tokens, sections_approved, section_count,
                       team_id, team_name, team_version, file_count, output_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       title = excluded.title, status = excluded.status, stop_reason = excluded.stop_reason, updated_at = excluded.updated_at,
       turns = excluded.turns, tokens = excluded.tokens, sections_approved = excluded.sections_approved,
       section_count = excluded.section_count, team_id = excluded.team_id, team_name = excluded.team_name,
       team_version = excluded.team_version, file_count = excluded.file_count, output_id = excluded.output_id`
  ).bind(
    s.runId, s.title, s.status, s.stopReason, s.createdAt, now, s.turns, s.tokens, s.sectionsApproved, s.sectionCount,
    s.teamId ?? null, s.teamName ?? null, s.teamVersion ?? null, s.fileCount ?? 0, s.outputId ?? "work-plan"
  ).run();
}

type RunRow = {
  run_id: string; title: string; status: string; stop_reason: string | null; created_at: string; turns: number; tokens: number;
  sections_approved: number; section_count: number; team_id: string | null; team_name: string | null; team_version: number | null; file_count: number; output_id: string | null;
};

/** The newest runs first (at most `limit`). Rows without a team omit the team fields. */
export async function listRuns(db: D1Database, limit = 100): Promise<RunSummary[]> {
  const { results } = await db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").bind(limit).all<RunRow>();
  return results.map((r) => ({
    runId: r.run_id, title: r.title, status: r.status as RunStatus, stopReason: r.stop_reason, createdAt: r.created_at,
    turns: r.turns, tokens: r.tokens, sectionsApproved: r.sections_approved, sectionCount: r.section_count,
    ...(r.team_id ? { teamId: r.team_id } : {}),
    ...(r.team_name ? { teamName: r.team_name } : {}),
    ...(r.team_version != null ? { teamVersion: r.team_version } : {}),
    fileCount: r.file_count,
    outputId: (r.output_id ?? "work-plan") as OutputId
  }));
}
