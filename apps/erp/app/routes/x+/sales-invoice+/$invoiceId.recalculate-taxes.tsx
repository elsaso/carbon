import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { datetime } from "@carbon/utils";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { recalculateSalesLineTaxes } from "~/modules/accounting";
import { getSalesInvoice, isSalesInvoiceLocked } from "~/modules/invoicing";
import { getCompanyTimeZone } from "~/modules/shared/timezone.server";
import { requireUnlocked } from "~/utils/lockedGuard.server";
import { path } from "~/utils/path";

/**
 * Re-resolve tax for every line from the CURRENT configuration. A line stores
 * what was resolved when it was created, so this is the only way to pick up a
 * changed customer code or ship-to override without retyping each line.
 *
 * Refuses on a locked invoice: a posted document's tax is history, not a
 * derived value to recompute.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "invoicing"
  });

  const { invoiceId } = params;
  if (!invoiceId) throw new Error("Could not find invoiceId");

  const invoice = await getSalesInvoice(client, invoiceId);
  if (invoice.error || !invoice.data) {
    throw redirect(
      path.to.salesInvoiceDetails(invoiceId),
      await flash(request, error(invoice.error, "Failed to load sales invoice"))
    );
  }

  await requireUnlocked({
    request,
    isLocked: isSalesInvoiceLocked(invoice.data.status),
    redirectTo: path.to.salesInvoiceDetails(invoiceId),
    message:
      "Cannot recalculate tax on a locked sales invoice. Reopen it first."
  });

  // The tax point is the document's own date, not today — an effective-dated
  // rate change must not restate an invoice issued before it took effect. Only
  // a document with neither date falls back to the company's today.
  const date =
    invoice.data.dateIssued ??
    invoice.data.postingDate ??
    datetime.today(await getCompanyTimeZone(client, companyId)).toString();

  const result = await recalculateSalesLineTaxes(client, companyId, {
    lineTable: "salesInvoiceLine",
    documentColumn: "invoiceId",
    documentId: invoiceId,
    customerId: invoice.data.customerId,
    customerLocationId: invoice.data.invoiceCustomerLocationId ?? null,
    date,
    updatedBy: userId
  });

  if (result.error) {
    throw redirect(
      path.to.salesInvoiceDetails(invoiceId),
      await flash(request, error(result.error, "Failed to recalculate tax"))
    );
  }

  throw redirect(
    path.to.salesInvoiceDetails(invoiceId),
    await flash(
      request,
      success(`Recalculated tax on ${result.data?.updated ?? 0} lines`)
    )
  );
}
