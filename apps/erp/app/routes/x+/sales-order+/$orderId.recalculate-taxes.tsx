import { assertIsPost, error, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { datetime } from "@carbon/utils";
import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { recalculateSalesLineTaxes } from "~/modules/accounting";
import { getSalesOrder, isSalesOrderLocked } from "~/modules/sales";
import { getCompanyTimeZone } from "~/modules/shared/timezone.server";
import { requireUnlocked } from "~/utils/lockedGuard.server";
import { path } from "~/utils/path";

/** The sales-order twin of the invoice recalculate action; see that route for
 *  why re-resolution is an explicit user action rather than automatic. */
export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "sales"
  });

  const { orderId } = params;
  if (!orderId) throw new Error("Could not find orderId");

  const order = await getSalesOrder(client, orderId);
  if (order.error || !order.data) {
    throw redirect(
      path.to.salesOrderDetails(orderId),
      await flash(request, error(order.error, "Failed to load sales order"))
    );
  }

  await requireUnlocked({
    request,
    isLocked: isSalesOrderLocked(order.data.status),
    redirectTo: path.to.salesOrderDetails(orderId),
    message: "Cannot recalculate tax on a locked sales order. Reopen it first."
  });

  const date =
    order.data.orderDate ??
    datetime.today(await getCompanyTimeZone(client, companyId)).toString();

  const result = await recalculateSalesLineTaxes(client, companyId, {
    lineTable: "salesOrderLine",
    documentColumn: "salesOrderId",
    documentId: orderId,
    customerId: order.data.customerId,
    customerLocationId: order.data.customerLocationId ?? null,
    date,
    updatedBy: userId
  });

  if (result.error) {
    throw redirect(
      path.to.salesOrderDetails(orderId),
      await flash(request, error(result.error, "Failed to recalculate tax"))
    );
  }

  throw redirect(
    path.to.salesOrderDetails(orderId),
    await flash(
      request,
      success(`Recalculated tax on ${result.data?.updated ?? 0} lines`)
    )
  );
}
