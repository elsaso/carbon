import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/types.ts";
import {
  type AccountType,
  accountTypeFromClass,
} from "../lib/account-sign.ts";

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
