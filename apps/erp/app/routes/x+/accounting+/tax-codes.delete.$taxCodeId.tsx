import { error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import { deleteTaxCode, getTaxCode } from "~/modules/accounting";
import { getParams, path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client } = await requirePermissions(request, {
    view: "accounting"
  });
  const { taxCodeId } = params;
  if (!taxCodeId) throw notFound("taxCodeId not found");

  const taxCode = await getTaxCode(client, taxCodeId);
  if (taxCode.error) {
    throw redirect(
      `${path.to.taxCodes}?${getParams(request)}`,
      await flash(request, error(taxCode.error, "Failed to get tax code"))
    );
  }

  return { taxCode: taxCode.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { client } = await requirePermissions(request, {
    delete: "accounting"
  });

  const { taxCodeId } = params;
  if (!taxCodeId) {
    throw redirect(
      `${path.to.taxCodes}?${getParams(request)}`,
      await flash(request, error(params, "Failed to get a tax code id"))
    );
  }

  const { error: deleteTaxCodeError } = await deleteTaxCode(client, taxCodeId);
  if (deleteTaxCodeError) {
    throw redirect(
      `${path.to.taxCodes}?${getParams(request)}`,
      await flash(
        request,
        error(deleteTaxCodeError, "Failed to delete tax code")
      )
    );
  }

  throw redirect(
    `${path.to.taxCodes}?${getParams(request)}`,
    await flash(request, success("Successfully deleted tax code"))
  );
}

export default function DeleteTaxCodeRoute() {
  const { taxCodeId } = useParams();
  const { taxCode } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useLingui();

  if (!taxCodeId || !taxCode) return null; // TODO - handle this better (404?)

  const onCancel = () => navigate(path.to.taxCodes);

  // Soft delete: posted documents keep their historical code, so the record is
  // deactivated rather than removed.
  return (
    <ConfirmDelete
      action={path.to.deleteTaxCode(taxCodeId)}
      name={taxCode.name}
      text={t`Are you sure you want to delete the tax code: ${taxCode.name}? It will no longer be available for new documents.`}
      onCancel={onCancel}
    />
  );
}
