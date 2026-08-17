import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect, useLoaderData, useNavigate } from "react-router";
import { z } from "zod";
import {
  getTaxAuthoritiesList,
  getTaxCode,
  taxCodeComponentValidator,
  taxCodeValidator,
  upsertTaxCode
} from "~/modules/accounting";
import { TaxCodeForm } from "~/modules/accounting/ui/Tax";
import { getCustomFields, setCustomFields } from "~/utils/form";
import { getParams, path } from "~/utils/path";

// The components editor serializes its rows into a single hidden `components`
// field, so the string has to be parsed and validated separately from the
// FormData-level validator.
const taxCodeComponentsValidator = z
  .array(taxCodeComponentValidator)
  .min(1, { message: "At least one tax component is required" });

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "accounting",
    role: "employee"
  });

  const { taxCodeId } = params;
  if (!taxCodeId) throw notFound("taxCodeId not found");

  const [taxCode, taxAuthorities] = await Promise.all([
    getTaxCode(client, taxCodeId),
    // Feeds the per-component authority select in the components editor.
    getTaxAuthoritiesList(client, companyId)
  ]);

  return {
    taxCode: taxCode?.data ?? null,
    taxAuthorities: taxAuthorities.data ?? []
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, userId } = await requirePermissions(request, {
    update: "accounting"
  });

  const formData = await request.formData();
  const validation = await validator(taxCodeValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, components, ...d } = validation.data;
  if (!id) throw new Error("id not found");

  let parsedComponents: unknown;
  try {
    parsedComponents = JSON.parse(components);
  } catch {
    return validationError({
      fieldErrors: { components: "Tax components must be valid JSON" }
    });
  }

  const componentsResult =
    taxCodeComponentsValidator.safeParse(parsedComponents);

  if (!componentsResult.success) {
    const issue = componentsResult.error.issues[0];
    return validationError({
      fieldErrors: {
        components: issue
          ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${
              issue.message
            }`
          : "Invalid tax components"
      }
    });
  }

  const updateTaxCode = await upsertTaxCode(
    client,
    {
      id,
      ...d,
      updatedBy: userId,
      customFields: setCustomFields(formData)
    },
    componentsResult.data
  );

  if (updateTaxCode.error) {
    return data(
      {},
      await flash(
        request,
        error(updateTaxCode.error, "Failed to update tax code")
      )
    );
  }

  throw redirect(
    `${path.to.taxCodes}?${getParams(request)}`,
    await flash(request, success("Updated tax code"))
  );
}

export default function EditTaxCodeRoute() {
  const { taxCode, taxAuthorities } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const initialValues = {
    id: taxCode?.id ?? undefined,
    name: taxCode?.name ?? "",
    description: taxCode?.description ?? "",
    calculationType: taxCode?.calculationType ?? ("Normal" as const),
    reportingCategory: taxCode?.reportingCategory ?? ("Standard" as const),
    invoiceMessage: taxCode?.invoiceMessage ?? "",
    countryCode: taxCode?.countryCode ?? "",
    state: taxCode?.state ?? "",
    // The form re-serializes its rows into the hidden `components` field
    components: JSON.stringify(taxCode?.components ?? []),
    ...getCustomFields(taxCode?.customFields)
  };

  return (
    <TaxCodeForm
      key={initialValues.id}
      initialValues={initialValues}
      taxAuthorities={taxAuthorities}
      onClose={() => navigate(-1)}
    />
  );
}
