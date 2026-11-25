# Team Agents Kit

**Set up a team of AI agents, give them one task, and get back a structured document, with every step the agents took visible and traceable.**

> **This is a prototype.** It is a personal experiment in what you can build with Cloudflare's developer platform (Workers, the Agents SDK, Durable Objects, Workers AI, AI Gateway and D1) on the **free plan**. It is not production software: expect rough edges, small free models that sometimes get things wrong, and a shared-passcode login. Use it to learn from and build on.

---

## What it does

A **team** is a group of specialist agents with one coordinator and a Critic. You give the team a task and some context files. The coordinator drafts a brief, which you approve. After that the team works on its own: specialists write their sections, consult each other along the team's handoff rules, use tools, and the Critic reviews every section. The result is a finished document. Every section links back to who wrote it, who was consulted, what it was built from, and how its review went.

Two team templates are included:

| Template | Coordinator | Specialists | Output |
|---|---|---|---|
| **Product squad** | Product lead | Researcher, Designer, Engineer, Critic | **Work plan**: Goal, Scope and non-goals, Milestones, Owners, Timeline, Risks, Dependencies, Open questions |
| **Research lab** | Principal investigator | Methods specialist, Data analyst, Ethics reviewer, Critic | **Lab experiment design**: Hypothesis, Variables, Method, Sample and controls, Measurements, Analysis plan, Risks and ethics, Open questions |

### Main features

- **Real subagents.** Every team member is its own Agent (a Durable Object) with its own memory, inbox and model calls. Members are shared across runs, so they learn from earlier runs of their team (lessons from Critic send-backs, outcomes and their own end-of-run reflections).
- **One checkpoint, then autonomy.** You approve (or edit) the brief and section plan once. After that you can stop the run but not steer it, so the trace is how you understand what happened.
- **Observability as the core feature.** Every agent turn is recorded as a *span*: its reason, inputs and outputs, tokens, model, duration, parent span and AI Gateway log id. You can view a run as a **Graph** (who talked to whom), a **Waterfall** (timing, nesting and loops), a **Log** (the story of the run) or by **Agents** (per-member turns, tokens and memories used). All totals are computed from the spans, so the views always agree.
- **Document provenance.** Each section shows its writer, the roles consulted, the review result (including the Critic's note and a before/after comparison), its token cost and its sources: files, consult answers, tool results.
- **Versioned teams.** Edit each member's personality, responsibilities, tools and **model**, the consult rules between specialists, and the guardrails. Every save creates a new version, and each run records the exact version it used.
- **Tools.** Reading uploaded files (PDF, DOCX, XLSX, CSV, TXT, MD and HTML, converted to Markdown), a read-only view of a public GitHub repository, and a **sample-size calculator** for the Data analyst. The calculator runs in code, not in the model. An automatic check sends back any sample size that wasn't produced by the calculator.
- **Guardrails.** Maximum turns, a token budget, Critic rounds per section, and a stop if nothing progresses. Questions no agent can answer go to an Open questions section instead of stalling the run.
- **Access control.** One shared passcode protects every page, API and WebSocket.

---

## Architecture

```
 Browser (plain HTML + JS in public/)
    │  HTTPS + WebSocket (live run state)
    ▼
┌─────────────────────────── Cloudflare Worker (src/server.ts) ──────────────────────────────┐
│  accessGate (src/access.ts) ── every request except /login, /logout, /api/health           │
│  /api/*  teams, versions, templates, files, runs, members, models      ──►  D1 (SQLite)    │
│  /agents/run-agent/<id>  ──► routeAgentRequest                                             │
│  everything else         ──► static assets (ASSETS binding)                                │
└────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                         │
             ┌───────────────────────────▼──────────────────────────────┐
             │ RunAgent  (Durable Object, one per run)  — coordinator    │
             │  • step machine: brief → approve → per section            │
             │    (assign → consult → tools → draft → review → revise)   │
             │    → open questions → reflections → assemble              │
             │  • enforces handoff rules, guardrails, Stop               │
             │  • writes the trace (spans) and pushes state over WS      │
             │  • runs engine tools: file excerpts, GitHub, calculator   │
             └───────┬───────────────────────────────────┬──────────────┘
                     │ RPC: turn() / deliver() / remember()
       ┌─────────────▼─────────────┐       ┌─────────────▼─────────────┐
       │ MemberAgent "squad--R"    │  ...  │ MemberAgent "squad--C"    │   one Durable Object per
       │  own SQLite: memories,    │       │  (Critic)                 │   team member, shared by
       │  inbox, turns, results    │       │                           │   every run of the team
       │  builds its own prompt    │       │                           │
       └─────────────┬─────────────┘       └─────────────┬─────────────┘
                     └──────────────┬────────────────────┘
                                    ▼
                    Workers AI  (via AI Gateway "default": logs, metadata)
```

**How a run works:**

1. `POST /api/runs` creates a `RunAgent`, which snapshots the team version and the attached files. The coordinator member drafts the brief.
2. You approve the brief, and the run becomes autonomous. Each step is its own scheduled task (`this.schedule`), so a run survives restarts and Stop takes effect at the next step boundary.
3. For every model turn, the `RunAgent` calls the member's `MemberAgent` over Durable Object RPC. The member builds its prompt from its persona, its inbox for this run (the assignment, a consult answer, the Critic's note) and up to five relevant memories. It then calls Workers AI with its own model and returns the result. Results are stored per `(runId, spanId)`, so a retried step never calls the model twice.
4. Messages between members are delivered only along the team's handoff rules (hub and spoke: the coordinator and the Critic talk to everyone, and specialists talk only to the consult partners the team allows).
5. At the end, the members that worked each reflect once and keep at most two lessons. The coordinator then assembles the document.

### Cloudflare capabilities used

| Capability | Used for | Where |
|---|---|---|
| **Workers** | The HTTP API, the access gate and static file serving (`run_worker_first`) | `src/server.ts`, `src/access.ts` |
| **Workers Static Assets** | The UI in `public/`, served through the `ASSETS` binding after the access check | `wrangler.jsonc` |
| **Agents SDK** (`agents`) | The `Agent` base class, routing (`routeAgentRequest`), state sync to browsers over WebSocket (`setState`), scheduling (`this.schedule`), `getAgentByName` | `src/run-agent.ts`, `src/member-agent.ts` |
| **Durable Objects (SQLite storage)** | `RunAgent` (one per run: trace, state, step machine) and `MemberAgent` (one per team member: memory, inbox, turn log). Both use Durable Object RPC between them | `src/run-agent.ts`, `src/member-agent.ts` |
| **Workers AI** | Every model call (default: Llama 4 Scout 17B; the model can be set per member), and `toMarkdown` to extract text from uploaded PDF, DOCX, XLSX, CSV and HTML files | `src/llm.ts`, `src/files.ts` |
| **AI Gateway** | Logging for every model call, with metadata `{ runId, role, section, spanId, agent }` so the gateway logs can be filtered by run, role or member. The `default` gateway is created on first use | `src/llm.ts` |
| **D1** | Teams and immutable team versions, the runs list, and uploaded files (as extracted Markdown) | `src/teams.ts`, `src/runs-db.ts`, `src/files.ts`, `migrations/` |
| **Worker secrets** | `ACCESS_PASSCODE` for the access gate | `src/access.ts` |
| **Workers Observability** | Request logs and errors in the dashboard | `wrangler.jsonc` |

**Where to look in the Cloudflare dashboard:**

- **Workers & Pages → team-agents-kit → Durable Objects → MemberAgent**: one object per team member, such as `squad--R` or `ux-research--DA`.
- **AI → AI Gateway → default → Logs**: every model call; filter by the `agent` or `runId` metadata.
- **Storage & Databases → D1 → team-agents-kit**: teams, versions, runs and files.

---

## Setup

### Prerequisites

- A Cloudflare account. The free plan is enough.
- Node.js **22.18 or later**.

### 1. Install and log in

```sh
git clone <this repository> team-agents-kit
cd team-agents-kit
npm install            # also runs `wrangler types`, which generates worker-configuration.d.ts
npx wrangler login
```

### 2. Create your D1 database

```sh
npx wrangler d1 create team-agents-kit
```

Copy the printed `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`), replacing the one there. Then apply the schema:

```sh
npm run db:migrate:local    # for `npm run dev`
npm run db:migrate:remote   # for the deployed Worker
```

### 3. Set the access passcode

The whole app sits behind one shared passcode. Choose a long random one.

**Local development:** copy the example file and edit it. `.dev.vars` is git-ignored.

```sh
cp .dev.vars.example .dev.vars
```

**Production:** store it as a Worker secret. Wrangler prompts for the value, so it never appears in your shell history or the repository.

```sh
npx wrangler secret put ACCESS_PASSCODE
```

If the secret is missing, the Worker refuses every request (HTTP 503) instead of running unprotected.

**How people sign in:** opening any page redirects to `/login`. After entering the passcode they stay signed in for 7 days (a signed, HttpOnly cookie), and **Sign out** is in the header. To revoke everyone's access, set a new passcode with the same `wrangler secret put` command; all existing sessions stop working. Scripts authenticate with `Authorization: Bearer <passcode>` (they read `ACCESS_PASSCODE` from the environment).

### 4. Run locally

```sh
npm run dev            # http://localhost:8787
```

`wrangler dev` runs the Worker, Durable Objects and D1 locally, **but Workers AI calls go to your Cloudflare account** and count against its free allowance.

### 5. Deploy

```sh
npm run deploy         # → https://team-agents-kit.<your-subdomain>.workers.dev
```

### Configuration

| Setting | Where | Notes |
|---|---|---|
| `ACCESS_PASSCODE` | Secret (`.dev.vars` locally) | Required |
| `GATEWAY_ID` | `vars` in `wrangler.jsonc` | AI Gateway id; `default` is created automatically |
| Default model and model list | `DEFAULT_MODEL_ID`, `MODELS` in `src/contract.ts` | Each member's model is chosen in the team editor |
| Guardrails | Per team version (team editor) | Max turns, token budget, Critic rounds, no-progress limit |

---

## Testing

```sh
npm run check          # wrangler types + TypeScript
npm test               # unit tests: sample-size calculator, sample-size claim check, model reply parsing
node public/fixtures/check-fixtures.mjs   # UI fixture data matches the contract
```

The UI can be viewed without a backend: serve `public/` with any static server and add `?fixture=completed` (or `awaiting`, `running`, `stopped`, `lab-completed`, …) to `run.html`. The fixtures are in `public/fixtures/`.

**End-to-end tests** create real runs, so each one uses a few tens of thousands of tokens of your Workers AI allowance:

```sh
export ACCESS_PASSCODE=...        # or: read -s ACCESS_PASSCODE && export ACCESS_PASSCODE
npm run test:e2e -- http://localhost:8787                      # one run, with consistency checks
node test-cases/run-case.mjs test-cases/02-research-onboarding http://localhost:8787
```

`test-cases/` holds two fictional case studies, one per template, each with context files (PDF, DOCX, CSV, MD and TXT), planted test hooks, an evaluation rubric (`expected.md`) and an automatic scorer (`score.mjs`). See [test-cases/README.md](test-cases/README.md).

---

## Project layout

```
src/
  server.ts        Worker entry: access gate, API routes, agent routing, static assets
  access.ts        Passcode login, signed session cookies, Bearer auth for scripts
  contract.ts      Shared types and constants: roles, tools, templates, outputs, models, API reference
  run-agent.ts     RunAgent: the coordinator, step machine, trace, guardrails, engine tools
  member-agent.ts  MemberAgent: one team member's memory, inbox and model turns
  llm.ts           Workers AI calls through AI Gateway, JSON parsing and retries
  prompts.ts       Prompt builders and JSON schemas per task
  teams.ts         Templates, seeding, team versions and validation (D1)
  runs-db.ts       Runs list (D1)
  files.ts         Uploads and text extraction with Workers AI toMarkdown (D1)
  sample-size.ts   Sample-size calculator (pure function)
  checks.ts        Automatic check for sample sizes not produced by the calculator
public/            The UI: teams, team editor, new run, run (brief, trace, document), runs list
migrations/        D1 schema
scripts/           Unit tests and the end-to-end test runner
test-cases/        Case studies with context files, rubrics and a scorer
```

The full HTTP API is documented at the end of [`src/contract.ts`](src/contract.ts).

---

## Free-plan limits and known issues

- **The Workers AI daily allowance is the real limit.** A full run uses roughly 20,000–50,000 tokens, which is only a few runs a day on the free allowance. When it runs out, runs fail with a clear "free allowance used up" reason until the daily reset (00:00 UTC). Giving drafting roles a smaller model stretches the allowance.
- **Small models make mistakes.** Agents sometimes miss facts that are in the files, and only about 6,000 characters of the most relevant file text reach each prompt. The automatic sample-size check catches one kind of invented number, not all of them.
- **Only Llama 4 Scout is verified.** The other models in the picker have not completed a full run with this app yet and are marked "not yet tested".
- **Shared passcode.** There are no individual accounts, so runs and edits aren't attributed to people. For per-person sign-in, put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the Worker.
- **Web search is not included.** Cloudflare's web search tool needs paid credits.

---

## Next steps

Ideas for where this experiment could go next:

1. **Verify more models** and choose cheaper defaults per role, for example a small model for drafting and a larger one for the Critic.
2. **Better use of context files**: smarter excerpt selection (embeddings with Vectorize instead of keyword overlap), and letting more roles read files by default.
3. **Compare runs across team versions** side by side: did a stricter Critic improve the document, or only raise the cost?
4. **Replay** a finished run step by step from its stored spans.
5. **The design document output**, with a Design studio template.
6. **Per-person sign-in** with Cloudflare Access, with runs and team edits attributed to people.
7. **Memory management**: review, edit and pin what each member remembers, and decide what should be forgotten.
8. **Workflows** for long runs, and real tests with `@cloudflare/vitest-pool-workers`.

---

## License

Released under the [MIT License](LICENSE).
