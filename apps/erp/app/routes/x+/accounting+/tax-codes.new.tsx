import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect, useNavigate } from "react-router";
import { z } from "zod";
import {
  taxCodeComponentValidator,
  taxCodeValidator,
  upsertTaxCode
} from "~/modules/accounting";
import { TaxCodeForm } from "~/modules/accounting/ui/Tax";
import { setCustomFields } from "~/utils/form";
import { getParams, path } from "~/utils/path";

// The components editor serializes its rows into a single hidden `components`
// field, so the string has to be parsed and validated separately from the
// FormData-level validator.
const taxCodeComponentsValidator = z
  .array(taxCodeComponentValidator)
  .min(1, { message: "At least one tax component is required" });

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermissions(request, {
    create: "accounting"
  });

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    create: "accounting"
  });

  const formData = await request.formData();
  const modal = formData.get("type") === "modal";

  const validation = await validator(taxCodeValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  // biome-ignore lint/correctness/noUnusedVariables: id is not set on insert
  const { id, components, ...rest } = validation.data;

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

  const insertTaxCode = await upsertTaxCode(
    client,
    {
      ...rest,
      companyId,
      createdBy: userId,
      customFields: setCustomFields(formData)
    },
    componentsResult.data
  );

  if (insertTaxCode.error) {
    return data(
      {},
      await flash(
        request,
        error(insertTaxCode.error, "Failed to insert tax code")
      )
    );
  }

  return modal
    ? data(insertTaxCode, { status: 201 })
    : redirect(
        `${path.to.taxCodes}?${getParams(request)}`,
        await flash(request, success("Tax code created"))
      );
}

export default function NewTaxCodeRoute() {
  const navigate = useNavigate();
  const initialValues = {
    name: "",
    description: "",
    calculationType: "Normal" as const,
    reportingCategory: "Standard" as const,
    invoiceMessage: "",
    countryCode: "",
    state: "",
    components: "[]"
  };

  return (
    <TaxCodeForm initialValues={initialValues} onClose={() => navigate(-1)} />
  );
}
