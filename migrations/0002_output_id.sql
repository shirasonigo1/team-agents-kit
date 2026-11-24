-- The runs list shows which output a run produced ("work-plan" | "lab-experiment").
-- NULL means "work-plan" (runs recorded before this column existed).
ALTER TABLE runs ADD COLUMN output_id TEXT;
