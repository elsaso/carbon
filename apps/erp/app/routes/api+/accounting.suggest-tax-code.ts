import { requirePermissions } from "@carbon/auth/auth.server";
import type { LoaderFunctionArgs } from "react-router";
import { suggestTaxCode } from "~/modules/accounting";

/**
 * Live tax-code suggestions for an address. Read-only and advisory — it never
 * assigns anything.
 *
 * Gated on `role: "employee"` rather than `view: "accounting"`: the callers are
 * the customer, customer-location, and supplier tax forms, which are reachable
 * under `sales` and `purchasing` permissions. Requiring accounting here made the
 * hint silently never appear for exactly the people the forms are built for.
 * Tax codes are company configuration that `taxCode`'s RLS SELECT policy already
 * opens to any employee of the company, so this matches the row-level rule
 * instead of contradicting it.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    role: "employee"
  });

  const searchParams = new URL(request.url).searchParams;
  const countryCode = searchParams.get("countryCode");
  const state = searchParams.get("state");

  if (!countryCode && !state) {
    return { data: [], error: null };
  }

  return await suggestTaxCode(client, companyId, { countryCode, state });
}
