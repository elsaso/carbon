import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { getTaxCodesList, suggestTaxCode } from "~/modules/accounting";
import {
  getSupplier,
  getSupplierLocations,
  getSupplierTax,
  supplierTaxValidator,
  updateSupplierTax
} from "~/modules/purchasing";
import { SupplierTaxForm } from "~/modules/purchasing/ui/Supplier";
import type { TaxCodeSuggestion } from "~/modules/purchasing/ui/Supplier/SupplierTaxForm";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "purchasing"
  });

  const { supplierId } = params;
  if (!supplierId) throw new Error("Could not find supplierId");

  const [supplierTax, supplier, taxCodes, locations] = await Promise.all([
    getSupplierTax(client, supplierId),
    getSupplier(client, supplierId),
    getTaxCodesList(client, companyId),
    getSupplierLocations(client, supplierId)
  ]);

  if (supplierTax.error) {
    throw redirect(
      path.to.supplier(supplierId),
      await flash(
        request,
        error(supplierTax.error, "Failed to load supplier tax information")
      )
    );
  }

  // Advisory only — the primary location's address never auto-assigns a code
  const primaryAddress = locations.data?.find(
    (location) => location.address?.country?.alpha2
  )?.address;

  let taxCodeSuggestion: TaxCodeSuggestion | null = null;
  if (primaryAddress?.country?.alpha2) {
    const suggestion = await suggestTaxCode(client, companyId, {
      countryCode: primaryAddress.country.alpha2,
      state: primaryAddress.stateProvince
    });
    const match = suggestion.data?.[0];
    if (match) {
      taxCodeSuggestion = {
        id: match.id,
        name: match.name,
        country: primaryAddress.country.name ?? primaryAddress.country.alpha2,
        state: primaryAddress.stateProvince ?? null
      };
    }
  }

  return {
    supplierId,
    supplierTax: supplierTax.data,
    taxCodeId: supplier.data?.taxCodeId ?? "",
    taxCodes: taxCodes.data ?? [],
    taxCodeSuggestion
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "purchasing"
  });

  const { supplierId } = params;
  if (!supplierId) throw new Error("Could not find supplierId");

  const formData = await request.formData();
  const validation = await validator(supplierTaxValidator).validate(formData);

  if (validation.error) {
    return validationError(validation.error);
  }

  const taxExemptionCertificatePath =
    formData.get("taxExemptionCertificatePath")?.toString() || null;

  const update = await updateSupplierTax(client, {
    ...validation.data,
    supplierId,
    companyId,
    taxExemptionCertificatePath,
    updatedBy: userId
  });
  if (update.error) {
    throw redirect(
      path.to.supplier(supplierId),
      await flash(
        request,
        error(update.error, "Failed to update supplier tax information")
      )
    );
  }

  throw redirect(
    path.to.supplierTax(supplierId),
    await flash(request, success("Updated supplier tax information"))
  );
}

export default function SupplierTaxRoute() {
  const { supplierId, supplierTax, taxCodeId, taxCodes, taxCodeSuggestion } =
    useLoaderData<typeof loader>();
  const initialValues = {
    supplierId: supplierTax?.supplierId ?? supplierId,
    taxCodeId: taxCodeId ?? "",
    taxId: supplierTax?.taxId ?? "",
    vatNumber: supplierTax?.vatNumber ?? "",
    eori: supplierTax?.eori ?? "",
    taxExempt: supplierTax?.taxExempt ?? false,
    taxExemptionReason: supplierTax?.taxExemptionReason ?? undefined,
    taxExemptionCertificateNumber:
      supplierTax?.taxExemptionCertificateNumber ?? "",
    taxExemptionCertificatePath:
      supplierTax?.taxExemptionCertificatePath ?? null
  };

  return (
    <SupplierTaxForm
      initialValues={initialValues}
      taxCodes={taxCodes}
      taxCodeSuggestion={taxCodeSuggestion}
    />
  );
}
