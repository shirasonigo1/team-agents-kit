> Fictional test data for the Team Agents Kit. Evaluation rubric for case 01.

# Case 01 — SiteLog offline mode → Work plan: what a good answer looks like

**Team:** `squad` (Product squad: Product lead, Researcher, Designer, Engineer, Critic) · **Output:** Work plan · **Repo:** none (Engineer works in "technical questions only" mode).

## Files and what only they contain

| File | Format | Facts that appear only here |
|---|---|---|
| `research-notes.md` | Markdown | 9 inspectors P1–P9; median **23 photos ≈ 67 MB** per inspection; **38 min/day** re-typing; **Harbourline contract clause 7.2** (signed report before leaving site); conflicts rare (2 of 9), "show both and let me pick"; nobody wants offline web dashboard or history > 30 days |
| `connectivity-metrics.csv` | CSV, 36 rows | 6 weeks × 6 regions, 7,763 inspections. **41.5 %** of inspections hit a gap. Of 4,997 gaps only **35.7 % are under 10 min**; 44.5 % are 10–60 min and 19.8 % over 60 min. Urban regions support the assumption (City Central 79 % of gaps < 10 min), Metro Underground / Hospital Estate / Rural North contradict it (9–17 % < 10 min, medians 47–67 min) |
| `roadmap-constraints.pdf` | PDF, 2 pages | **SyncKit 3.2 frozen 1 Dec 2026 – 1 Mar 2027** (no protocol/schema/server conflict handling; no offline queue); one mobile engineer on **leave 15 Feb – 15 Apr** (2 mobile engineers in March); backend engineer ~50 % lent to Platform in February; **release cutoff 18 March**; Harbourline **MDM approval 5 working days**; **SEC-12**: encryption at rest + remote wipe, **10-working-day security review booked 2 weeks ahead**; non-goals (web dashboard, history > 30 days, Android < 10, no flow redesign); pilots Harbourline (140 seats, renewal 30 Apr), Calder (60), Morrow (25) |
| `stakeholder-thread.docx` | Word | Renewal condition incl. **signature on site**; Sales: **Enterprise-only or every plan?** — unanswered, parked for the pricing committee "no date yet"; EM: ~2.5 weeks between 1 March and 18 March for sync work, server-side conflict handling not feasible by end of March; Morrow is on the Team plan |

> Note on the default team: in squad v1 only the **Researcher** has `read_files`, and the Researcher owns only **Dependencies**. Consult answers do not include file text, so with v1 most file facts can reach the other sections only indirectly. Run once with v1 (baseline) and once with a version where the Designer and Engineer also have `read_files` (see `../README.md`) and compare.

## Planted test hooks

1. **Conflict with the task — the SyncKit freeze (and capacity).** The task asks for offline sync by 31 March; the roadmap freezes the sync layer until 1 March and SyncKit 3.2 has no offline queue or conflict handling. A good plan **must** surface it in **Risks** (with a mitigation: build local store / photo queue / sync status against the existing API before March, client-side "pick a version" conflicts, defer server-side conflict handling past beta, or negotiate an exception with Platform) and in **Dependencies** (Platform team unfreeze on 1 March). The capacity drop (leave from 15 Feb) should appear in Risks or Timeline.
2. **The assumption in the task is wrong.** "Most gaps are under 10 minutes" — the CSV says only ~36 % are. A good plan says so with numbers and draws the consequence (a retry queue is not enough; true local-first storage needed). Partial credit if it notes the regional split.
3. **File-only facts (did the Researcher use the files?).** Harbourline / clause 7.2, 67 MB / 23 photos, 38 min re-entry, SyncKit, SEC-12, 18 March cutoff, MDM 5 days. None of these is in the task.
4. **Unanswerable ambiguity → Open questions.** *Which plans get offline mode (Enterprise only or all)?* Files explicitly say it is undecided with no date. It must land in **Open questions** (not be decided by an agent). Bonus: consequence for Morrow (Team plan) as a pilot.
5. **No repository.** The Engineer must not claim code-level estimates.

## Section-by-section rubric

| Section | A good answer must contain | Provenance (from) |
|---|---|---|
| Goal | Inspectors complete inspections offline (checklist, photos, signature) without data loss; beta to 3 pilots by **31 Mar 2027**; GA go/no-go **30 Apr 2027** | task, thread |
| Scope and non-goals | In: offline checklist, photo queue with per-photo status, offline signature, sync status per report, simple conflict handling. Non-goals: web dashboard offline, history > 30 days, Android < 10, flow redesign | research notes, roadmap PDF |
| Milestones | 3–5 milestones each shipping inspector value, e.g. (1) local save + sync status, (2) photo queue, (3) offline signature, (4) pilot beta build through MDM, (5) GA readiness / conflicts. Ordering respects the freeze (sync-touching work after 1 March) | roadmap PDF |
| Owners | Every owner a placeholder or role (`[MOBILE LEAD]`, `[PM]`, `[DESIGNER]`). **No invented person names.** | template guidance |
| Timeline | Phases from Dec 2026 to 31 Mar 2027 with file dates: freeze until 1 Mar, leave from 15 Feb, **18 Mar release cutoff**, MDM 5 working days, security review 10 working days booked 2 weeks ahead | roadmap PDF |
| Risks | SyncKit freeze (high) + mitigation; capacity / leave + mitigation (descope conflicts, sequence work); long gaps & large photo payloads (67 MB, 32 GB Android devices) + mitigation; security review slip; MDM approval delay. Each with likelihood and concrete mitigation | roadmap PDF, CSV, research notes |
| Dependencies | Platform team / SyncKit unfreeze 1 Mar; SEC-12 security review; Harbourline MDM approval; pricing committee decision on plans; pilot customer availability | roadmap PDF, thread |
| Open questions | Which plans get offline mode (must). Others welcome: server-side conflict handling after beta?, how long data may stay on device, Morrow on Team plan | thread |

## Hallucinations to flag (each one = fail of H-checks)

- Invented people's names (Owners or anywhere), invented customers, invented team names.
- Money amounts, contract values, seat prices (none exist in the files).
- Percentages or durations not derivable from the files (e.g. "90 % of gaps are short", "SyncKit unfreezes in January").
- Claims about the codebase, pull requests or GitHub (no repository was linked).
- Deciding the plan/tier question as if it were settled.

## Score sheet

Mechanical checks (`node test-cases/score.mjs test-cases/01-product-offline-mode`) use the same ids. Tick the manual ones by hand.

| Id | Level | Check | Pass/Fail |
|---|---|---|---|
| G1 | must | Goal states 31 March 2027 | |
| G2 | should | 30 April GA go/no-go appears | |
| S1 | must | Non-goal: web dashboard | |
| S2 | must | Scope covers photos and signature | |
| S3 | should | Another file-only non-goal (30-day history / Android 10) | |
| M1 | must | ≥ 3 milestones | |
| M2 | manual | Each milestone ships inspector value; sync work sequenced after 1 March | |
| O1 | must | Owners use placeholders | |
| O2 | must | No invented person names in Owners | |
| T1 | should | Timeline uses a file date (1 Mar / 18 Mar / 15 Feb) | |
| T2 | manual | Timeline is feasible against the 18 March cutoff + 5-day MDM approval | |
| R1 | must | Risks names the SyncKit freeze (planted conflict) | |
| R2 | should | Risks names reduced capacity | |
| R3 | must | Risks give mitigations | |
| R4 | manual | Every risk has a likelihood and a concrete mitigation | |
| D1 | must | Dependencies: Platform / SyncKit unfreeze | |
| D2 | should | Dependencies: SEC-12 security review | |
| D3 | should | MDM approval appears | |
| D4 | must | Dependencies cites at least one file in its sources | |
| Q1 | must | Open questions: which plans get offline mode | |
| A1 | must | < 10-minute assumption challenged with CSV numbers | |
| F1 | must | A file-only fact is used | |
| F2 | should | Researcher has a "Read <file>" span for all 4 files | |
| H1 | must | No money amounts | |
| H2 | should | No code-level claims | |
| H3 | manual | No invented numbers, customers or decisions | |
| P1 | manual | Each section's provenance (sources) matches the table above | |

Pass bar: all **must** checks pass, ≥ 70 % of **should**, no manual hallucination finding.
