// The debit/credit sign convention, kept in its own module so it can be unit
// tested: `lib/utils.ts` type-imports the dual-runtime `postgres/index.ts`,
// whose node-vs-deno Pool typing does not type-check under Deno, which would
// otherwise make every consumer of this convention untestable. `utils.ts`
// re-exports all of it, so no call site needs to know this file exists.

export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense";

export const credit = (accountType: AccountType, amount: number) => {
  switch (accountType) {
    case "asset":
    case "expense":
      return -amount;
    case "liability":
    case "equity":
    case "revenue":
      return amount;
    default:
      throw new Error(`Invalid account type: ${accountType}`);
  }
};

export const debit = (accountType: AccountType, amount: number) => {
  switch (accountType) {
    case "asset":
    case "expense":
      return amount;
    case "liability":
    case "equity":
    case "revenue":
      return -amount;
    default:
      throw new Error(`Invalid account type: ${accountType}`);
  }
};

/** `account.class` is Title-case in the DB (the `glAccountClass` enum) while
 *  `credit`/`debit` take the lowercase type. The class of the account a journal
 *  leg posts to is CONFIGURATION — a tax component's own account, otherwise an
 *  accountDefault — so it is not knowable when the call site is written, and a
 *  LITERAL account type there is a bug: when the configured account turns out to
 *  be another class, the intended debit is stored as a credit and the journal
 *  silently goes out by twice the amount. Derive the type from the real class. */
export const accountTypeFromClass = (
  accountClass: string | null | undefined
): AccountType => {
  switch (accountClass) {
    case "Asset":
      return "asset";
    case "Liability":
      return "liability";
    case "Equity":
      return "equity";
    case "Revenue":
      return "revenue";
    case "Expense":
      return "expense";
    default:
      throw new Error(`Invalid account class: ${accountClass}`);
  }
};

/** Journal amounts are STORED in natural-balance sign, so legs sitting on
 *  different account classes cannot be summed as they stand. The convention is
 *  an involution: applying `debit` to a STORED amount converts it back to
 *  debit-positive, the one form in which a balanced journal's legs add to zero. */
export const toDebitPositive = (
  accountType: AccountType,
  storedAmount: number
) => debit(accountType, storedAmount);
