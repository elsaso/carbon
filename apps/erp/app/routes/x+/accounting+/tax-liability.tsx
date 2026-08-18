import { requirePermissions } from "@carbon/auth/auth.server";
import { VStack } from "@carbon/react";
import { datetime, defaultReportRange } from "@carbon/utils";
import { msg } from "@lingui/core/macro";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { z } from "zod";
import {
  getFiscalYearSettings,
  getTaxAuthoritiesList,
  getTaxLiability
} from "~/modules/accounting";
import { TaxLiabilityTable } from "~/modules/accounting/ui/Tax";
import { months } from "~/modules/shared";
import { getCompanyTimeZone } from "~/modules/shared/timezone.server";
import type { Handle } from "~/utils/handle";
import { path } from "~/utils/path";

export const handle: Handle = {
  breadcrumb: msg`Tax Liability`,
  to: path.to.taxLiability
};

// Invalid params fall back to defaults — a bad bookmark must not 500.
const paramsValidator = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  taxAuthorityId: z.string().optional()
});

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "accounting",
    role: "employee"
  });

  const url = new URL(request.url);
  const parsed = paramsValidator.safeParse(
    Object.fromEntries(url.searchParams.entries())
  );
  const startDateParam = parsed.success
    ? (parsed.data.startDate ?? null)
    : null;
  const endDateParam = parsed.success ? (parsed.data.endDate ?? null) : null;
  const taxAuthorityId = parsed.success
    ? (parsed.data.taxAuthorityId ?? null)
    : null;

  // Default to the trailing six months, matching the range reports.
  const range = defaultReportRange(
    endDateParam ??
      datetime.today(await getCompanyTimeZone(client, companyId)).toString()
  );
  const startDate = startDateParam ?? range.startDate;
  const endDate = endDateParam ?? range.endDate;

  const [liability, authorities, fiscalYearSettings] = await Promise.all([
    getTaxLiability(client, companyId, { startDate, endDate, taxAuthorityId }),
    getTaxAuthoritiesList(client, companyId),
    getFiscalYearSettings(client, companyId)
  ]);

  if (liability.error) {
    throw new Error("Failed to load tax liability");
  }

  return {
    data: liability.data ?? [],
    authorities: authorities.data ?? [],
    fiscalStartMonth:
      months.indexOf(fiscalYearSettings.data?.startMonth ?? "January") + 1
  };
}

export default function TaxLiabilityRoute() {
  const { data, authorities, fiscalStartMonth } =
    useLoaderData<typeof loader>();

  return (
    <VStack spacing={0} className="h-full">
      <TaxLiabilityTable
        data={data}
        authorities={authorities}
        fiscalStartMonth={fiscalStartMonth}
      />
    </VStack>
  );
}
