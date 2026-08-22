// Pure construction of the GL journal for posting a credit/debit memo. No DB, no
// I/O, no clock — so it is unit-testable with `deno test`. The driver
// (`index.ts`) resolves the control + reason account ids, the reason account's
// class, the accounting period and `journalLineReference` (all impure), then
// hands them here to compute the balanced two-line double-entry.
//
// A memo is payment-shaped, NOT invoice-shaped: it moves an amount between the
// party's AR/AP control account and a single chosen reason account. There are
// four combos (customer/supplier × credit/debit); two axes drive the posting:
//   * isAR      — customer (AR, asset control) vs supplier (AP, liability control)
//   * direction — 'Credit' or 'Debit'. This alone decides the control side:
//                 a Debit memo DEBITS the control account, a Credit memo CREDITS
//                 it — for BOTH AR and AP. Worked through:
//                   Customer Credit  → reduce AR  → CR asset   (control credit)
//                   Customer Debit   → increase AR→ DR asset   (control debit)
//                   Supplier Credit  → increase AP→ CR liab.   (control credit)
//                   Supplier Debit   → reduce AP  → DR liab.   (control debit)
//                 i.e. controlIsDebit === (direction === 'Debit') universally.
// The reason leg is always the inverse side, booked at the reason account's
// natural class so its stored natural-balance `amount` sign is correct.
//
// A memo is a single-currency document booked at its own exchange rate, so there
// is no realized FX at post time (FX only realizes when CASH later settles the
// memo — a separate payment posting). Both legs use the same base amount, so the
// entry balances exactly.

import { assertBalanced, round } from "../shared/precision.ts";
import type { AccountType } from "../lib/account-sign.ts";
import { accountTypeFromClass, credit, debit } from "../lib/account-sign.ts";

// Re-exported for the existing unit tests, which imported it from here before
// the convention moved to its own shared module.
export { accountTypeFromClass };

// A journal line this builder emits. Self-contained — a pure unit shouldn't
// depend on the generated DB types, and `journalLine.documentType`'s "Memo" enum
// value (migration 20260628143012) isn't in the generated lib/types.ts until the
// DB is rebuilt. The driver spreads `journalId` on before the Kysely insert.
export interface MemoJournalLine {
  accountId: string;
  description: string;
  amount: number;
  quantity: number;
  documentType: "Memo";
  documentId: string;
  journalLineReference: string;
  companyId: string;
}

export interface BuildMemoJournalInput {
  // Internal memo record id — becomes `documentId` on every line.
  memoId: string;
  companyId: string;
  // customer (AR) vs supplier (AP). Drives control account TYPE (asset/liability).
  isAR: boolean;
  direction: "Credit" | "Debit";
  // memo.amount × memo.exchangeRate (base currency).
  amountBase: number;
  // Resolved once by the driver (nanoid) so this stays pure.
  journalLineReference: string;
  // receivables (AR) / payables (AP) control account.
  controlAccountId: string;
  // the memo's chosen reason account + its glAccountClass.
  reasonAccountId: string;
  reasonAccountClass: string;
  /** Per-component tax carved OUT of `amountBase` (memo amounts are
   *  tax-INCLUSIVE: the party is credited/debited the gross, and the reason
   *  account takes only the net). Empty/omitted on a memo with no tax code, in
   *  which case this builder emits exactly the two lines it always has. */
  taxLegs?: MemoTaxLeg[];
}

export interface MemoTaxLeg {
  componentName: string;
  /** Positive magnitude in base currency; the side is derived, not passed. */
  taxAmountBase: number;
  /** The component's own account, else the party-side tax payable default. */
  accountId: string;
  /** The REAL class of `accountId` — never a literal at the call site, or an
   *  intended debit stored on another class silently becomes a credit. */
  accountClass: string;
}

export interface BuildMemoJournalResult {
  lines: MemoJournalLine[];
  // Running debit(+)/credit(−) balance; ~0 for a balanced entry.
  signedDebitTotal: number;
}

// Maximum residual (base ccy) we tolerate before refusing to post.
const BALANCE_TOLERANCE = 0.01;

export function buildMemoJournal(
  input: BuildMemoJournalInput
): BuildMemoJournalResult {
  const {
    memoId,
    companyId,
    isAR,
    direction,
    amountBase,
    journalLineReference,
    controlAccountId,
    reasonAccountId,
    reasonAccountClass,
    taxLegs = [],
  } = input;

  if (!controlAccountId) {
    throw new Error(
      `Missing ${isAR ? "receivables" : "payables"} account default; cannot post memo to GL`
    );
  }

  const magnitude = round(Math.abs(amountBase));
  if (magnitude < 0.0001) {
    throw new Error("Memo amount must be greater than 0 to post");
  }

  const lines: MemoJournalLine[] = [];
  let signedDebitTotal = 0;

  const pushLine = (
    side: "debit" | "credit",
    accountType: AccountType,
    accountId: string,
    description: string,
    lineAmount: number = magnitude
  ) => {
    signedDebitTotal += side === "debit" ? lineAmount : -lineAmount;
    lines.push({
      accountId,
      description,
      amount:
        side === "debit"
          ? debit(accountType, lineAmount)
          : credit(accountType, lineAmount),
      quantity: 1,
      documentType: "Memo",
      documentId: memoId,
      journalLineReference,
      companyId,
    });
  };

  // Control side is decided by direction alone (see header note).
  const controlIsDebit = direction === "Debit";
  const controlType: AccountType = isAR ? "asset" : "liability";
  const reasonType = accountTypeFromClass(reasonAccountClass);

  // 1) Control leg (AR/AP).
  pushLine(
    controlIsDebit ? "debit" : "credit",
    controlType,
    controlAccountId,
    isAR ? "Accounts Receivable" : "Accounts Payable"
  );

  // 2) Tax legs — the tax is carved OUT of the gross, so each sits on the same
  // side as the reason leg (the inverse of the control side) and the three
  // legs still sum to zero: control gross = reason net + tax.
  const taxSide: "debit" | "credit" = controlIsDebit ? "credit" : "debit";
  let taxTotal = 0;
  for (const leg of taxLegs) {
    const legAmount = round(Math.abs(leg.taxAmountBase));
    if (legAmount < 0.0001) continue;
    taxTotal = round(taxTotal + legAmount);
    pushLine(
      taxSide,
      accountTypeFromClass(leg.accountClass),
      leg.accountId,
      `${direction === "Credit" ? "Credit" : "Debit"} memo tax — ${leg.componentName}`,
      legAmount
    );
  }

  if (taxTotal > magnitude) {
    throw new Error(
      `Memo tax (${taxTotal}) exceeds the memo amount (${magnitude}); refusing to post`
    );
  }

  // 3) Reason leg — the inverse side at the NET amount.
  pushLine(
    taxSide,
    reasonType,
    reasonAccountId,
    direction === "Credit" ? "Credit memo" : "Debit memo",
    round(magnitude - taxTotal)
  );

  // BALANCE_TOLERANCE is a business threshold (multi-currency memos carry
  // sub-cent cross-rate residuals), NOT the float-noise default.
  assertBalanced(
    signedDebitTotal,
    0,
    BALANCE_TOLERANCE,
    "Memo journal (base currency)"
  );

  return { lines, signedDebitTotal };
}
