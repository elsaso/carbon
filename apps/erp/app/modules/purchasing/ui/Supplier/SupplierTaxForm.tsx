import { useCarbon } from "@carbon/auth";
import { useControlField, ValidatedForm } from "@carbon/form";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  HStack,
  toast
} from "@carbon/react";
import { isEoriCountry } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { nanoid } from "nanoid";
import { useCallback, useMemo, useState } from "react";
import { LuInfo, LuPaperclip } from "react-icons/lu";
import type { z } from "zod";
import { FileDropzone } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import {
  Boolean,
  Combobox,
  Hidden,
  Input,
  Select,
  Submit
} from "~/components/Form";
import { usePermissions, useUser } from "~/hooks";
import { TaxCodeSuggestion } from "~/modules/accounting/ui/Tax";
import { taxExemptionReasons } from "~/modules/shared";
import { supplierTaxValidator } from "../../purchasing.models";

type SupplierTaxFormProps = {
  initialValues: z.infer<typeof supplierTaxValidator> & {
    taxExemptionCertificatePath?: string | null;
  };
  taxCodes?: { id: string; name: string }[];
  /** Primary location address, used only to suggest a code. Never auto-applied. */
  addressHint?: { countryCode: string | null; state: string | null } | null;
  /** True once any party in the company carries a tax code (sunset banner). */
  taxCodesInUse?: boolean;
};

const SupplierTaxForm = ({
  initialValues,
  taxCodes = [],
  addressHint = null,
  taxCodesInUse = false
}: SupplierTaxFormProps) => {
  const { t } = useLingui();
  const taxExemptionReasonOptions = taxExemptionReasons.map((reason) => ({
    label: <Enumerable value={reason} />,
    value: reason
  }));
  const permissions = usePermissions();
  const { carbon } = useCarbon();
  const { company } = useUser();
  const companyId = company.id;
  const [certificatePath, setCertificatePath] = useState(
    initialValues.taxExemptionCertificatePath ?? ""
  );
  const [taxExempt, setTaxExempt] = useState(initialValues.taxExempt ?? false);

  const isDisabled = !permissions.can("update", "purchasing");

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file || !carbon) return;

      const fileExtension = file.name.split(".").pop();
      const fileName = `${companyId}/tax-certificates/${nanoid()}.${fileExtension}`;

      const result = await carbon.storage
        .from("private")
        .upload(fileName, file);

      if (result.error) {
        toast.error(t`Failed to upload certificate`);
      } else {
        setCertificatePath(result.data.path);
        toast.success(t`Certificate uploaded`);
      }
    },
    [carbon, companyId, t]
  );

  return (
    <ValidatedForm
      method="post"
      validator={supplierTaxValidator}
      defaultValues={initialValues}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans>Tax Information</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Hidden name="supplierId" />
          <input
            type="hidden"
            name="taxExemptionCertificatePath"
            value={certificatePath}
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-x-8 gap-y-4 w-full">
            <Input name="taxId" label={t`Tax ID`} />
            <Input name="vatNumber" label={t`VAT Number`} termId="vat-number" />
            {isEoriCountry(company.countryCode) ? (
              <Input name="eori" label={t`EORI`} termId="eori" />
            ) : (
              <div />
            )}
            <TaxCodeField taxCodes={taxCodes} addressHint={addressHint} />
            {taxCodesInUse && (
              <div className="col-span-3">
                <Alert variant="warning">
                  <LuInfo />
                  <AlertDescription>
                    <Trans>
                      Flat tax percent is deprecated — assign tax codes instead.
                      A code determines the rate, the authorities it splits
                      across, and the accounts it posts to; the percent on the
                      supplier record is only a fallback for parties that have
                      no code yet.
                    </Trans>
                  </AlertDescription>
                </Alert>
              </div>
            )}
            <div className="col-span-3">
              <Boolean
                name="taxExempt"
                label={t`Tax Exempt`}
                termId="tax-exempt"
                bordered
                onChange={setTaxExempt}
              />
            </div>
            {taxExempt && (
              <>
                <Select
                  name="taxExemptionReason"
                  label={t`Exemption Reason`}
                  options={taxExemptionReasonOptions}
                  placeholder={t`Select Reason`}
                />
                <Input
                  name="taxExemptionCertificateNumber"
                  label={t`Certificate Number`}
                />
              </>
            )}
          </div>
          {taxExempt && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  <Trans>Exemption Certificate</Trans>
                </label>
                {certificatePath && (
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<LuPaperclip />}
                    asChild
                  >
                    <a
                      href={`/file/preview/private/${certificatePath}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Trans>View Certificate</Trans>
                    </a>
                  </Button>
                )}
              </div>
              <FileDropzone
                onDrop={onDrop}
                accept={{
                  "application/pdf": [".pdf"],
                  "image/*": [".png", ".jpg", ".jpeg"]
                }}
                multiple={false}
              />
            </div>
          )}
        </CardContent>
        <CardFooter>
          <HStack>
            <Submit isDisabled={isDisabled}>
              <Trans>Save</Trans>
            </Submit>
          </HStack>
        </CardFooter>
      </Card>
    </ValidatedForm>
  );
};

function TaxCodeField({
  taxCodes,
  addressHint
}: {
  taxCodes: { id: string; name: string }[];
  addressHint: { countryCode: string | null; state: string | null } | null;
}) {
  const { t } = useLingui();
  const [taxCodeId, setTaxCodeId] = useControlField<string | undefined>(
    "taxCodeId"
  );

  const options = useMemo(
    () => taxCodes.map(({ id, name }) => ({ value: id, label: name })),
    [taxCodes]
  );

  return (
    <>
      <Combobox
        name="taxCodeId"
        label={t`Tax Code`}
        options={options}
        placeholder={t`Select Tax Code`}
      />
      <div className="col-span-3">
        <TaxCodeSuggestion
          countryCode={addressHint?.countryCode}
          state={addressHint?.state}
          taxCodeId={taxCodeId}
          onApply={setTaxCodeId}
        />
      </div>
    </>
  );
}

export default SupplierTaxForm;
