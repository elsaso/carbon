import { error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { useLingui } from "@lingui/react/macro";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useNavigate, useParams } from "react-router";
import { ConfirmDelete } from "~/components/Modals";
import {
  deleteTaxRegistration,
  getTaxRegistration
} from "~/modules/accounting";
import { getParams, path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "accounting"
  });
  const { taxRegistrationId } = params;
  if (!taxRegistrationId) throw notFound("taxRegistrationId not found");

  const taxRegistration = await getTaxRegistration(
    client,
    taxRegistrationId,
    companyId
  );
  if (taxRegistration.error) {
    throw redirect(
      `${path.to.taxRegistrations}?${getParams(request)}`,
      await flash(
        request,
        error(taxRegistration.error, "Failed to get tax registration")
      )
    );
  }

  return { taxRegistration: taxRegistration.data };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    delete: "accounting"
  });

  const { taxRegistrationId } = params;
  if (!taxRegistrationId) {
    throw redirect(
      `${path.to.taxRegistrations}?${getParams(request)}`,
      await flash(request, error(params, "Failed to get a tax registration id"))
    );
  }

  const { error: deleteTaxRegistrationError } = await deleteTaxRegistration(
    client,
    taxRegistrationId,
    companyId
  );
  if (deleteTaxRegistrationError) {
    throw redirect(
      `${path.to.taxRegistrations}?${getParams(request)}`,
      await flash(
        request,
        error(deleteTaxRegistrationError, "Failed to delete tax registration")
      )
    );
  }

  throw redirect(
    `${path.to.taxRegistrations}?${getParams(request)}`,
    await flash(request, success("Successfully deleted tax registration"))
  );
}

export default function DeleteTaxRegistrationRoute() {
  const { taxRegistrationId } = useParams();
  const { taxRegistration } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { t } = useLingui();

  if (!taxRegistrationId || !taxRegistration) return null; // TODO - handle this better (404?)

  const onCancel = () => navigate(path.to.taxRegistrations);

  return (
    <ConfirmDelete
      action={path.to.deleteTaxRegistration(taxRegistrationId)}
      name={taxRegistration.registrationNumber}
      text={t`Are you sure you want to delete the tax registration: ${taxRegistration.registrationNumber}? This cannot be undone.`}
      onCancel={onCancel}
    />
  );
}
