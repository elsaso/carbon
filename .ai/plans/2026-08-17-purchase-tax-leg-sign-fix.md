# Fix: purchase-side tax legs are signed against a hardcoded account class

Status: IMPLEMENTED 2026-08-17 — all 6 tasks landed; 69/69 E2E, 201/201 deno, 69/69 conformance
Branch: `feat/tax-phase1-c-posting`
Found by: the local E2E posting suite (`.ai/scratch/tax-e2e/`, gitignored) — 3 of 69
checks fail, all from this one defect.

## The defect

`packages/database/supabase/functions/post-purchase-invoice/index.ts:2059`

```ts
amount: debit("asset", componentTaxInJournalCurrency),
```

The comment above it says "DR input tax (an asset — we reclaim it from the
authority)", but the account the line actually posts to is

```ts
component.purchaseTaxAccountId ?? accountDefaults.data.purchaseTaxPayableAccount
```

which by default is account **2220 "Purchase Tax Payable" — class `Liability`**
(verified in the seeded chart, alongside 2210 and 2230, all `Liability`).

`debit`/`credit` (`functions/lib/utils.ts:128,142`) are pure sign-convention
mappers over the STORED amount: on `asset`/`expense` a debit is `+amount`, on
`liability`/`equity`/`revenue` a debit is `-amount`. So `debit("asset", 20)`
returns `+20`, and `+20` on a Liability account **is a credit**. The intended
debit is written as a credit and the journal is out by 2x the tax.

Observed (real posting, $100 line + 20% recoverable VAT, local stack):

| Account | Class | Stored | Debit-positive |
|---|---|---|---|
| 1210 Raw Materials | Asset | 100 | +100 |
| 2010 Accounts Payable | Liability | 120 | -120 |
| 2220 Purchase Tax Payable | Liability | 20 | -20 |
| | | | **-40** |

Correct is `Dr Raw Materials 100 / Dr input tax 20 / Cr AP 120 = 0`.

**Blast radius:** every purchase invoice carrying a component with
`isRecoverable = true` (treatment `Recoverable`), and every `Reverse Charge`
invoice — the reverse-charge pair is one debit + one credit, and its debit is
this same leg, so the pair sums to -40 instead of netting to 0. Non-recoverable
is unaffected (tax capitalizes into cost, no separate leg) and balances at 0.

**Why it shipped:** neither posting function calls `assertBalanced`, so an
unbalanced journal is written silently. The purchase path was also never
executed against a database before now (stated in the PR body).

## Root cause, stated once

The account a tax leg posts to is **configuration** (`component.purchaseTaxAccountId`,
`component.salesTaxAccountId`, or an `accountDefault`), so its class is not
knowable at authoring time. Every call site nonetheless passes a **literal**
class to `debit`/`credit`. Today that literal happens to be right on the sales
side and wrong on the purchase side; tomorrow a customer repoints a component
account and the sales side breaks the same way.

The fix is to derive the sign from the account's real `class`.

## Task 1 — map an account class to the sign convention

**File:** `packages/database/supabase/functions/lib/utils.ts`

Add next to `credit`/`debit` (which already own the `AccountType` union):

```ts
/** `account.class` is Title-case in the DB; debit/credit take the lowercase
 *  type. The class of a tax account is CONFIGURATION, so a literal here is a
 *  bug — see the journal-balance regression on purchase tax legs. */
export const accountTypeFromClass = (accountClass: string): AccountType => {
  const type = accountClass.toLowerCase();
  if (
    type === "asset" || type === "liability" || type === "equity" ||
    type === "revenue" || type === "expense"
  ) return type;
  throw new Error(`Invalid account class: ${accountClass}`);
};
```

DB values confirmed: `Asset | Liability | Equity | Revenue | Expense`.

**Verify:** `grep -n "accountTypeFromClass" packages/database/supabase/functions/lib/utils.ts`

## Task 2 — fetch the classes of the accounts the tax legs use

**File:** `packages/database/supabase/functions/post-purchase-invoice/index.ts`

Before the line loop that builds tax legs (the `accountDefaults` fetch region),
collect the distinct account ids that tax legs can target — every
`component.purchaseTaxAccountId` on the resolved plans, plus
`purchaseTaxPayableAccount` and `reverseChargeSalesTaxPayableAccount` — and
resolve them in **one** query:

```ts
const taxAccountClasses = new Map<string, string>();
const taxAccountIds = [...new Set([...])].filter(Boolean);
if (taxAccountIds.length > 0) {
  const accounts = await client
    .from("account")
    .select("id, class")
    .in("id", taxAccountIds)
    .eq("companyId", companyId);
  if (accounts.error) throw new Error("Failed to fetch tax account classes");
  for (const a of accounts.data ?? []) taxAccountClasses.set(a.id, a.class!);
}
```

One `.in()` call, never a lookup inside the component loop
(`.claude/rules/database-patterns.md` — no N+1). Precedent for the shape: the
`G/L Account` line type already does `client.from("account").select(...)` at
`post-purchase-invoice/index.ts:1946`.

**Verify:** `pnpm exec biome check packages/database/supabase/functions/post-purchase-invoice/`

## Task 3 — sign both purchase tax legs from the real class

**File:** `packages/database/supabase/functions/post-purchase-invoice/index.ts`

- **line 2059** (input tax, the bug):
  ```ts
  amount: debit(accountTypeFromClass(classOf(inputTaxAccountId)), componentTaxInJournalCurrency),
  ```
- **line 2079** (reverse-charge liability): same treatment with `credit(...)`.
  Currently correct by luck (2230 is a Liability); make it symmetric so the two
  legs cannot drift apart.

Throw a clear error if an id is missing from the map — a tax account that cannot
be classified must stop the posting, not guess. Keep the existing
"Missing ... account default" throws.

**Verify (this is the real one):**
```bash
node .ai/scratch/tax-e2e/run.mjs
```
Expected: `69/69 checks passed`, and specifically
`purchase/recoverable input tax (20% VAT) :: journal balances -> 0`,
`purchase/reverse charge self-assessment :: paired legs net to zero -> 0`.

## Task 4 — close the same hole on the sales side

**File:** `packages/database/supabase/functions/post-sales-invoice/index.ts:511,521`

`posting.salesTaxAccountId ?? salesTaxPayableAccount` is signed with a literal
`credit("liability", ...)`. With the seeded default (2210, Liability) this is
correct today — the E2E suite proves the sales journals balance — but the
per-component override makes it the same latent bug. Apply Tasks 2-3 here.

Also at `post-sales-invoice/index.ts:1309`: `debit("asset", shippingTax.totalTaxBase)`
posts to `receivablesAccountId`. That one is genuinely an Asset (AR) and is
**correct** — leave it. Do not "fix" it.

**Verify:** `node .ai/scratch/tax-e2e/run.mjs` still `69/69` (no sales regression).

## Task 5 — refuse to write an unbalanced journal (the systemic guard)

**Files:** `post-purchase-invoice/index.ts:2255` and `post-sales-invoice/index.ts:1561`
— the `journalLineInserts.length > 0` choke points, immediately before
`.insertInto("journalLine")` (2284 / 1563 respectively).

Convert every pending line to debit-positive using its account class (one batched
`.in()` over the distinct `accountId`s of `journalLineInserts`) and call
`assertBalanced(debits, credits, tolerance, label)` from
`../shared/precision.ts`, e.g. label `"Purchase invoice journal"`.

Tolerance: propose `0.01`, matching what payment/memo posting passes
(`.claude/rules/numeric-precision.md`); manual journals and period close use
`0.001`. **Confirm this choice before implementing** — it is a business refusal
threshold, not a float guard.

**Risk, stated plainly:** this converts any *existing* silent imbalance anywhere
in these two functions into a hard posting failure. That is the correct behavior
("the only correct response is to refuse"), but it is a behavior change wider
than this bug. Mitigation: land Tasks 1-4 first, confirm `69/69`, then add the
guard and re-run — if the suite stays green, no covered path trips it. Fixed-asset
disposal and intercompany branches are **not** covered by the suite; review them
by reading before enabling the throw.

This task is separable. If you want the bug fixed with minimum blast radius,
ship Tasks 1-4 and take Task 5 as a follow-up.

## Task 6 — committed regression coverage

The E2E suite is deliberately uncommitted, so the branch needs its own guard.

**File:** `packages/database/supabase/functions/lib/utils.test.ts` (or the
existing Deno test beside it)

Unit-test `accountTypeFromClass` for all five classes + an invalid input, and
assert the composition that actually failed:

```ts
// a debit of 20 to a Liability-class tax account stores as -20, not +20
assertEquals(debit(accountTypeFromClass("Liability"), 20), -20);
assertEquals(debit(accountTypeFromClass("Asset"), 20), 20);
```

**Verify:** `deno test packages/database/supabase/functions/lib/` — note **deno is
not installed in this environment**, so this cannot be run here; it runs in CI.
The `node .ai/scratch/tax-e2e/run.mjs` suite is the executable proof locally.

## Full verification sequence

```bash
node .ai/scratch/tax-e2e/run.mjs                      # 69/69
pnpm --filter @carbon/checks test                     # 69/69 conformance
pnpm exec turbo run typecheck --filter=erp            # clean
pnpm exec biome check packages/database/supabase/functions/
```

Re-run the E2E suite once more after Task 5 to prove the guard does not trip on
any covered path.

## Explicitly out of scope

- Changing which account recoverable input tax lands on. Debiting 2220 is what
  the tax spec's plan specifies (`Dr component.purchaseTaxAccountId ??
  purchaseTaxPayableAccount`). Whether recoverable VAT deserves its own
  Asset-class "VAT recoverable" account is a chart-of-accounts question for the
  user, not a bug fix.
- The shipping-tax subledger shape (implementation folds shipping into the
  line's taxable base; the plan text describes a separate document-level row).
  GL and subledger agree, so this is a plan/impl divergence to reconcile in
  docs, not a defect.
- `post-memo`, the PDF tax block, and the liability report — still unbuilt
  Phase 1 work, tracked against upstream #1036.

## Implementation record (2026-08-17)

All six tasks landed. Verified: `node .ai/scratch/tax-e2e/run.mjs` **69/69** (was
66/69), `deno test --no-lock --no-check` **201/201**, `pnpm --filter @carbon/checks
test` **69/69**, `typecheck` clean for `@carbon/database` and `erp`, biome clean
(7 pre-existing `console` warnings only).

**The guard was proved to fire, not just to pass.** With Task 3's sign fix
temporarily reverted, the suite dropped to 61/69 and the edge runtime logged
`Purchase invoice journal does not balance (off by -40); refusing to post` — the
exact 2x-tax drift this plan predicted. Restored, back to 69/69.

### Three deviations from the plan as written

1. **`account` has no `companyId` column.** Task 2's proposed
   `.eq("companyId", companyId)` is a runtime error — the chart of accounts is
   scoped by `companyGroupId` (shared across a company group). Accounts are now
   looked up BY ID with no tenant filter, which is what the existing
   `G/L Account` line-type fetch already does, and is safe because every id
   handed in was read from a row already scoped to the company (`accountDefault`,
   `taxCodeComponent`). See `.ai/lessons.md`.

2. **Task 6's tests do NOT run in CI.** `packages/database` has no `test` script,
   so `turbo run test` never reaches the ~16 Deno test files under
   `supabase/functions/`; no workflow references deno either. The tests are real
   coverage, run by `deno task test`, but they are not an automated gate. Wiring
   them into CI would make all 16 files run for the first time — a separate
   decision, deliberately not taken here.

3. **The sign convention moved to `lib/account-sign.ts`** (re-exported from
   `lib/utils.ts`, so all 16 importers are untouched). Required, not cosmetic:
   `lib/utils.ts` type-imports the dual-runtime `lib/postgres/index.ts`, which
   carries 8 pre-existing type errors under Deno's checker — verified identical
   on a clean stashed tree — so anything importing `utils.ts` cannot be
   type-checked. This is why no test imported it before.

### Files

- `lib/account-sign.ts` (new) — `AccountType`, `credit`, `debit`,
  `accountTypeFromClass`, `toDebitPositive`; `lib/utils.ts` re-exports all five.
- `shared/journal-balance.ts` (new) — `getAccountTypes` (one `.in()`),
  `requireAccountType` (refuses an unclassifiable account), `assertJournalBalances`,
  `JOURNAL_BALANCE_TOLERANCE = 0.01` (confirmed: FX residuals are real, and both
  posting paths multiply every leg by an exchange rate).
- `lib/account-sign.test.ts`, `shared/journal-balance.test.ts` (new) — 9 tests.
- `post-purchase-invoice/index.ts` — tax account classes batched before the line
  loop; both tax legs signed from the real class; balance guard at the choke point.
- `post-sales-invoice/index.ts` — same treatment.

### Still out of scope, unchanged

Everything in the section above, plus: the 8 pre-existing Deno type errors, and
wiring `deno task test` into CI.

## Full test pass before commit (2026-08-17)

| Gate | Result |
|---|---|
| `node .ai/scratch/tax-e2e/run.mjs` | 69/69 |
| `node .ai/scratch/tax-e2e/run-guard.mjs` (new) | 44/44 |
| `deno test --no-lock --no-check` | 201/201 |
| `deno test --no-lock` on the two new files | 9/9, type-checked |
| `pnpm run test` | 23/23 tasks |
| `pnpm run lint` | 33/33 tasks (pre-existing warnings only) |
| `pnpm run build` | exit 0 |
| `typecheck` — `@carbon/database`, `erp` | clean |

### The guard's blast radius was measured, not assumed

Task 5 runs on EVERY sales and purchase posting, so `run-guard.mjs` was written
to cover the branches `run.mjs` never posted — the ones the plan flagged as
unreviewed. All 44 checks pass, i.e. the guard refuses nothing that posts
correctly today:

- **Foreign currency** — EUR @1.0852, JPY @0.0067, GBP @1.2734. This is what the
  `0.01` tolerance exists for; no cross-rate residue came close to it.
- **Fixed assets** — purchase capitalization (with tax, and under FX) and sales
  disposal (with tax, and a void round trip). Flagged in the plan; now covered.
- **Intercompany** — both sides, asserting the journal uses IC Payables (2020)
  and IC Receivables (1130) rather than plain AP/AR. Flagged in the plan; now
  covered.
- **Line types** the tax suite never posted — Service, G/L Account (purchase
  only; the sales side has no such type), Material/Consumable/Tool/Fixture,
  Comment-only (posts no journal at all), and mixed multi-line documents.

### The void paths are deliberately NOT guarded

Each posting function has TWO `insertInto("journalLine")` sites; only the posting
one is guarded. A void is a pure sign flip of lines already in the ledger
(`amount: -entry.amount`), so it balances exactly when the original did. Guarding
it could only ever fire on a journal posted BEFORE this fix — and would then trap
the user, refusing the very void that clears the bad entry. A comment at both
sites records this so it does not get "fixed" later.

### Residual risk, stated plainly

`account.class` is nullable, and `requireAccountType` refuses an account whose
class it cannot read. In this seed all 100 accounts are fine — the only two with
a null class are `isGroup = true` headers, which posting already rejects — but a
customer with a postable, unclassified account will now get a hard refusal where
posting previously produced a silently mis-signed leg. That is the intended
trade, and it is the one behavior change worth watching after deploy.
