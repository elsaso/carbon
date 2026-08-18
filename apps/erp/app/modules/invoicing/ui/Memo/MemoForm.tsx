import { ValidatedForm } from "@carbon/form";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DropdownMenuIcon,
  DropdownMenuItem,
  FormControl,
  FormLabel,
  Select as PartySelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useDisclosure,
  VStack
} from "@carbon/react";
import { INPUT_FORMAT, INPUT_STEP, round } from "@carbon/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { LuCheckCheck, LuTicketX, LuTrash } from "react-icons/lu";
import { useFetcher } from "react-router";
import type { z } from "zod";
import { DocumentHeader } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import {
  Currency,
  Customer,
  CustomFormFields,
  DatePicker,
  Hidden,
  Input,
  Number,
  NumberControlled,
  Select,
  SequenceOrCustomId,
  Submit,
  Supplier,
  TextArea
} from "~/components/Form";
import { ConfirmDelete } from "~/components/Modals";
import { useCurrencyDecimals, usePermissions, useUser } from "~/hooks";
import {
  isMemoLocked,
  memoDirection,
  memoValidator
} from "~/modules/invoicing";
import { path } from "~/utils/path";
import MemoStatus from "./MemoStatus";

type MemoFormValues = z.infer<typeof memoValidator>;

/** `Number` in this file is the FORM COMPONENT, not the global — so the global
 *  has to be reached explicitly. An emptied react-aria number input commits NaN
 *  (not 0), and a NaN amount must not derive a NaN tax that then saves as 0
 *  against a live tax code. */
const isFiniteAmount = (value: number) => globalThis.Number.isFinite(value);

type TaxCodeOption = {
  id: string;
  name: string;
  /** Fraction (0.0825), already resolved for the memo's date by the loader. */
  effectiveRate: number;
};

type MemoFormProps = {
  initialValues: MemoFormValues & { status?: string };
  taxCodes?: TaxCodeOption[];
};

const MemoForm = ({ initialValues, taxCodes = [] }: MemoFormProps) => {
  const { t } = useLingui();
  const { company } = useUser();
  const currencyDecimals = useCurrencyDecimals(
    company?.baseCurrencyCode ?? "USD"
  );
  const permissions = usePermissions();
  const post = useFetcher();
  const voidFetcher = useFetcher();
  const isEditing = Boolean(initialValues.id);
  const status = initialValues.status as
    | "Draft"
    | "Posted"
    | "Voided"
    | undefined;
  const isLocked = isMemoLocked(initialValues.status);
  const canMutate = permissions.can("update", "invoicing");
  const canDelete = permissions.can("delete", "invoicing");
  const deleteModal = useDisclosure();

  // Party type is a UI-only toggle — NOT a validator field. It switches which of
  // customerId/supplierId is shown; the hidden one stays empty. A memo can be for
  // a customer OR a supplier in either direction (all four combos are valid), so
  // this is independent of the direction control below. When editing, derive the
  // initial value from whichever party id is set.
  const [partyType, setPartyType] = useState<"Customer" | "Supplier">(
    initialValues.supplierId ? "Supplier" : "Customer"
  );

  // A memo amount is tax-INCLUSIVE: the party is credited the gross and the tax
  // is carved OUT of it, so the derivation is amount x r/(1+r), not amount x r.
  // The amount is tracked here only so selecting a code can re-derive from it;
  // its own field semantics (gross) are unchanged.
  const [amount, setAmount] = useState<number>(initialValues.amount ?? 0);
  const [taxCodeId, setTaxCodeId] = useState<string>(
    initialValues.taxCodeId ?? ""
  );
  const [taxAmount, setTaxAmount] = useState<number>(
    initialValues.taxAmount ?? 0
  );

  const taxCodeOptions = taxCodes.map((taxCode) => ({
    label: `${taxCode.name} (${round(taxCode.effectiveRate * 100, 3)}%)`,
    value: taxCode.id
  }));

  // Rounded at the currency's decimals — this is a settlement amount, and it is
  // what gets stored and split across components at posting.
  const deriveTax = (base: number, rate: number) =>
    round((base * rate) / (1 + rate), currencyDecimals);

  const onTaxCodeChange = (newTaxCodeId: string) => {
    setTaxCodeId(newTaxCodeId);
    const selected = taxCodes.find((taxCode) => taxCode.id === newTaxCodeId);
    // Clearing the code clears the tax; the memo must not keep an orphan amount
    // the posting would then refuse (validator: tax requires a code).
    setTaxAmount(
      selected && isFiniteAmount(amount)
        ? deriveTax(amount, selected.effectiveRate)
        : 0
    );
  };

  const onAmountChange = (newAmount: number) => {
    setAmount(newAmount);
    const selected = taxCodes.find((taxCode) => taxCode.id === taxCodeId);
    if (selected && isFiniteAmount(newAmount)) {
      setTaxAmount(deriveTax(newAmount, selected.effectiveRate));
    }
  };

  const directionOptions = memoDirection.map((d) => ({
    label: <Enumerable value={d} />,
    value: d
  }));

  return (
    <>
      <ValidatedForm
        method="post"
        validator={memoValidator}
        defaultValues={initialValues}
        isDisabled={isEditing && isLocked}
        className="w-full"
      >
        <Card>
          {isEditing ? (
            <DocumentHeader
              title={initialValues.memoId ?? ""}
              status={
                <>
                  <Enumerable value={initialValues.direction} />
                  <MemoStatus status={status} />
                </>
              }
              menuItems={
                status === "Draft" && canDelete ? (
                  <DropdownMenuItem destructive onClick={deleteModal.onOpen}>
                    <DropdownMenuIcon icon={<LuTrash />} />
                    <Trans>Delete</Trans>
                  </DropdownMenuItem>
                ) : undefined
              }
              actions={
                status === "Draft" ? (
                  <Button
                    leftIcon={<LuCheckCheck />}
                    variant="primary"
                    isLoading={post.state !== "idle"}
                    isDisabled={!canMutate}
                    onClick={() =>
                      post.submit(null, {
                        method: "post",
                        action: path.to.memoPost(initialValues.id!)
                      })
                    }
                  >
                    <Trans>Post</Trans>
                  </Button>
                ) : status === "Posted" ? (
                  <Button
                    leftIcon={<LuTicketX />}
                    variant="destructive"
                    isLoading={voidFetcher.state !== "idle"}
                    isDisabled={!canMutate}
                    onClick={() =>
                      voidFetcher.submit(null, {
                        method: "post",
                        action: path.to.memoVoid(initialValues.id!)
                      })
                    }
                  >
                    <Trans>Void</Trans>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <CardHeader>
              <CardTitle>
                <Trans>New Credit / Debit Memo</Trans>
              </CardTitle>
              <CardDescription>
                <Trans>
                  Record a credit or debit memo against a customer or supplier.
                  Applications to specific invoices are added after the memo is
                  created.
                </Trans>
              </CardDescription>
            </CardHeader>
          )}
          <CardContent>
            <Hidden name="id" />
            {isEditing && <Hidden name="memoId" />}
            <VStack>
              <div className="grid w-full gap-x-8 gap-y-4 grid-cols-1 md:grid-cols-2">
                {!isEditing && (
                  <SequenceOrCustomId
                    name="memoId"
                    label={t`Memo ID`}
                    table="memo"
                  />
                )}
                <Select
                  name="direction"
                  label={t`Direction`}
                  options={directionOptions}
                />
                {/* UI-only party-type select; no validator field. It only
                    controls which of customerId/supplierId is shown. */}
                <FormControl>
                  <FormLabel>
                    <Trans>Party Type</Trans>
                  </FormLabel>
                  <PartySelect
                    value={partyType}
                    onValueChange={(value) => {
                      if (value === "Customer" || value === "Supplier") {
                        setPartyType(value);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Customer">
                        <Enumerable value="Customer" />
                      </SelectItem>
                      <SelectItem value="Supplier">
                        <Enumerable value="Supplier" />
                      </SelectItem>
                    </SelectContent>
                  </PartySelect>
                </FormControl>
                {partyType === "Customer" ? (
                  <Customer name="customerId" label={t`Customer`} />
                ) : (
                  <Supplier name="supplierId" label={t`Supplier`} />
                )}
                <DatePicker name="memoDate" label={t`Memo Date`} />
                <Currency name="currencyCode" label={t`Currency`} />
                <Number
                  name="exchangeRate"
                  label={t`Exchange Rate`}
                  step={INPUT_STEP.exchangeRate}
                  formatOptions={INPUT_FORMAT.exchangeRate}
                />
                <NumberControlled
                  name="amount"
                  label={t`Amount`}
                  value={amount}
                  onChange={onAmountChange}
                  formatOptions={INPUT_FORMAT.money(
                    company?.baseCurrencyCode ?? "USD",
                    currencyDecimals
                  )}
                />
                <Select
                  name="taxCodeId"
                  label={t`Tax Code`}
                  options={taxCodeOptions}
                  value={taxCodeId}
                  onChange={(option) => onTaxCodeChange(option?.value ?? "")}
                  isClearable
                  isOptional
                  helperText={t`The memo amount includes this tax`}
                />
                <NumberControlled
                  name="taxAmount"
                  label={t`Tax Included`}
                  value={taxAmount}
                  onChange={setTaxAmount}
                  isDisabled={!taxCodeId}
                  formatOptions={INPUT_FORMAT.money(
                    company?.baseCurrencyCode ?? "USD",
                    currencyDecimals
                  )}
                  helperText={t`Derived from the code; edit to match the original document`}
                />
                <Input name="reference" label={t`Reference`} />
                <CustomFormFields table="memo" />
              </div>
              <div className="mt-4 w-full">
                <TextArea name="notes" label={t`Notes`} />
              </div>
            </VStack>
          </CardContent>
          <CardFooter>
            <Submit
              isDisabled={
                isEditing
                  ? isLocked || !canMutate
                  : !permissions.can("create", "invoicing")
              }
            >
              <Trans>Save</Trans>
            </Submit>
          </CardFooter>
        </Card>
      </ValidatedForm>
      {deleteModal.isOpen && (
        <ConfirmDelete
          action={path.to.memoDelete(initialValues.id!)}
          isOpen={deleteModal.isOpen}
          name={initialValues.memoId ?? ""}
          text={t`Are you sure you want to delete ${initialValues.memoId}? This cannot be undone.`}
          onCancel={deleteModal.onClose}
          onSubmit={deleteModal.onClose}
        />
      )}
    </>
  );
};

export default MemoForm;
