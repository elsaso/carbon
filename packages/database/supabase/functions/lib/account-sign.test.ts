import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import {
  accountTypeFromClass,
  credit,
  debit,
  toDebitPositive,
} from "./account-sign.ts";

// The contract under test: a journal leg's sign is decided by the CLASS of the
// account it lands on, and that account is configuration — so the class has to
// be read, never assumed at the call site. The composition asserted at the
// bottom is the one that shipped wrong: an input-tax DEBIT signed with a
// literal "asset" while the configured account (2220 Purchase Tax Payable) is a
// Liability, which stored the debit as a credit and put the journal out by 2x.

Deno.test("accountTypeFromClass maps every glAccountClass value", () => {
  assertEquals(accountTypeFromClass("Asset"), "asset");
  assertEquals(accountTypeFromClass("Liability"), "liability");
  assertEquals(accountTypeFromClass("Equity"), "equity");
  assertEquals(accountTypeFromClass("Revenue"), "revenue");
  assertEquals(accountTypeFromClass("Expense"), "expense");
});

Deno.test("accountTypeFromClass refuses anything that is not a class", () => {
  // Lowercase is NOT accepted: the DB enum is Title-case, so a lowercase value
  // means the caller passed something other than `account.class`.
  assertThrows(() => accountTypeFromClass("asset"), Error, "Invalid account class");
  assertThrows(() => accountTypeFromClass(""), Error, "Invalid account class");
  assertThrows(() => accountTypeFromClass(null), Error, "Invalid account class");
  assertThrows(() => accountTypeFromClass(undefined), Error, "Invalid account class");
  assertThrows(() => accountTypeFromClass("Liabilities"), Error, "Invalid account class");
});

Deno.test("a debit stores with the sign of its account's own class", () => {
  // The regression: same intent (debit 20), opposite stored sign, decided
  // entirely by configuration.
  assertEquals(debit(accountTypeFromClass("Asset"), 20), 20);
  assertEquals(debit(accountTypeFromClass("Liability"), 20), -20);

  assertEquals(credit(accountTypeFromClass("Liability"), 20), 20);
  assertEquals(credit(accountTypeFromClass("Asset"), 20), -20);
});

Deno.test("toDebitPositive inverts the stored sign back to debit-positive", () => {
  // Storing then re-reading a leg must return the amount you meant, whatever
  // the account's class — this is what makes legs across classes summable.
  for (const accountClass of ["Asset", "Liability", "Equity", "Revenue", "Expense"]) {
    const accountType = accountTypeFromClass(accountClass);
    assertEquals(toDebitPositive(accountType, debit(accountType, 20)), 20);
    assertEquals(toDebitPositive(accountType, credit(accountType, 20)), -20);
  }
});
