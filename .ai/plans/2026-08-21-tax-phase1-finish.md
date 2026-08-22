# Multi-Jurisdiction Tax Phase 1 — finishing plan

**Parent plan:** `.ai/plans/2026-07-03-multi-jurisdiction-tax.md` (Tasks 1–23)
**Spec:** `.ai/specs/2026-07-03-multi-jurisdiction-tax.md` (upstream crbnos/carbon#1036)
**Date:** 2026-08-21

All 21 code tasks are implemented. What remains is Task 22 (translations),
Task 23 (browser verification), and the release mechanics the parent plan never
covered because it assumed a single branch. This plan closes those out.

## Two facts the parent plan does not account for

**1. The branch stack forked into two legs, and neither leg contains Phase 1.**

```
fork/main (elsaso/carbon)
 └─ a1-backend .......... PR #1 → main         schema, types, services
     ├─ a2-ui ........... PR #2 → a1           config screens, party assignment
     │   └─ d-liability .. no PR               Task 21 liability report
     └─ c-posting ....... PR #3 → a1           the revenue misstatement fix
         └─ e-memo-tax ... no PR               Task 19 memo tax
             └─ f-line-tax  no PR              Task 15 line UI + recalculate
                 └─ g-invoice-pdf  no PR       Task 20 PDF tax block  [current HEAD]
```

`d-liability` has the tax **configuration UI and the liability report** but no
corrected posting. `g-invoice-pdf` has **posting, memo tax, line UI and the PDF**
but no tax config screens and no liability report. Task 23's scenario walks
config → assignment → order → post → journal → **liability report** → memo, so it
**cannot be executed on any existing branch**. It needs an integration branch.

**2. The two legs' translation catalogs are disjoint, and `--clean` prunes.**

`lingui extract --clean` deletes msgids it cannot find in source, so extracting on
one leg strips the other leg's strings. Measured untranslated strings in `fr`
(every non-`en`, non-`nl` locale is identical):

| Branch | Untranslated (fr) | Total msgids |
|---|---|---|
| `fork/main` | **0** | 5682 |
| a1-backend | 0 | — |
| **a2-ui** | **66** | — |
| c-posting | 0 | — |
| **d-liability** | **77** | 5758 |
| e-memo-tax | 4 | — |
| f-line-tax / g-invoice-pdf | **6** | 5688 |

Upstream keeps catalogs at **zero** untranslated. Every tax branch that adds UI
currently regresses that, and PR #2 is open in that state today. Neither leg can
be translated to completion on its own: the g-leg catalog has no `"Tax Liability"`
entry to fill, and the d-leg catalog has no `"Recalculate Tax"`.

Good news, measured not assumed: a `git merge-tree` dry-run of the two legs
produces **3 conflicts** — `.ai/lessons.md`, this plan's parent, and the generated
`tool-metadata.json`. All 13 `erp.po` files **auto-merge cleanly**.

## Order of work

Tasks 1–3 are independent of each other. Task 4 needs 2 and 3. Tasks 5–7 need 4.
Task 8 needs 7. Task 9 is a standalone question for the user.

---

## Task 1: Correct the parent plan's progress record

**Depends on:** none
**Files:** Modify `.ai/plans/2026-07-03-multi-jurisdiction-tax.md`

The Progress section is stale and reads as if a third of Phase 1 is unbuilt.

**Steps:**
1. Mark Task 21 `[x]` — implemented in `1aa820ad7` on `feat/tax-phase1-d-liability`.
2. Rewrite the "Phase 1 is therefore **not complete**" paragraph. Memo tax, the
   invoice PDF block, the liability report, the line-level override and the
   recalculate action all exist; what is left is translations and runtime
   verification.
3. Replace the "three stacked branches" note with the seven-branch, two-leg
   diagram above.
4. Update the external blocker: crbnos/carbon#1298 is still **OPEN** as of
   2026-08-21, so the posting leg still must not merge upstream ahead of it.

**Verify:** `git diff --stat` shows only the plan file. No code touched.

**Out of scope:** rewriting the task bodies — only the Progress block is wrong.

---

## Task 2: Translate the d-leg catalogs (77 strings)

**Depends on:** none
**Branch:** `feat/tax-phase1-d-liability`
**Files:** Modify `packages/locale/locales/{de,es,fr,hi,it,ja,ko,pl,pt,ru,tr,zh}/erp.po`

77 strings × 12 target locales = **924 translations**. These are the tax
configuration UI (authorities, codes, components editor, registrations, party
assignment, suggestion hints) plus the liability report's column headers.

**Steps:**
1. `git checkout feat/tax-phase1-d-liability`
2. Invoke the `/translate` skill — it fans the chunks out to **Haiku** subagents
   and merges deterministically, so the main model never sits in the write path.
   Do **not** run `pnpm translate`; that routes every string through the main model.
3. `pnpm run lingui:clean` if the `.po` headers churn.
4. Commit on `d-liability` as `chore(i18n): translate the tax configuration and
   liability report strings`.

**Verify:**
```bash
node .claude/skills/translate/scripts/progress.mjs   # expect 0 missing
pnpm run lint && pnpm exec turbo run typecheck --filter=@carbon/locale --filter=@carbon/erp
```
Then re-count with the untranslated-msgstr scan: `fr` must report **0**.

**Note:** this leaves PR #2 (`a2-ui`) still showing 66 untranslated in isolation,
fixed one PR later by #4. That is acceptable for a stacked series that merges as a
unit and should be **stated in the PR body** rather than left for a reviewer to
find. If the user wants each PR self-contained instead, translate a2-ui's 66 on
`a2-ui` and rebase `d-liability` — one extra pass and one rebase.

**Out of scope:** `nl` (orphaned upstream, 2735 empty — the skill excludes it) and
`en` (source; its only empty `msgstr` is the catalog header).

---

## Task 3: Translate the c-leg catalogs (6 strings)

**Depends on:** none (parallel with Task 2)
**Branch:** `feat/tax-phase1-g-invoice-pdf`
**Files:** the same 12 `erp.po` catalogs

6 strings × 12 locales = **72 translations**: `"Tax Code"`, `"Recalculate Tax"`,
`"Tax Included"`, `"The memo amount includes this tax"`, `"Derived from the code;
edit to match the original document"`, `"Sets the expected rate; the supplier's tax
amount stays as invoiced"`.

**Steps:** as Task 2, on `g-invoice-pdf`. Small enough to land in one chunk.

**Verify:** same scan; `fr` reports **0**.

**Out of scope:** committing on `e-memo-tax`/`f-line-tax` separately. All six
strings are visible from the `g` tip and the leg merges as a unit; splitting them
buys three rebases and nothing else.

---

## Task 4: Build the integration branch

**Depends on:** Tasks 2, 3
**Files:** Create branch `feat/tax-phase1-integration`

The first tree that actually contains Phase 1, and the only one Task 23 can run on.

**Steps:**
1. `git checkout -b feat/tax-phase1-integration feat/tax-phase1-g-invoice-pdf`
2. `git merge feat/tax-phase1-d-liability`
3. Resolve the three known conflicts:
   - `.ai/lessons.md` — union both legs' entries, keep chronological order.
   - `.ai/plans/2026-07-03-multi-jurisdiction-tax.md` — take Task 1's corrected
     Progress block.
   - `apps/erp/app/routes/api+/mcp+/lib/tool-metadata.json` — **generated**; do not
     hand-merge. Take either side, then regenerate and commit the real output.
4. Confirm the 13 `erp.po` files auto-merged, then run `pnpm run lingui:extract`
   on the merged tree. Extract preserves non-empty `msgstr`, so the union should
   come back with **every** tax string present and translated. This is the real
   proof that Tasks 2 and 3 compose.

**Verify:**
```bash
pnpm run lingui:extract && node .claude/skills/translate/scripts/progress.mjs
# Expect: NOTHING_TO_TRANSLATE. A non-zero count here means one leg's translations
# were pruned by the other's --clean, and Task 2/3 need redoing post-merge instead.
pnpm exec turbo run typecheck --filter=@carbon/erp --filter=@carbon/documents --filter=@carbon/database
```

**Out of scope:** rebasing the legs into one linear stack. A merge keeps both PR
chains reviewable; a rebase would invalidate three pushed PR heads.

---

## Task 5: Task 23 — browser verification of the full cycle

**Depends on:** Task 4
**Files:** Create `.ai/playbooks/tax-phase1-liability-cycle.md`

**Prerequisites** (all currently down — every `carbon-*` container is `Exited`):
1. `crbn up`, wait for health.
2. **`podman restart carbon-carbon-edge-runtime-1`** after the branch switch — the
   edge runtime caches its module graph across switches and will otherwise serve
   the wrong `post-*` code (`.ai/lessons.md`).
3. Start the ERP dev server; enable accounting at `/x/settings/accounting`.
4. Hydration caveat: the dev server fails hydration and swallows the first click.
   Submit with **Enter**, and use the `clickUntil` pattern from `.ai/scratch/e2e-ui/tests/ui.ts`.

**Steps:** run the parent plan's Task 23 scenario via the `/test` skill —
(a) tax authority "Texas Comptroller"; (b) tax code "TX – Austin", State 6.25 +
City 2.0, match US/TX; (c) customer with a TX address, confirm the suggestion hint,
assign; (d) sales order line shows 8.25%; (e) invoice and post; (f) journal shows
revenue **net** + two Sales Tax credits + AR **gross**; (g) Tax Liability for today
shows two component rows with correct bases; (h) post a Credit memo, liability nets
down; (i) screenshot each step.

Cache the result as a playbook. Any blank page or "Something went wrong" → `/error`,
fix, restart the step.

**Verify:** playbook written; screenshots show 6.25/2.00 split on the order-line
base and a negative memo row on the report.

**Out of scope:** Phase 2/3 scenarios (returns, use tax, Avalara).

---

## Task 6: Automate the GL ↔ liability cross-tie

**Depends on:** Task 4
**Files:** Create `.ai/scratch/tax-e2e/liability-crosstie.mjs` (**local-only, never staged**)

The parent plan calls the GL cross-tie a *manual* check inside Task 23. A manual
check is not a gate — and we already have the pattern in `pdf-summary-check.mjs`,
which proved the PDF summary against the posted subledger for 23/23 invoices.

**Steps:**
1. For every posted document, aggregate `taxLedger` by `taxAuthorityId` +
   `componentName` exactly as `getTaxLiability` does.
2. Aggregate the tax-account `journalLine` rows over the same window, converting to
   debit-positive first (`journalLine.amount` is stored in natural-balance sign).
3. Assert per component: report `collected − input` equals the GL movement within
   `EPSILON`. Print every row, not just failures.

**Verify:** the script exits 0 and names the document count it tied out. A
mismatch is a real defect and blocks Task 8.

**Out of scope:** committing this. Same standing rule as `tax-e2e/` and `e2e-ui/` —
local verification only, never staged, never pushed.

---

## Task 7: Full gate on the integration branch

**Depends on:** Tasks 5, 6
**Files:** none

The last full battery ran on `g-invoice-pdf`, which is not Phase 1. Re-run on the
integration tree — this is the parent plan's Task 22 gate, discharged for real.

**Steps:**
```bash
pnpm run test && pnpm run lint && pnpm run build
pnpm exec turbo run typecheck --filter=@carbon/erp --filter=@carbon/mes \
  --filter=@carbon/database --filter=@carbon/documents --filter=@carbon/ee \
  --filter=@carbon/jobs --filter=@carbon/utils --filter=@carbon/checks \
  --filter=@carbon/form --filter=@carbon/react --filter=@carbon/workflows
pnpm --filter erp exec vitest run          # expect 667 pass / 5 pre-existing fail
node .ai/scratch/tax-e2e/run.mjs           # expect 77/77
node .ai/scratch/tax-e2e/pdf-summary-check.mjs
node .ai/scratch/tax-e2e/liability-crosstie.mjs
pnpm --filter @carbon/checks exec vitest run   # conformance, expect 69/69
cd .ai/scratch/e2e-ui && pnpm exec playwright test
```

**Verify:** every command exits 0 except the erp vitest, whose **5** failures must
be exactly the known pre-existing set (3 × `accounting.periods.test.ts` mock gaps,
2 i18n suites) — any sixth is ours and blocks.

**Out of scope:** fixing the 5 pre-existing failures (see Task 9).

---

## Task 8: PR housekeeping

**Depends on:** Task 7
**Files:** none (GitHub only, `elsaso/carbon`)

**Steps:**
1. **Rewrite the three stale bodies.** #1, #2 and #3 all say "Part 1/2/3 of 3" —
   there are seven branches. #1 additionally cites
   `.ai/plans/2026-08-16-multi-jurisdiction-tax-phase1.md`, **which does not exist**;
   the real path is `.ai/plans/2026-07-03-multi-jurisdiction-tax.md`. Add the
   two-leg diagram so a reviewer can see where each PR sits.
2. **Open the four missing PRs**, each based on its actual parent — not `main`:
   | PR | Head | Base |
   |---|---|---|
   | #4 | `feat/tax-phase1-d-liability` | `feat/tax-phase1-a2-ui` |
   | #5 | `feat/tax-phase1-e-memo-tax` | `feat/tax-phase1-c-posting` |
   | #6 | `feat/tax-phase1-f-line-tax` | `feat/tax-phase1-e-memo-tax` |
   | #7 | `feat/tax-phase1-g-invoice-pdf` | `feat/tax-phase1-f-line-tax` |
3. Open `feat/tax-phase1-integration` as a **draft** PR against `main`, labelled as
   the verification tree, carrying the Task 5 playbook and the Task 7 evidence.
4. Push every branch to **`fork` (elsaso/carbon)**. Never to `origin` (upstream).
5. Record in #3's body that it must not merge upstream before crbnos/carbon#1298
   (FX divide-to-base) — the posting leg still multiplies by `exchangeRate`.

**Verify:** `gh pr list --repo elsaso/carbon` shows 8 PRs with the bases above.

**Out of scope:** anything against `crbnos/carbon`. Upstream submission is a
separate decision.

---

## Task 9: Decide the `apps/erp` test script — needs the user

**Depends on:** none
**Files:** Modify `apps/erp/package.json` (only if the user says yes)

`apps/erp` has **no `test` script**, so its 672 tests never run in `pnpm run test`
and never gate CI. That is why the 5 failures have survived. Adding
`"test": "vitest run"` turns CI red on the next push unless the 5 are fixed first.

Three options, for the user to pick:
- **Fix then wire** — repair the 3 `accounting.periods` mock gaps (`maybeSingle` is
  not implemented on the mock) and the 2 i18n suites, then add the script. Correct,
  and out of scope for a tax PR.
- **Wire only** — add the script now and accept red CI until someone fixes them.
- **Leave it** — note it as a follow-up issue and move on.

This is pre-existing on `fork/main` and unrelated to tax. Recommend **leave it**
and file an issue, so Phase 1 does not absorb someone else's debt.

---

## Deliverables

- Zero untranslated strings on both legs and on the merge (Tasks 2–4)
- `feat/tax-phase1-integration` — the first tree containing all of Phase 1 (Task 4)
- `.ai/playbooks/tax-phase1-liability-cycle.md` — runtime proof (Task 5)
- An automated GL ↔ liability cross-tie (Task 6, local-only)
- A green full battery on a tree that is actually Phase 1 (Task 7)
- 8 PRs with accurate bodies and correct bases (Task 8)
