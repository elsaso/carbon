import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/types.ts";
import {
  type AccountType,
  accountTypeFromClass,
  toDebitPositive,
} from "../lib/account-sign.ts";
import { assertBalanced } from "./precision.ts";

/** The BUSINESS refusal threshold for a posting journal, matching what
 *  payment/memo posting passes — deliberately not EPSILON, which is the
 *  float-noise guard. Every leg a posting function writes is multiplied by the
 *  document's exchange rate, and multi-currency journals carry genuine sub-cent
 *  cross-rate residuals; a false refusal here blocks a customer from posting a
 *  real invoice. So the band is the currency's smallest unit rather than float
 *  noise. Manual journals and period close are entered in one currency and use
 *  the tighter 0.001 — do not unify them. */
export const JOURNAL_BALANCE_TOLERANCE = 0.01;

/** Resolve the real `class` of every account a set of journal legs posts to, in
 *  ONE query. Never call this inside a line loop (N+1). An id that resolves to
 *  no row, or to a row whose class is null, is simply absent from the map;
 *  `requireAccountType` is where that becomes a refusal.
 *
 *  Looked up BY ID with no tenant filter, which is deliberate: `account` has no
 *  `companyId` — the chart of accounts is shared across a company GROUP
 *  (`companyGroupId`) — and the ids handed in here were themselves read from
 *  rows already scoped to the company (its `accountDefault`, its tax
 *  components). Same shape as the existing `G/L Account` line-type fetch. */
export async function getAccountTypes(
  client: SupabaseClient<Database>,
  accountIds: (string | null | undefined)[]
): Promise<Map<string, AccountType>> {
  const accountTypes = new Map<string, AccountType>();

  const ids = [
    ...new Set(accountIds.filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return accountTypes;

  const accounts = await client
    .from("account")
    .select("id, class")
    .in("id", ids);

  if (accounts.error) {
    throw new Error(
      `Failed to fetch account classes: ${accounts.error.message}`
    );
  }

  for (const account of accounts.data ?? []) {
    if (!account.class) continue;
    accountTypes.set(account.id, accountTypeFromClass(account.class));
  }

  return accountTypes;
}

/** An account whose class cannot be read cannot be signed, and a guessed sign
 *  posts a debit as a credit. Stop the posting instead. */
export function requireAccountType(
  accountTypes: Map<string, AccountType>,
  accountId: string | null | undefined,
  context: string
): AccountType {
  const accountType = accountId ? accountTypes.get(accountId) : undefined;
  if (!accountType) {
    throw new Error(
      `Cannot determine the account class for ${context} (account ${
        accountId ?? "not configured"
      }); refusing to post`
    );
  }
  return accountType;
}

/** The ledger invariant at the insert choke point: convert every pending leg
 *  back to debit-positive using its account's REAL class, and refuse if the two
 *  sides disagree. This is the guard whose absence let an unbalanced
 *  purchase-tax journal be written silently. */
export function assertJournalBalances(
  journalLines: { accountId?: string | null; amount?: number | null }[],
  accountTypes: Map<string, AccountType>,
  label: string,
  tolerance: number = JOURNAL_BALANCE_TOLERANCE
): void {
  let debits = 0;
  let credits = 0;

  for (const journalLine of journalLines) {
    const accountType = requireAccountType(
      accountTypes,
      journalLine.accountId,
      label
    );
    const asDebit = toDebitPositive(accountType, journalLine.amount ?? 0);
    if (asDebit >= 0) debits += asDebit;
    else credits -= asDebit;
  }

  assertBalanced(debits, credits, tolerance, label);
}
