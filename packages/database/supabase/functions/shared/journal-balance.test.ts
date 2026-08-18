import {
  assertThrows,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import type { AccountType } from "../lib/account-sign.ts";
import { credit, debit } from "../lib/account-sign.ts";
import { assertJournalBalances } from "./journal-balance.ts";

// The seeded chart, as far as these legs are concerned: the purchase tax
// account a recoverable component posts to is a LIABILITY, which is the whole
// reason the sign cannot be assumed.
const RAW_MATERIALS = "acc_raw_materials";
const ACCOUNTS_PAYABLE = "acc_payable";
const PURCHASE_TAX_PAYABLE = "acc_purchase_tax_payable";

const accountTypes = new Map<string, AccountType>([
  [RAW_MATERIALS, "asset"],
  [ACCOUNTS_PAYABLE, "liability"],
  [PURCHASE_TAX_PAYABLE, "liability"],
]);

Deno.test("accepts a correctly signed $100 line + 20% recoverable VAT journal", () => {
  // Dr Raw Materials 100 / Dr input tax 20 / Cr AP 120.
  assertJournalBalances(
    [
      { accountId: RAW_MATERIALS, amount: debit("asset", 100) },
      { accountId: PURCHASE_TAX_PAYABLE, amount: debit("liability", 20) },
      { accountId: ACCOUNTS_PAYABLE, amount: credit("liability", 120) },
    ],
    accountTypes,
    "Purchase invoice journal"
  );
});

Deno.test("refuses the journal the hardcoded-class bug produced", () => {
  // The exact defect: the input-tax debit signed as if 2220 were an Asset. The
  // leg stores +20 on a Liability, which IS a credit, so the journal is out by
  // twice the tax.
  assertThrows(
    () =>
      assertJournalBalances(
        [
          { accountId: RAW_MATERIALS, amount: debit("asset", 100) },
          { accountId: PURCHASE_TAX_PAYABLE, amount: debit("asset", 20) },
          { accountId: ACCOUNTS_PAYABLE, amount: credit("liability", 120) },
        ],
        accountTypes,
        "Purchase invoice journal"
      ),
    Error,
    "Purchase invoice journal does not balance (off by -40)"
  );
});

Deno.test("refuses a leg whose account class cannot be read", () => {
  // A guessed sign posts a debit as a credit, so an unclassifiable account has
  // to stop the posting rather than default to anything.
  assertThrows(
    () =>
      assertJournalBalances(
        [{ accountId: "acc_unknown", amount: 100 }],
        accountTypes,
        "Purchase invoice journal"
      ),
    Error,
    "Cannot determine the account class"
  );
  assertThrows(
    () =>
      assertJournalBalances(
        [{ accountId: null, amount: 100 }],
        accountTypes,
        "Sales invoice journal"
      ),
    Error,
    "Cannot determine the account class"
  );
});

Deno.test("tolerates sub-cent FX residue but not a real imbalance", () => {
  // 0.01 is a BUSINESS threshold: multi-currency legs carry genuine cross-rate
  // residuals, and refusing those would block real invoices.
  assertJournalBalances(
    [
      { accountId: RAW_MATERIALS, amount: debit("asset", 100.004) },
      { accountId: ACCOUNTS_PAYABLE, amount: credit("liability", 100) },
    ],
    accountTypes,
    "Purchase invoice journal"
  );

  assertThrows(
    () =>
      assertJournalBalances(
        [
          { accountId: RAW_MATERIALS, amount: debit("asset", 100.5) },
          { accountId: ACCOUNTS_PAYABLE, amount: credit("liability", 100) },
        ],
        accountTypes,
        "Purchase invoice journal"
      ),
    Error,
    "does not balance"
  );
});

Deno.test("an empty journal is vacuously balanced", () => {
  assertJournalBalances([], accountTypes, "Purchase invoice journal");
});
