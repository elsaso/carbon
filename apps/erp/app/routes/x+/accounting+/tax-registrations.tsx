import { requirePermissions } from "@carbon/auth/auth.server";
import { getCompanyTimeZone } from "@carbon/database";
import { VStack } from "@carbon/react";
import { datetime } from "@carbon/utils";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";
import { getTaxCodes, getTaxRegistrations } from "~/modules/accounting";
import { TaxRegistrationsTable } from "~/modules/accounting/ui/Tax";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";
import { getGenericQueryFilters } from "~/utils/query";

export const handle: Handle = {
  breadcrumb: msg`Tax Registrations`,
  to: path.to.taxRegistrations
};

// The cross-warnings compare every active code against every active
// registration, so they cannot be derived from the (paginated, filtered) table
// page — they get their own unfiltered reads.
const UNPAGINATED = {
  search: null,
  limit: 1000,
  offset: 0,
  sorts: [],
  filters: []
};

const jurisdiction = (countryCode: string, state: string | null) =>
  state ? `${countryCode}-${state}` : countryCode;

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

  // The company's calendar day, not the server's — a registration that ends
  // tonight must not read as expired for a company several hours behind.
  const timezone = await getCompanyTimeZone(client, companyId);
  const today = datetime.today(timezone).toString();

  const [taxRegistrations, allTaxRegistrations, allTaxCodes] =
    await Promise.all([
      getTaxRegistrations(client, companyId, {
        search,
        limit,
        offset,
        sorts,
        filters
      }),
      getTaxRegistrations(client, companyId, UNPAGINATED),
      getTaxCodes(client, companyId, UNPAGINATED, today)
    ]);

  const registrations = allTaxRegistrations.data ?? [];
  // getTaxCodes now returns inactive codes too (they stay listed so they can be
  // reactivated); a deactivated code needs no registration, so drop them here.
  const codes = (allTaxCodes.data ?? []).filter((code) => code.active);
  const activeRegistrations = registrations.filter(
    (registration) =>
      (!registration.effectiveDate || registration.effectiveDate <= today) &&
      (!registration.endDate || registration.endDate >= today)
  );

  // A registration covers a code when the countries match and neither side
  // narrows to a different state (a country-wide registration covers every
  // state within it).
  const covers = (
    registration: { countryCode: string; state: string | null },
    code: { countryCode: string | null; state: string | null }
  ) =>
    registration.countryCode === code.countryCode &&
    (!registration.state || !code.state || registration.state === code.state);

  const codesWithoutRegistration = Array.from(
    new Set(
      codes
        .filter(
          (code) =>
            !!code.countryCode &&
            !activeRegistrations.some((registration) =>
              covers(registration, code)
            )
        )
        .map(
          (code) =>
            `${code.name} (${jurisdiction(code.countryCode!, code.state)})`
        )
    )
  );

  const registrationsWithoutCode = Array.from(
    new Set(
      registrations
        .filter(
          (registration) => !codes.some((code) => covers(registration, code))
        )
        .map(
          (registration) =>
            `${registration.registrationNumber} (${jurisdiction(
              registration.countryCode,
              registration.state
            )})`
        )
    )
  );

  return {
    data: taxRegistrations.data ?? [],
    count: taxRegistrations.count ?? 0,
    warnings: {
      codesWithoutRegistration,
      registrationsWithoutCode
    }
  };
}

export default function TaxRegistrationsRoute() {
  const { data, count, warnings } = useLoaderData<typeof loader>();

  return (
    <VStack spacing={0} className="h-full">
      <TaxRegistrationsTable
        data={data ?? []}
        count={count ?? 0}
        warnings={warnings}
      />
      <Outlet />
    </VStack>
  );
}
