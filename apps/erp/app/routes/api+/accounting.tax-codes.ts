import { requirePermissions } from "@carbon/auth/auth.server";
import { datetime } from "@carbon/utils";
import type { LoaderFunctionArgs } from "react-router";
import { getTaxCodesListWithRates } from "~/modules/accounting";
import { getCompanyTimeZone } from "~/modules/shared/timezone.server";

/**
 * Active tax codes with the rate each charges TODAY, for the document-line
 * selects. Deliberately NOT cached through react-query like the other list
 * endpoints: the rate is effective-dated, so a cached list served across a rate
 * change would offer a stale percent to a new line.
 *
 * Gated on `role: "employee"`, not `view: "accounting"` — the people picking a
 * tax code on a quote or an order are in sales and purchasing.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    role: "employee"
  });

  const today = datetime
    .today(await getCompanyTimeZone(client, companyId))
    .toString();

  return await getTaxCodesListWithRates(client, companyId, today);
}
