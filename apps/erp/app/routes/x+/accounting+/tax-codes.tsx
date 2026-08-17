import { requirePermissions } from "@carbon/auth/auth.server";
import { getCompanyTimeZone } from "@carbon/database";
import { VStack } from "@carbon/react";
import { datetime } from "@carbon/utils";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { getTaxCodes } from "~/modules/accounting";
import { TaxCodesTable } from "~/modules/accounting/ui/Tax";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";
import { getGenericQueryFilters } from "~/utils/query";

export const handle: Handle = {
  breadcrumb: msg`Tax Codes`,
  to: path.to.taxCodes
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "accounting",
    role: "employee"
  });

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);
  const search = searchParams.get("search");
  const { limit, offset, sorts, filters } =
    getGenericQueryFilters(searchParams);

  // Effective rates are "as of today" on the company's calendar, not the
  // server's — a code whose component expires tonight must not already read as
  // expired for a company several hours behind.
  const timezone = await getCompanyTimeZone(client, companyId);

  return await getTaxCodes(
    client,
    companyId,
    { search, limit, offset, sorts, filters },
    datetime.today(timezone).toString()
  );
}

export default function TaxCodesRoute() {
  const { data, count } = useLoaderData<typeof loader>();

  return (
    <VStack spacing={0} className="h-full">
      <TaxCodesTable data={data ?? []} count={count ?? 0} />
      <Outlet />
    </VStack>
  );
}
