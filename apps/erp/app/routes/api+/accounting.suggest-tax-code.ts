import { requirePermissions } from "@carbon/auth/auth.server";
import type { LoaderFunctionArgs } from "react-router";
import { suggestTaxCode } from "~/modules/accounting";

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "accounting"
  });

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const countryCode = searchParams.get("countryCode");
  const state = searchParams.get("state");

  if (!countryCode) {
    return { data: [], error: null };
  }

  return await suggestTaxCode(client, companyId, {
    countryCode,
    state
  });
}
