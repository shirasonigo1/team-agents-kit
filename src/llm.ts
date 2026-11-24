/**
 * The model call used by every MemberAgent, and the JSON coercion for each task.
 *
 * Free models are not always tidy, so replies are parsed defensively: the reply text is taken
 * from whichever shape the model returns (`response` as a string or an object, Chat Completions
 * `choices`, Responses API `output`), reasoning text and code fences around the JSON are skipped,
 * and the result is coerced into the shape each task needs. A reply that does not coerce is
 * re-asked once without JSON mode; each attempt is aborted after LLM_TIMEOUT_MS.
 */
// Only `import type` here, so Node can load this file directly for scripts/checks-test.mjs.
import type { Brief, ModelInfo, RoleId, SampleSizeRequest } from "./contract";

/** Output token cap for models that don't set their own (`ModelInfo.maxTokens`). */
export const MAX_OUTPUT_TOKENS = 500;
/** Per-attempt model call timeout. A stalled call fails the attempt (the retry goes without JSON mode). */
export const LLM_TIMEOUT_MS = 40_000;

/** What one model turn produced (both attempts of a JSON retry are summed into one outcome). */
export type LlmOutcome<T> = {
  ok: boolean;
  data: T | null;
  raw: string;
  error: string | null;
  /** True when Workers AI refused the call because the free allowance is used up. */
  quota: boolean;
  inputTokens: number;
  outputTokens: number;
  gatewayLogId: string | null;
  attempts: number;
};

/** Cuts `s` to at most `n` characters, ending with "…" when cut. */
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** The message of an error of any type. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The value as a plain object, or null (arrays and primitives are not objects here). */
export const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);

// ---------- reading a model reply ----------

/** Text of a Chat Completions / Responses content field: a string, or an array of text parts. */
function contentText(c: unknown): string | null {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.map((p) => (typeof p === "string" ? p : obj(p) && typeof obj(p)!.text === "string" ? (obj(p)!.text as string) : "")).filter(Boolean);
    return parts.length ? parts.join("") : null;
  }
  return null;
}

/**
 * The model's answer from a Workers AI result, whatever its shape:
 * - `{ response: string | object }` (classic Workers AI; JSON mode may return an object),
 * - `{ choices: [{ message: { content } }] }` (OpenAI Chat Completions; `reasoning_content` is ignored),
 * - `{ output_text }` or `{ output: [{ type: "message", content: [{ text }] }] }` (Responses API; reasoning items are ignored).
 * Returns the parsed object when the model already returned one, otherwise the text.
 */
export function replyContent(result: unknown): unknown {
  if (typeof result === "string") return result;
  const r = obj(result);
  if (!r) return null;
  if (r.response !== undefined && r.response !== null) return r.response;
  if (Array.isArray(r.choices) && r.choices.length) {
    const c = obj(r.choices[0]);
    const m = c && obj(c.message);
    const text = m ? contentText(m.content) : c ? contentText(c.text) : null;
    if (text !== null) return text;
  }
  if (typeof r.output_text === "string") return r.output_text;
  if (Array.isArray(r.output)) {
    const texts = r.output
      .map(obj)
      .filter((o): o is Record<string, unknown> => !!o && o.type === "message")
      .map((o) => contentText(o.content))
      .filter((t): t is string => !!t);
    if (texts.length) return texts.join("\n");
  }
  return null;
}

/** Token usage from either naming (prompt/completion or input/output tokens). */
export function replyUsage(result: unknown): { input: number; output: number } {
  const u = obj(obj(result)?.usage);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(u?.prompt_tokens ?? u?.input_tokens), output: n(u?.completion_tokens ?? u?.output_tokens) };
}

/** Every balanced top-level `{…}` in the text, in order (braces inside JSON strings are skipped). */
function braceBlocks(t: string): string[] {
  const out: string[] = [];
  for (let start = t.indexOf("{"); start >= 0; start = t.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(t.slice(start, i + 1));
        start = i; // continue after this block
        break;
      }
    }
  }
  return out;
}

/**
 * Candidate JSON objects in a reply, most likely first. An object reply is its own candidate.
 * For text: the whole text (minus code fences), then each balanced `{…}` from the LAST to the first,
 * because reasoning models write their thinking before the answer. `<think>…</think>` blocks are dropped.
 */
export function jsonCandidates(x: unknown): unknown[] {
  if (x && typeof x === "object") return [x];
  if (typeof x !== "string") return [];
  const text = x.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const tries: string[] = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).reverse();
  tries.push(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""), ...fenced, ...braceBlocks(text).reverse());
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      const key = JSON.stringify(v);
      if (v && typeof v === "object" && !seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    } catch {
      // not JSON: try the next candidate
    }
  }
  return out;
}

/** Any value as trimmed text (arrays joined with "; "). */
export const asText = (v: unknown): string =>
  typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(asText).filter(Boolean).join("; ") : v == null ? "" : String(v);

/** A list of at most `max` non-empty lines (≤ 300 chars each), with bullet markers stripped. */
export function asList(v: unknown, max: number): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [];
  return arr
    .map((x) => asText(x).replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((x) => x.length > 0)
    .slice(0, max)
    .map((x) => trunc(x, 300));
}

// ---------- coercion per task: each returns null when the reply can't be used ----------

/** Brief: goal and doneWhen are required. */
export type BriefOut = { brief: Brief; why: string };
export function coerceBrief(x: unknown): BriefOut | null {
  const o = obj(x);
  if (!o) return null;
  const brief: Brief = {
    goal: asText(o.goal),
    audience: asText(o.audience),
    assumptions: asText(o.assumptions),
    outOfScope: asText(o.outOfScope ?? o.out_of_scope),
    doneWhen: asText(o.doneWhen ?? o.done_when)
  };
  if (!brief.goal || !brief.doneWhen) return null;
  return { brief, why: asText(o.why) };
}

/** Consult decision; `role` is upper-cased as given (the engine maps it to a RoleId). */
export type DecideOut = { consult: boolean; role: string; question: string; why: string };
export function coerceDecide(x: unknown): DecideOut | null {
  const o = obj(x);
  if (!o) return null;
  const c = o.consult;
  const consult = c === true || (typeof c === "string" && /^(true|yes)$/i.test(c.trim()));
  return { consult, role: asText(o.role).toUpperCase(), question: asText(o.question), why: asText(o.why) };
}

/** Consult answer (≤ 1200 chars). */
export type AnswerOut = { answer: string; why: string };
export function coerceAnswer(x: unknown): AnswerOut | null {
  const o = obj(x);
  const answer = o ? asText(o.answer) : "";
  return answer ? { answer: trunc(answer, 1200), why: asText(o!.why) } : null;
}

/** Draft or revision: ≤ 8 bullets (at least one), ≤ 3 open questions. */
export type DraftOut = { bullets: string[]; why: string; openQuestions: string[] };
export function coerceDraft(x: unknown): DraftOut | null {
  const o = obj(x);
  if (!o) return null;
  const bullets = asList(o.bullets, 8);
  if (!bullets.length) return null;
  return { bullets, why: asText(o.why), openQuestions: asList(o.openQuestions ?? o.open_questions, 3) };
}

/** Critic review; the verdict is read leniently ("accept", "revise"…), the note is never empty. */
export type ReviewOut = { verdict: "approved" | "sent_back"; note: string; why: string };
export function coerceReview(x: unknown): ReviewOut | null {
  const o = obj(x);
  if (!o) return null;
  const v = asText(o.verdict).toLowerCase();
  const verdict = /sent|back|revis|reject/.test(v) ? "sent_back" : /approv|accept|pass/.test(v) ? "approved" : null;
  if (!verdict) return null;
  const why = asText(o.why);
  // Small models sometimes leave `note` empty and put the reason in `why`; the note is what the
  // owner revises against and what the document shows, so never let it be blank.
  const note = asText(o.note).trim() || why.trim() || (verdict === "approved" ? "Meets the brief and guidance." : "Does not yet meet the section guidance.");
  return { verdict, note: trunc(note, 600), why };
}

/** Sample-size decision; rates given as percentages (30) are converted to fractions (0.30). */
export type SizingOut = { use: boolean; request: SampleSizeRequest | null; why: string };
export function coerceSizing(x: unknown): SizingOut | null {
  const o = obj(x);
  if (!o) return null;
  const u = o.use;
  const use = u === true || (typeof u === "string" && /^(true|yes)$/i.test(u.trim()));
  const why = asText(o.why);
  if (!use) return { use: false, request: null, why };
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : undefined);
  // Models often give rates as percentages (30 for 30%); the calculator itself stays strict.
  const rate = (v: unknown) => { const n = num(v); return n !== undefined && n > 1 && n < 100 ? n / 100 : n; };
  const extra = { ...(num(o.alpha) !== undefined ? { alpha: num(o.alpha) } : {}), ...(num(o.power) !== undefined ? { power: rate(o.power) } : {}) };
  const test = asText(o.test).toLowerCase();
  const request = (/mean|cohen|^d$/.test(test) || (num(o.effectSize) !== undefined && num(o.p1) === undefined)
    ? { test: "two_means", effectSize: num(o.effectSize) as number, ...extra }
    : { test: "two_proportions", p1: rate(o.p1) as number, p2: rate(o.p2) as number, ...extra }) as SampleSizeRequest;
  return { use: true, request, why };
}

/** Merged open questions; each keeps the raisedBy of the raw question it represents. */
export type MergeOut = { questions: { question: string; raisedBy: RoleId }[]; why: string };
/** Builds the coercion for one merge turn (it needs the raw list to map `source` indexes back). */
export function coerceMerge(raw: { question: string; raisedBy: RoleId }[]) {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  return (x: unknown): MergeOut | null => {
    const o = obj(x);
    if (!o || !Array.isArray(o.questions) || !raw.length) return null;
    const out: MergeOut["questions"] = [];
    for (const q of o.questions.slice(0, 6)) {
      const qo = obj(q);
      const question = trunc(qo ? asText(qo.question) : asText(q), 300);
      if (!question) continue;
      let i = qo ? Number(qo.source) : NaN;
      if (!Number.isInteger(i) || i < 0 || i >= raw.length) {
        // No usable representative index: pick the raw question with the largest word overlap.
        const w = words(question);
        let best = 0;
        raw.forEach((r, j) => {
          const n = [...words(r.question)].filter((x) => w.has(x)).length;
          if (n > best) [best, i] = [n, j];
        });
        if (!Number.isInteger(i) || i < 0) i = 0;
      }
      out.push({ question, raisedBy: raw[i].raisedBy });
    }
    return out.length ? { questions: out, why: asText(o.why) } : null;
  };
}

/** Words that make a capitalised pair a role, section or thing rather than a person's name. */
const NOT_NAMES = new Set((
  "product lead principal investigator methods specialist data analyst ethics reviewer critic researcher designer engineer " +
  "work plan lab experiment design team squad research mobile ux brief goal scope milestones owners timeline risks dependencies " +
  "open questions hypothesis variables method sample controls measurements analysis plan the a an and of for to with in on at " +
  "by is be it this that each every all no not do use keep state name names section sections run runs future next always never " +
  "when if before after send back sent approved review reviews draft drafts revise revision critic's placeholder week day " +
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday " +
  "ios android web app apps api ai sdk github q1 q2 q3 q4 cohen's power alpha baseline retention onboarding checklist consent " +
  "privacy gdpr irb mvp beta pilot sync offline"
).split(/\s+/));

/** Heuristic: a "First Last" pair of capitalised words that aren't known role/section/common words, or an honorific. */
export function hasPersonName(text: string): boolean {
  if (/\b(Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+/.test(text)) return true;
  const re = /\b([A-Z][a-z]{1,})\s+([A-Z][a-z]{1,})\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!NOT_NAMES.has(m[1].toLowerCase()) && !NOT_NAMES.has(m[2].toLowerCase())) return true;
  }
  return false;
}

/** One memory item proposed by a member's end-of-run reflection. */
export type ReflectItem = { kind: "lesson" | "note"; text: string };
/** Reflection: ≤ 2 items; `dropped` counts items left out because they named people. */
export type ReflectOut = { items: ReflectItem[]; why: string; dropped: number };
/** ≤ 2 items, each ≤ 300 chars; items naming people are dropped (counted in `dropped`). */
export function coerceReflect(x: unknown): ReflectOut | null {
  const o = obj(x);
  if (!o || !Array.isArray(o.items)) return null;
  let dropped = 0;
  const items: ReflectItem[] = [];
  for (const it of o.items) {
    const io = obj(it);
    const text = trunc((io ? asText(io.text) : asText(it)).replace(/\s+/g, " "), 300);
    if (!text) continue;
    if (hasPersonName(text)) { dropped++; continue; }
    items.push({ kind: io && /note/i.test(asText(io.kind)) ? "note" : "lesson", text });
    if (items.length === 2) break;
  }
  return { items, why: asText(o.why), dropped };
}

// ---------- the model call ----------

type ChatMessage = { role: string; content: string };

/**
 * The Workers AI input for one attempt. JSON mode (`response_format`) is sent only when the model
 * supports it and `json` is true; its shape follows the model's API (`ModelInfo.openAiFormat`).
 */
export function modelRequest(model: ModelInfo, messages: ChatMessage[], schema: object, json: boolean): Record<string, unknown> {
  const responseFormat = model.openAiFormat
    ? { type: "json_schema", json_schema: { name: "reply", schema } }
    : { type: "json_schema", json_schema: schema };
  return {
    ...(model.extra ?? {}),
    messages,
    max_tokens: model.maxTokens ?? MAX_OUTPUT_TOKENS,
    ...(json && model.jsonMode ? { response_format: responseFormat } : {})
  };
}

/** The first candidate in the reply that coerces into the task's shape, or null. */
export function coerceReply<T>(content: unknown, coerce: (x: unknown) => T | null): T | null {
  for (const c of jsonCandidates(content)) {
    const data = coerce(c);
    if (data) return data;
  }
  return null;
}

/**
 * One model turn on `model` (an entry of MODELS: resolve ids with `modelInfo`).
 * Attempt 1 uses JSON mode when the model supports it; if the reply doesn't coerce (or the call
 * fails), attempt 2 re-asks without JSON mode. Each attempt is aborted after LLM_TIMEOUT_MS.
 * A "free allowance used up" error returns at once with `quota: true`.
 * `metadata` goes to AI Gateway (≤ 5 keys, string/number) so its logs can be filtered by run, role, agent.
 */
export async function callModel<T>(
  env: Env,
  p: { model: ModelInfo; system: string; prompt: string; schema: object; coerce: (x: unknown) => T | null; metadata: Record<string, string | number> }
): Promise<LlmOutcome<T>> {
  const model = p.model;
  const out: LlmOutcome<T> = { ok: false, data: null, raw: "", error: null, quota: false, inputTokens: 0, outputTokens: 0, gatewayLogId: null, attempts: 0 };
  const messages: ChatMessage[] = [
    { role: "system", content: p.system },
    { role: "user", content: p.prompt }
  ];
  for (const attempt of [1, 2]) {
    out.attempts = attempt;
    const msgs: ChatMessage[] =
      attempt === 1
        ? messages
        : [
            ...messages,
            ...(out.raw ? [{ role: "assistant", content: trunc(out.raw, 1500) }] : []),
            { role: "user", content: "That reply was not valid JSON in the requested shape. Return only the JSON object with exactly the requested keys." }
          ];
    try {
      // The model id comes from MODELS, so it is a valid catalog id; the input is built per model above.
      const result: unknown = await env.AI.run(
        model.id as keyof AiModels,
        modelRequest(model, msgs, p.schema, attempt === 1) as never,
        { gateway: { id: env.GATEWAY_ID, metadata: p.metadata }, signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }
      );
      const usage = replyUsage(result);
      out.inputTokens += usage.input;
      out.outputTokens += usage.output;
      out.gatewayLogId = env.AI.aiGatewayLogId ?? out.gatewayLogId;
      const content = replyContent(result);
      out.raw = typeof content === "string" ? content : JSON.stringify(content ?? result);
      const data = coerceReply(content, p.coerce);
      if (data) return { ...out, ok: true, data, error: null };
      out.error = "reply was not valid JSON in the requested shape";
    } catch (e) {
      out.error = errMsg(e);
      out.gatewayLogId = env.AI.aiGatewayLogId ?? out.gatewayLogId;
      if (/4006|daily free allocation|neurons|quota/i.test(out.error)) return { ...out, quota: true };
    }
  }
  return out;
}
