/**
 * Uploaded context files.
 *
 * POST /api/files stores the file's text as Markdown in D1 (no blob storage):
 * - .md / .txt are read as UTF-8 text directly (no conversion needed);
 * - .pdf, .docx, .xlsx, .csv, .html go through Workers AI `env.AI.toMarkdown({ name, blob })`
 *   (free for documents; embedded-image description is switched off so no model is called).
 * Failed extraction still returns 201 with status "failed" and the error.
 */
import type { FileMeta } from "./contract";
import { HttpError } from "./teams";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MARKDOWN_CHARS = 60_000;
export const MAX_RUN_FILES = 5;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html"
};
const PLAIN = new Set(["txt", "md", "markdown"]);

function newShortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

type FileRow = {
  file_id: string; name: string; mime_type: string; bytes: number; chars: number; truncated: number;
  status: string; error: string | null; created_at: string;
};

const toMeta = (r: FileRow): FileMeta => ({
  fileId: r.file_id, name: r.name, mimeType: r.mime_type, bytes: r.bytes, chars: r.chars,
  truncated: !!r.truncated, status: r.status === "ready" ? "ready" : "failed", error: r.error ?? null, createdAt: r.created_at
});

const META_COLS = "file_id, name, mime_type, bytes, chars, truncated, status, error, created_at";

/** A file's metadata, or null. */
export async function getFileMeta(db: D1Database, fileId: string): Promise<FileMeta | null> {
  const r = await db.prepare(`SELECT ${META_COLS} FROM files WHERE file_id = ?`).bind(fileId).first<FileRow>();
  return r ? toMeta(r) : null;
}

/** GET /api/files/<id>: metadata plus the first 2000 characters of the Markdown, or null. */
export async function getFileWithPreview(db: D1Database, fileId: string): Promise<(FileMeta & { preview: string }) | null> {
  const r = await db.prepare(`SELECT ${META_COLS}, substr(markdown, 1, 2000) AS preview FROM files WHERE file_id = ?`)
    .bind(fileId).first<FileRow & { preview: string }>();
  return r ? { ...toMeta(r), preview: r.preview ?? "" } : null;
}

/** The extracted Markdown of a file ("" if unknown or failed). */
export async function getFileMarkdown(db: D1Database, fileId: string): Promise<string> {
  const r = await db.prepare("SELECT markdown FROM files WHERE file_id = ?").bind(fileId).first<{ markdown: string }>();
  return r?.markdown ?? "";
}

/**
 * POST /api/files (multipart, field "file"): validates size and type, extracts the text as Markdown
 * and stores it. Throws HttpError 400 / 413 / 415 for bad uploads; a failed extraction is stored
 * with status "failed" and returned normally.
 */
export async function uploadFile(request: Request, env: Env): Promise<FileMeta> {
  const ct = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(ct)) throw new HttpError(400, 'Send multipart/form-data with the file in the field "file"');
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_FILE_BYTES + 64 * 1024) throw new HttpError(413, "File is too large (max 2 MB)");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Could not read the multipart body");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, 'Missing file in the field "file"');
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "File is too large (max 2 MB)");
  if (file.size === 0) throw new HttpError(400, "File is empty");
  const name = (file.name || "file").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const mimeType = TYPES[ext];
  if (!mimeType) throw new HttpError(415, `Unsupported file type ".${ext}"; allowed: pdf, docx, xlsx, csv, txt, md, html`);

  let markdown = "";
  let error: string | null = null;
  try {
    if (PLAIN.has(ext)) {
      markdown = new TextDecoder("utf-8").decode(await file.arrayBuffer());
    } else {
      const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
      const res = await env.AI.toMarkdown(
        { name, blob },
        {
          conversionOptions: {
            pdf: { images: { convert: false }, metadata: false },
            docx: { images: { convert: false } },
            html: { images: { convert: false, convertOGImage: false } }
          }
        }
      );
      if (res.format === "error") error = res.error || "Conversion failed";
      else markdown = res.data ?? "";
    }
  } catch (e) {
    error = `Conversion failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  markdown = markdown.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  if (!error && !markdown) error = "No text could be extracted from this file";
  if (error) markdown = "";

  const truncated = markdown.length > MAX_MARKDOWN_CHARS;
  if (truncated) markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
  const meta: FileMeta = {
    fileId: newShortId(), name, mimeType, bytes: file.size, chars: markdown.length, truncated,
    status: error ? "failed" : "ready", error: error ? error.slice(0, 500) : null, createdAt: new Date().toISOString()
  };
  await env.DB.prepare(
    `INSERT INTO files (file_id, name, mime_type, bytes, chars, truncated, status, error, markdown, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(meta.fileId, meta.name, meta.mimeType, meta.bytes, meta.chars, meta.truncated ? 1 : 0, meta.status, meta.error, markdown, meta.createdAt).run();
  return meta;
}

// ---------- excerpt selection for prompts ----------

const STOP = new Set(
  "the a an and or of to in on for with by is are be it this that as at from what who when how must each one two three into up any not no its their they them we our you your should".split(" ")
);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];

function chunks(md: string, size = 700): string[] {
  const paras = md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > size) {
      out.push(buf);
      buf = "";
    }
    if (p.length > size * 1.5) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
      continue;
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) out.push(buf);
  return out;
}

/** Text taken from one file for a prompt; `whole` = the full file, otherwise excerpts. */
export type Excerpt = { name: string; text: string; whole: boolean };

/**
 * Picks the parts of the files most relevant to `query` within `budget` characters in total.
 * Files that fit in their share are included whole; otherwise paragraph chunks are scored by
 * keyword overlap with the query and the best ones kept in document order (the first chunk
 * gets a small bonus so the file's opening context survives).
 */
export function selectExcerpts(files: { name: string; markdown: string }[], query: string, budget = 6000): Excerpt[] {
  const live = files.filter((f) => f.markdown.trim());
  if (!live.length) return [];
  const total = live.reduce((a, f) => a + f.markdown.length, 0);
  if (total <= budget) return live.map((f) => ({ name: f.name, text: f.markdown, whole: true }));
  const q = new Set(words(query));
  const share = Math.floor(budget / live.length);
  return live.map((f) => {
    if (f.markdown.length <= share) return { name: f.name, text: f.markdown, whole: true };
    const cs = chunks(f.markdown);
    const scored = cs.map((c, i) => {
      const ws = words(c);
      const hits = ws.filter((w) => q.has(w)).length;
      return { i, c, score: hits / Math.sqrt(ws.length + 1) + (i === 0 ? 0.5 : 0) };
    });
    const picked: typeof scored = [];
    let used = 0;
    for (const s of [...scored].sort((a, b) => b.score - a.score)) {
      if (used + s.c.length + 6 > share) continue;
      picked.push(s);
      used += s.c.length + 6;
    }
    const text = picked.sort((a, b) => a.i - b.i).map((s) => s.c).join("\n[…]\n");
    return { name: f.name, text, whole: false };
  });
}
