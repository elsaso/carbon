import { useControlField, ValidatedForm } from "@carbon/form";
import {
  Alert,
  AlertDescription,
  Button,
  HStack,
  ModalDrawer,
  ModalDrawerBody,
  ModalDrawerContent,
  ModalDrawerFooter,
  ModalDrawerHeader,
  ModalDrawerProvider,
  ModalDrawerTitle,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuInfo } from "react-icons/lu";
import { useFetcher } from "react-router";
import type { z } from "zod";
import {
  AddressAutocomplete,
  Combobox,
  CustomFormFields,
  Hidden,
  Input,
  Submit
} from "~/components/Form";
import { useCountries } from "~/components/Form/Country";
import { usePermissions } from "~/hooks";
import { TaxCodeSuggestion } from "~/modules/accounting/ui/Tax";
import { path } from "~/utils/path";
import { customerLocationValidator } from "../../sales.models";

type CustomerLocationFormProps = {
  customerId: string;
  initialValues: z.infer<typeof customerLocationValidator>;
  taxCodes?: { id: string; name: string }[];
  type?: "modal" | "drawer";
  open?: boolean;
  onClose: () => void;
};

const CustomerLocationForm = ({
  customerId,
  initialValues,
  taxCodes,
  open = true,
  type = "drawer",
  onClose
}: CustomerLocationFormProps) => {
  const { t } = useLingui();
  const fetcher = useFetcher<{}>();

  const permissions = usePermissions();
  const isEditing = !!initialValues?.id;
  const isDisabled = isEditing
    ? !permissions.can("update", "sales")
    : !permissions.can("create", "sales");

  return (
    <ModalDrawerProvider type={type}>
      <ModalDrawer
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose?.();
        }}
      >
        <ModalDrawerContent>
          <ValidatedForm
            validator={customerLocationValidator}
            method="post"
            action={
              isEditing
                ? path.to.customerLocation(customerId, initialValues.id!)
                : path.to.newCustomerLocation(customerId)
            }
            defaultValues={initialValues}
            fetcher={fetcher}
            onSubmit={() => {
              if (type === "modal") {
                onClose?.();
              }
            }}
            className="flex flex-col h-full"
          >
            <ModalDrawerHeader>
              <ModalDrawerTitle>
                {isEditing ? <Trans>Edit</Trans> : <Trans>New</Trans>}{" "}
                <Trans>Location</Trans>
              </ModalDrawerTitle>
            </ModalDrawerHeader>
            <ModalDrawerBody>
              <Hidden name="id" />
              <Hidden name="type" value={type} />
              <Hidden name="addressId" />
              <VStack spacing={4}>
                <Input name="name" label={t`Name`} />
                <AddressAutocomplete />
                {taxCodes && <LocationTaxCodeField taxCodes={taxCodes} />}
                <CustomFormFields table="customerLocation" />
              </VStack>
            </ModalDrawerBody>
            <ModalDrawerFooter>
              <HStack>
                <Submit isDisabled={isDisabled}>
                  <Trans>Save</Trans>
                </Submit>
                <Button size="md" variant="solid" onClick={onClose}>
                  <Trans>Cancel</Trans>
                </Button>
              </HStack>
            </ModalDrawerFooter>
          </ValidatedForm>
        </ModalDrawerContent>
      </ModalDrawer>
    </ModalDrawerProvider>
  );
};

/**
 * Location-level tax code override, plus an advisory address-match hint.
 * The suggestion is never auto-applied — tax always resolves from the code
 * that was explicitly assigned, never from an inferred address.
 */
function LocationTaxCodeField({
  taxCodes
}: {
  taxCodes: { id: string; name: string }[];
}) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement>(null);
  const [taxCodeId, setTaxCodeId] = useControlField<string | undefined>(
    "taxCodeId"
  );
  const [countryCode] = useControlField<string | undefined>("countryCode");
  const [stateProvince, setStateProvince] = useState<string | null>(null);

  // stateProvince is an uncontrolled input owned by AddressAutocomplete
  const readStateProvince = useCallback(() => {
    const form = containerRef.current?.closest("form");
    const input = form?.querySelector<HTMLInputElement>(
      'input[name="stateProvince"]'
    );
    return input?.value.trim() || null;
  }, []);

  useEffect(() => {
    const form = containerRef.current?.closest("form");
    if (!form) return;
    const onInput = () => setStateProvince(readStateProvince());
    form.addEventListener("input", onInput);
    return () => form.removeEventListener("input", onInput);
  }, [readStateProvince]);

  // Google Places fills state/province imperatively while setting the country
  // biome-ignore lint/correctness/useExhaustiveDependencies: countryCode is the re-read trigger
  useEffect(() => {
    setStateProvince(readStateProvince());
  }, [countryCode, readStateProvince]);

  const options = useMemo(
    () => taxCodes.map(({ id, name }) => ({ value: id, label: name })),
    [taxCodes]
  );

  return (
    <div className="flex flex-col gap-4 w-full" ref={containerRef}>
      <Combobox
        name="taxCodeId"
        label={t`Tax Code`}
        options={options}
        placeholder={t`Select Tax Code`}
        helperText={t`Overrides the customer's tax code for this location`}
      />
      <TaxCodeSuggestion
        countryCode={countryCode}
        state={stateProvince}
        taxCodeId={taxCodeId}
        onApply={setTaxCodeId}
      />
    </div>
  );
}

export default CustomerLocationForm;
