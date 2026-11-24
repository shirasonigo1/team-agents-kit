-- Saved, versioned teams; the runs list; uploaded context files.
-- Apply with `npm run db:migrate:local` / `npm run db:migrate:remote`.

-- One row per team; `latest_version` points at the newest row in team_versions.
CREATE TABLE teams (
  team_id        TEXT PRIMARY KEY,               -- slug, e.g. "squad"
  name           TEXT NOT NULL,                  -- name of the latest version (denormalised for the list)
  latest_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL                   -- createdAt of the latest version
);

-- Immutable versions. `config` is the full TeamConfig JSON (members, rules, guardrails…).
CREATE TABLE team_versions (
  team_id    TEXT NOT NULL REFERENCES teams(team_id),
  version    INTEGER NOT NULL,
  note       TEXT NOT NULL,
  config     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, version)
);

-- Runs list (GET /api/runs). Written by each RunAgent on create, every status change and every step.
CREATE TABLE runs (
  run_id            TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL,
  stop_reason       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  turns             INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 0,
  sections_approved INTEGER NOT NULL DEFAULT 0,
  section_count     INTEGER NOT NULL DEFAULT 0,
  team_id           TEXT,                        -- NULL for runs backfilled without a team
  team_name         TEXT,
  team_version      INTEGER,
  file_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX runs_created_at ON runs (created_at DESC);
CREATE INDEX runs_team ON runs (team_id, team_version);

-- Uploaded context files: metadata plus the extracted Markdown (≤ 60,000 chars).
CREATE TABLE files (
  file_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,         -- 0/1
  status     TEXT NOT NULL,                      -- "ready" | "failed"
  error      TEXT,
  markdown   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX files_created_at ON files (created_at DESC);

-- Which files a run used.
CREATE TABLE run_files (
  run_id  TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (run_id, file_id)
);
CREATE INDEX run_files_file ON run_files (file_id);

-- Small key/value table for one-off jobs (e.g. the one-time RunsIndex backfill).
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
