# Test cases

> Fictional test data for the Team Agents Kit. Every company, product, customer, study and number here is invented; there is no real personal data.

Two realistic end-to-end cases for the run engine: a task, 4 context files in real formats, and a rubric with planted hooks that show whether the agents used the files, surfaced conflicts and avoided inventing things.

| Case | Team → output | Files | What it tests |
|---|---|---|---|
| [`01-product-offline-mode`](01-product-offline-mode/) | `squad` → Work plan | `research-notes.md`, `connectivity-metrics.csv`, `roadmap-constraints.pdf`, `stakeholder-thread.docx` | A frozen sync SDK and a capacity drop that conflict with the deadline; a task assumption the CSV contradicts; file-only facts; an undecided pricing question that belongs in Open questions; no repository |
| [`02-research-onboarding`](02-research-onboarding/) | `ux-research` → Lab experiment design | `prior-studies.pdf`, `baseline-cohorts.csv`, `ethics-policy.docx`, `recruitment-panel.txt` | Policy rules (no under-18s, 90-day deletion, opt-in, stop condition, no incentives); a 30 % baseline that implies **961 per group (1,922 total)**; a recruitment window that only yields ~1,720; an undecided web question |

Each case folder holds `case.json` (task, team, files), `files/`, `expected.md` (rubric and score sheet) and `checks.json` (the mechanical part of the rubric, used by `score.mjs`). Results go to `<case>/results/<timestamp>/`.

## Run

From the project root, with the app running locally (`npm run dev -- --port 8788`) or a deployed URL:

```sh
node test-cases/run-case.mjs test-cases/01-product-offline-mode --dry-run   # validate only, no server
node test-cases/run-case.mjs test-cases/01-product-offline-mode              # http://localhost:8788
node test-cases/run-case.mjs test-cases/02-research-onboarding https://<your-worker>.workers.dev
ACCESS_PASSCODE=… node test-cases/run-case.mjs …                             # when access control is on
```

Options: `--version n` (a saved version of the case's team; default latest), `--timeout-min m` (default 30).

`run-case.mjs` uploads each file (`POST /api/files`, fails if extraction isn't `ready`), creates the run (`POST /api/runs { task, title, teamId, fileIds }`), waits for the brief, approves it unchanged, waits for `completed` / `stopped` / `failed`, then saves `state.json` (final RunState), `spans.json`, `document.md` and `summary.txt`, and runs the scorer. `scripts/run-test.mjs` has no flag for a custom task, so this is its own small client. The passcode is sent as `Authorization: Bearer …` and never printed.

Score a saved result again (newest by default):

```sh
node test-cases/score.mjs test-cases/02-research-onboarding [test-cases/02-research-onboarding/results/<timestamp>]
```

It prints pass/fail per check (`must` / `should`) and exits 1 if a `must` fails. The checks are keyword heuristics; finish the `manual` rows of `expected.md` by reading `document.md`.

## Case 01 and the `read_files` tool

In the default squad (v1) only the **Researcher** reads files, and it owns only **Dependencies**; consult answers don't carry file text. So a v1 run mostly tests whether file facts reach Dependencies. To test the whole plan, save a squad version where the Designer and Engineer can also read files, then run with it:

```sh
curl -X POST http://localhost:8788/api/teams/squad/versions -H 'content-type: application/json' \
  -d '{"note":"Test: Designer and Engineer read files","members":[{"role":"D","tools":["shared_draft","read_files"]},{"role":"E","tools":["github_repo","read_files","shared_draft"]}]}'
node test-cases/run-case.mjs test-cases/01-product-offline-mode --version <n from the reply>
```

Comparing the two runs is itself a useful test of team versions.

## What to look for

- **File use:** a "Read <file>" tool span per file per reading role, files listed in section sources, and file-only facts in the text (case 01: SyncKit, SEC-12, Harbourline clause 7.2, 67 MB, 18 March cutoff; case 02: day 7–13 retention definition, 90-day deletion, 25 % stop rule).
- **Conflicts surfaced, not smoothed over:** case 01 Risks/Dependencies must name the SyncKit freeze with a mitigation and should challenge the "< 10 minute gaps" assumption with numbers (only 35.7 % of gaps are under 10 min); case 02 must notice that ~860 per group < 961 needed.
- **Open questions:** case 01 "which plans get offline mode"; case 02 "include web signups?". Agents should not decide these.
- **Sample size:** case 02 should show 961 per group (1,922 total), ideally from the Data analyst's sample-size tool span; working in `02-research-onboarding/expected.md`.
- **No hallucinations:** no invented people (Owners use `[PLACEHOLDER]`s), no money figures, no incentives, no numbers absent from the files.
- **Critic:** send-backs should target real gaps (e.g. a Risks section without mitigations), and the before/after should improve.

## Files

| File | Format | Size | Text |
|---|---|---|---|
| 01 `research-notes.md` | Markdown | ~3.3 KB | read directly |
| 01 `connectivity-metrics.csv` | CSV, 36 data rows | ~2.3 KB | toMarkdown |
| 01 `roadmap-constraints.pdf` | PDF 1.4, 2 pages, Helvetica text (not scanned) | ~6.8 KB | toMarkdown |
| 01 `stakeholder-thread.docx` | Word (made with `textutil`) | ~5 KB | toMarkdown |
| 02 `prior-studies.pdf` | PDF 1.4, 1 page | ~5.9 KB | toMarkdown |
| 02 `baseline-cohorts.csv` | CSV, 32 data rows | ~1.4 KB | toMarkdown |
| 02 `ethics-policy.docx` | Word (made with `textutil`) | ~5 KB | toMarkdown |
| 02 `recruitment-panel.txt` | Plain text | ~2 KB | read directly |

Every CSV starts with a `# Fictional test data…` comment line before the header. PDF text was checked with macOS PDFKit, docx text with `textutil -convert txt`.
