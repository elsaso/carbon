import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { getCompanyUsesTaxCodes, getTaxCodesList } from "~/modules/accounting";
import {
  customerTaxValidator,
  getCustomer,
  getCustomerLocations,
  getCustomerTax,
  updateCustomerTax
} from "~/modules/sales";
import { CustomerTaxForm } from "~/modules/sales/ui/Customer";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "sales"
  });

  const { customerId } = params;
  if (!customerId) throw new Error("Could not find customerId");

  const [customerTax, customer, taxCodes, locations, taxCodesInUse] =
    await Promise.all([
      getCustomerTax(client, customerId),
      getCustomer(client, customerId),
      getTaxCodesList(client, companyId),
      getCustomerLocations(client, customerId),
      getCompanyUsesTaxCodes(client, companyId)
    ]);

  if (customerTax.error || !customerTax.data) {
    throw redirect(
      path.to.customer(customerId),
      await flash(
        request,
        error(customerTax.error, "Failed to load customer tax information")
      )
    );
  }

  // Advisory only — the primary location's address never auto-assigns a code.
  // The shared TaxCodeSuggestion component fetches and ranks the matches; the
  // loader just hands it the address to ask about.
  const primaryAddress = locations.data?.find(
    (location) => location.address?.country?.alpha2
  )?.address;

  return {
    customerTax: customerTax.data,
    taxCodeId: customer.data?.taxCodeId ?? "",
    taxCodes: taxCodes.data ?? [],
    taxCodesInUse,
    addressHint: primaryAddress?.country?.alpha2
      ? {
          countryCode: primaryAddress.country.alpha2,
          state: primaryAddress.stateProvince ?? null
        }
      : null
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, userId } = await requirePermissions(request, {
    update: "sales"
  });

  const { customerId } = params;
  if (!customerId) throw new Error("Could not find customerId");

  const formData = await request.formData();
  const validation = await validator(customerTaxValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const taxExemptionCertificatePath =
    formData.get("taxExemptionCertificatePath")?.toString() || null;

  const update = await updateCustomerTax(client, {
    ...validation.data,
    customerId,
    taxExemptionCertificatePath,
    updatedBy: userId
  });
  if (update.error) {
    throw redirect(
      path.to.customer(customerId),
      await flash(
        request,
        error(update.error, "Failed to update customer tax information")
      )
    );
  }

  throw redirect(
    path.to.customerTax(customerId),
    await flash(request, success("Updated customer tax information"))
  );
}

export default function CustomerTaxRoute() {
  const { customerTax, taxCodeId, taxCodes, taxCodesInUse, addressHint } =
    useLoaderData<typeof loader>();
  const initialValues = {
    customerId: customerTax?.customerId ?? "",
    taxCodeId: taxCodeId ?? "",
    taxId: customerTax?.taxId ?? "",
    vatNumber: customerTax?.vatNumber ?? "",
    eori: customerTax?.eori ?? "",
    taxExempt: customerTax?.taxExempt ?? false,
    taxExemptionReason: customerTax?.taxExemptionReason ?? undefined,
    taxExemptionCertificateNumber:
      customerTax?.taxExemptionCertificateNumber ?? "",
    taxExemptionCertificatePath:
      customerTax?.taxExemptionCertificatePath ?? null
  };

  return (
    <CustomerTaxForm
      initialValues={initialValues}
      taxCodes={taxCodes}
      addressHint={addressHint}
      taxCodesInUse={taxCodesInUse}
    />
  );
}
