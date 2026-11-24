> Fictional test data for the Team Agents Kit. Evaluation rubric for case 02.

# Case 02 — Tallyfox onboarding checklist → Lab experiment design: what a good answer looks like

**Team:** `ux-research` (Research lab: Principal investigator, Methods specialist, Data analyst, Ethics reviewer, Critic) · **Output:** Lab experiment design · **Repo:** none. MS, DA and ER have `read_files` by default; DA also has the sample-size calculator.

## Files and what only they contain

| File | Format | Facts that appear only here |
|---|---|---|
| `prior-studies.pdf` | PDF, 1 page | **Week-1 retention definition (RET-W1-v2): ≥ 1 meaningful action (log expense, create/send invoice, connect/refresh bank, edit budget) on any day 7–13 after signup**; Study A: tips test +2.1 pts, n = 1,212, p = 0.42 (underpowered); Study B: checklists +3 to +8 pts, novelty halves effect after a month; Study C: bank connection = "already useful"; suggests secondary metrics (checklist completion, bank connection) and exploratory week-4 retention (day 28–34) |
| `baseline-cohorts.csv` | CSV, 32 rows | 16 weekly cohorts × iOS/Android from 27 Jul 2026: 16,064 signups, 13,785 adult-verified (85.8 %), 6,864 research opt-in (49.8 % of adults, ~429/week), **2,059 retained → 30.0 % baseline** (iOS 31.3 %, Android 28.5 %) |
| `ethics-policy.docx` | Word | R1 **no under-18s; unverified birth year = excluded before assignment**; R2 opt-in "Help improve Tallyfox" + exact notice wording, drop-outs removed from analysis; R3 **event-level data deleted 90 days after study end**, aggregates kept 3 years, deletion date in plan; R4 pseudonymous ids, **no amounts/payees/invoice text**; R5 pre-register with RRB, meetings 17 Dec 2026 and 14 Jan 2027, submit 7 days before; R6 **stop if support contacts per 1,000 > control by 25 % over 7 days**, data incident, harm complaint; R7 control gets standard experience; R8 **no incentives, no paid panel top-up**; R9 one onboarding experiment at a time; R10 access limited |
| `recruitment-panel.txt` | Text | Mobile only; ~1,000 signups/week → **~430 eligible/week**; **enrolment window 18 Jan – 14 Feb 2027 (4 weeks)** because of the 1 March price change; **≈ 1,720 total, ≈ 860 per group**; no panel top-up, no marketing campaign; **web signups (~180 eligible/week) undecided — checklist not built for web** |

## The expected sample size (shown)

Two-sided test of two proportions, normal approximation, α = 0.05, power = 0.80:

- p1 = 0.30 (baseline from the CSV: 2,059 / 6,864), p2 = 0.36 (+6 points, from the task)
- z₀.₉₇₅ = 1.95996, z₀.₈₀ = 0.84162 → (z₀.₉₇₅ + z₀.₈₀)² = 2.80158² = **7.8489**
- p1(1−p1) + p2(1−p2) = 0.21 + 0.2304 = **0.4404**
- (p1 − p2)² = 0.06² = **0.0036**
- n = 7.8489 × 0.4404 / 0.0036 = 960.18 → **n = 961 per group, 1,922 in total** (960 is acceptable if the tool floors/rounds differently).

**Feasibility:** the window gives ≈ 1,720 eligible users (≈ 860 per group), about **100 per group (≈ 10 %) short**. With 860 per group the power for +6 points is only ≈ **0.75–0.76**, or equivalently the minimum detectable effect at 80 % power is ≈ **+6.4 points**. Study B says real effects are often smaller than 6 points, so the risk is real. Acceptable responses (any, stated as an option, not as a silent change): accept ~75 % power and say so in the pre-registration; raise the MDE; extend the window (blocked by the 1 March price change); add web users (undecided, needs a web checklist); use an unequal split (does not help total n). Not acceptable: buying a panel or offering incentives (R8), including unverified-age accounts (R1), changing the primary metric later (R5).

## Planted test hooks

1. **Policy rules the design must respect:** no under-18s / unverified birth year excluded before assignment (R1); opt-in only (R2); raw data deleted **90 days** after study end (R3); stop at **+25 %** support contacts (R6); no incentives (R8).
2. **Baseline → sample size:** 30 % baseline is only in the CSV; the design must state ≈ **961 per group (1,922 total)**, ideally via the DA's `sample_size` tool span.
3. **Recruitment limit:** ~1,720 eligible in the 4-week window < 1,922 needed → must become a **risk** (Sample/Analysis/Risks) or an **open question**.
4. **File-only fact:** the day 7–13 "meaningful action" definition (RET-W1-v2) must drive Measurements.
5. **Ambiguity no file answers → Open questions:** include web signups / build a web checklist? (files say nobody decided).

## Section-by-section rubric

| Section | A good answer must contain | Provenance (from) |
|---|---|---|
| Hypothesis | H1: new mobile users who see the checklist have higher week-1 retention than control; H0: no difference. Direction stated | task, prior-studies.pdf |
| Variables | IV: onboarding (checklist vs current empty dashboard). DV: week-1 retention (RET-W1-v2). Controls: platform, signup week, same app version, one onboarding experiment at a time | prior-studies.pdf, ethics-policy.docx (R9) |
| Method | Randomised between-subjects A/B, 50/50 at signup by hash of pseudonymous id; enrolment 18 Jan – 14 Feb 2027, follow-up to day 13 (before 28 Feb); procedure steps; RRB pre-registration 14 Jan | recruitment-panel.txt, ethics-policy.docx |
| Sample and controls | Eligible: iOS/Android new signups, adult-verified, opt-in, not in another onboarding test; control = current onboarding (R7); **n = 961/group** with justification; expected supply ≈ 860/group and what that means | CSV, recruitment-panel.txt, policy |
| Measurements | Primary: RET-W1-v2 (action on day 7–13; app opens don't count), unit = user, source = event logs. Secondary: checklist completion, bank connection in first session. Exploratory: week-4 retention (day 28–34). Guardrail: support contacts per 1,000. Only event counts, no amounts (R4) | prior-studies.pdf, policy |
| Analysis plan | Two-proportion z-test (or χ²), two-sided, α = 0.05, power 0.8; intent-to-treat on assigned users; opt-outs removed from that point (R2); multiple comparisons: one primary, secondaries labelled exploratory or corrected (e.g. Holm); decision rule (ship if significant lift ≥ … ; otherwise …); what happens if underpowered | task, policy |
| Risks and ethics | Opt-in + exact notice; under-18 exclusion before assignment; pseudonymous ids, no financial contents; **deletion 90 days after study end** with a date; aggregates 3 years; stop conditions (25 % support contacts, incident, complaint); no incentives; novelty effect; **recruitment shortfall** | ethics-policy.docx, recruitment-panel.txt, prior-studies.pdf |
| Open questions | Web signups in or out (must). Others welcome: accept 75 % power or change MDE?, who signs off the trade-off | recruitment-panel.txt |

## Hallucinations to flag

- A baseline other than ~30 % (e.g. "industry average 25 %") or a sample size far from 961 without stated different inputs.
- Invented retention periods (30/180/365 days, "1 year" for raw data), invented consent wording that contradicts R2.
- Incentives, gift cards, paid panels, or recruiting under-18s / unverified accounts.
- Invented people's names, invented prior studies or citations, invented dates for the RRB.
- A web arm treated as decided.

## Score sheet

Mechanical checks (`node test-cases/score.mjs test-cases/02-research-onboarding`) use the same ids.

| Id | Level | Check | Pass/Fail |
|---|---|---|---|
| H1 | must | Directional hypothesis on checklist → week-1 retention | |
| H2 | must | Null hypothesis stated | |
| V1 | must | Independent and dependent variables | |
| M1 | must | Randomised A/B | |
| M2 | should | Enrolment window 18 Jan – 14 Feb / 4 weeks | |
| N1 | must | Baseline 30 % | |
| N2 | must | Sample size 961 per group / 1,922 total | |
| N3 | should | DA used the sample-size tool (tool span) | |
| N4 | must | Recruitment shortfall surfaced | |
| S1 | must | Under-18 / unverified birth year excluded | |
| S2 | must | Opt-in users only | |
| S3 | should | Mobile only | |
| ME1 | must | Day 7–13 meaningful-action definition | |
| ME2 | should | Secondary metrics (completion / bank) | |
| A1 | must | α 0.05 and power 0.8 | |
| A2 | should | Two-proportion test named | |
| A3 | manual | Decision rule and multiple-comparison handling stated | |
| E1 | must | 90-day deletion | |
| E2 | must | 25 % support-contact stop condition | |
| E3 | should | No financial contents | |
| E4 | should | RRB pre-registration | |
| Q1 | must | Open question about web signups | |
| F1 | should | Every file read (Read spans) | |
| X1 | must | No incentives / paid panel / money | |
| X2 | should | No invented retention period | |
| X3 | should | No invented person names (heuristic) | |
| X4 | manual | Numbers all traceable to files or the computation above | |
| P1 | manual | Each section's sources match the provenance column | |

Pass bar: all **must** checks pass, ≥ 70 % of **should**, no manual hallucination finding.
