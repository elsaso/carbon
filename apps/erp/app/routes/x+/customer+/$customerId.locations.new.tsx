import { assertIsPost, error, notFound, success } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import {
  data,
  redirect,
  useLoaderData,
  useNavigate,
  useParams
} from "react-router";
import { useUser } from "~/hooks";
import { getTaxCodesList } from "~/modules/accounting";
import {
  customerLocationValidator,
  insertCustomerLocation
} from "~/modules/sales";
import { CustomerLocationForm } from "~/modules/sales/ui/Customer";
import { setCustomFields } from "~/utils/form";
import { path } from "~/utils/path";
import { customerLocationsQuery } from "~/utils/react-query";

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "sales"
  });

  const taxCodes = await getTaxCodesList(client, companyId);

  return {
    taxCodes: taxCodes.data ?? []
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    create: "sales"
  });

  const formData = await request.formData();
  const modal = formData.get("type") === "modal";

  const { customerId } = params;
  if (!customerId) throw notFound("customerId not found");

  const validation = await validator(customerLocationValidator).validate(
    formData
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  // taxCodeId belongs to `customerLocation`, so it must not fall into `...address`
  // biome-ignore lint/correctness/noUnusedVariables: suppressed due to migration
  const { id, addressId, name, taxCodeId, ...address } = validation.data;

  const createCustomerLocation = await insertCustomerLocation(client, {
    customerId,
    companyId,
    name,
    taxCodeId,
    address,
    customFields: setCustomFields(formData)
  });
  if (createCustomerLocation.error) {
    return modal
      ? createCustomerLocation
      : redirect(
          path.to.customerLocations(customerId),
          await flash(
            request,
            error(
              createCustomerLocation.error,
              "Failed to create customer location"
            )
          )
        );
  }

  return modal
    ? data(createCustomerLocation, { status: 201 })
    : redirect(
        path.to.customerLocations(customerId),
        await flash(request, success("Customer location created"))
      );
}

export async function clientAction({
  serverAction,
  params
}: ClientActionFunctionArgs) {
  const { customerId } = params;
  if (customerId) {
    window.clientCache?.setQueryData(
      customerLocationsQuery(customerId).queryKey,
      null
    );
  }
  return await serverAction();
}

export default function CustomerLocationsNewRoute() {
  const navigate = useNavigate();
  const { company } = useUser();
  const { taxCodes } = useLoaderData<typeof loader>();
  const { customerId } = useParams();
  if (!customerId) throw new Error("customerId not found");

  const initialValues = {
    name: "",
    taxCodeId: "",
    countryCode: company?.countryCode ?? ""
  };

  return (
    <CustomerLocationForm
      initialValues={initialValues}
      customerId={customerId}
      taxCodes={taxCodes}
      onClose={() => navigate(path.to.customerLocations(customerId))}
    />
  );
}
