import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import { buildMemoJournal, type BuildMemoJournalInput } from "./build-memo-journal.ts";

// Golden-master tests for the GL journal a credit/debit memo posts. A memo is a
// two-line entry: the AR/AP control leg and a reason leg. Direction alone decides
// the control side (Debit memo → DR control, Credit memo → CR control) for BOTH
// AR and AP. The reason leg is the inverse side, booked at the reason account's
// natural class. Every combo must balance (signedDebitTotal ~ 0).

const base = (
  overrides: Partial<BuildMemoJournalInput>
): BuildMemoJournalInput => ({
  memoId: "memo_1",
  companyId: "co_1",
  isAR: true,
  direction: "Credit",
  amountBase: 300,
  journalLineReference: "ref_1",
  controlAccountId: "acct_ar",
  reasonAccountId: "acct_reason",
  reasonAccountClass: "Revenue",
  ...overrides,
});

// Helpers: stored `amount` is natural-balance signed. For an asset, a debit is
// +mag and a credit is −mag; for a liability/revenue it's the opposite.
const line = (r: ReturnType<typeof buildMemoJournal>, accountId: string) =>
  r.lines.find((l) => l.accountId === accountId)!;

Deno.test("customer Credit memo: CR AR (asset), DR reason; balances", () => {
  const r = buildMemoJournal(base({ isAR: true, direction: "Credit" }));
  assertEquals(r.lines.length, 2);
  // Control AR is an asset; a credit stores −magnitude.
  assertEquals(line(r, "acct_ar").amount, -300);
  // Reason is Revenue; a debit stores −magnitude.
  assertEquals(line(r, "acct_reason").amount, -300);
  assert(Math.abs(r.signedDebitTotal) < 0.01);
});

Deno.test("customer Debit memo: DR AR (asset), CR reason; balances", () => {
  const r = buildMemoJournal(base({ isAR: true, direction: "Debit" }));
  // Control AR debit stores +magnitude.
  assertEquals(line(r, "acct_ar").amount, 300);
  // Reason Revenue credit stores +magnitude.
  assertEquals(line(r, "acct_reason").amount, 300);
  assert(Math.abs(r.signedDebitTotal) < 0.01);
});

Deno.test("supplier Credit memo: CR AP (liability), DR reason; balances", () => {
  const r = buildMemoJournal(
    base({ isAR: false, direction: "Credit", reasonAccountClass: "Expense" })
  );
  // Control AP is a liability; a credit stores +magnitude.
  assertEquals(line(r, "acct_ar").amount, 300);
  // Reason Expense debit stores +magnitude.
  assertEquals(line(r, "acct_reason").amount, 300);
  assert(Math.abs(r.signedDebitTotal) < 0.01);
});

Deno.test("supplier Debit memo: DR AP (liability), CR reason; balances", () => {
  const r = buildMemoJournal(
    base({ isAR: false, direction: "Debit", reasonAccountClass: "Expense" })
  );
  // Control AP debit (liability) stores −magnitude.
  assertEquals(line(r, "acct_ar").amount, -300);
  // Reason Expense credit stores −magnitude.
  assertEquals(line(r, "acct_reason").amount, -300);
  assert(Math.abs(r.signedDebitTotal) < 0.01);
});

Deno.test("rounds to internal scale and stays balanced on fractional amounts", () => {
  const r = buildMemoJournal(base({ amountBase: 123.456789 }));
  // SCALE = 5: GL lines carry internal precision, not the old 4dp column clamp.
  assertEquals(line(r, "acct_ar").amount, -123.45679);
  assert(Math.abs(r.signedDebitTotal) < 0.01);
});

Deno.test("rejects a zero amount", () => {
  assertThrows(() => buildMemoJournal(base({ amountBase: 0 })), Error, "greater than 0");
});

Deno.test("rejects an unknown reason account class", () => {
  assertThrows(
    () => buildMemoJournal(base({ reasonAccountClass: "Bogus" })),
    Error,
    "Unknown GL account class"
  );
});

// ---------------------------------------------------------------------------
// Tax split (Task 19). A memo amount is tax-INCLUSIVE: the control leg keeps
// the GROSS, the tax is carved out onto its own leg(s), and the reason leg
// takes only the NET. All three legs still sum to zero.
// ---------------------------------------------------------------------------

Deno.test("memo with tax: control gross, reason net, tax carved out; balances", () => {
  const r = buildMemoJournal(
    base({
      isAR: true,
      direction: "Credit",
      amountBase: 1082.5,
      taxLegs: [
        {
          componentName: "TX State",
          taxAmountBase: 62.5,
          accountId: "acct_tax",
          accountClass: "Liability",
        },
      ],
    })
  );
  assertEquals(r.lines.length, 3);
  // AR (asset) credited the GROSS.
  assertEquals(line(r, "acct_ar").amount, -1082.5);
  // Reason (revenue) debited the NET only.
  assertEquals(line(r, "acct_reason").amount, -1020);
  // Tax leg sits on the reason side: a DEBIT to a Liability stores −magnitude,
  // which is what reduces the tax the credit memo hands back.
  assertEquals(line(r, "acct_tax").amount, -62.5);
  assert(Math.abs(r.signedDebitTotal) < 0.0001);
});

Deno.test("memo tax legs are signed from the account's REAL class", () => {
  // Same leg against an Asset-class tax account: a debit stores +magnitude.
  const r = buildMemoJournal(
    base({
      isAR: false,
      direction: "Credit",
      amountBase: 120,
      reasonAccountClass: "Expense",
      controlAccountId: "acct_ap",
      taxLegs: [
        {
          componentName: "VAT",
          taxAmountBase: 20,
          accountId: "acct_input_tax",
          accountClass: "Asset",
        },
      ],
    })
  );
  assertEquals(line(r, "acct_input_tax").amount, 20);
  assert(Math.abs(r.signedDebitTotal) < 0.0001);
});

Deno.test("multi-component memo tax splits into one leg each", () => {
  const r = buildMemoJournal(
    base({
      amountBase: 1082.5,
      taxLegs: [
        { componentName: "TX State", taxAmountBase: 62.5, accountId: "a1", accountClass: "Liability" },
        { componentName: "Austin City", taxAmountBase: 20, accountId: "a2", accountClass: "Liability" },
      ],
    })
  );
  assertEquals(r.lines.length, 4);
  assertEquals(line(r, "acct_reason").amount, -1000);
  assert(Math.abs(r.signedDebitTotal) < 0.0001);
});

Deno.test("memo tax exceeding the amount refuses to post", () => {
  assertThrows(
    () =>
      buildMemoJournal(
        base({
          amountBase: 100,
          taxLegs: [
            { componentName: "VAT", taxAmountBase: 150, accountId: "a1", accountClass: "Liability" },
          ],
        })
      ),
    Error,
    "exceeds the memo amount"
  );
});

Deno.test("no tax legs posts the same two lines as before the feature", () => {
  const withEmpty = buildMemoJournal(base({ taxLegs: [] }));
  const without = buildMemoJournal(base({}));
  assertEquals(withEmpty.lines.length, 2);
  assertEquals(JSON.stringify(withEmpty.lines), JSON.stringify(without.lines));
});
