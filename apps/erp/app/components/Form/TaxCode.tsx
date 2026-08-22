import type { ComboboxProps } from "@carbon/form";
import { Combobox } from "@carbon/form";
import { useMount } from "@carbon/react";
import { round } from "@carbon/utils";
import { useMemo } from "react";
import { useFetcher } from "react-router";
import type { getTaxCodesListWithRates } from "~/modules/accounting";
import { path } from "~/utils/path";

type TaxCodeSelectProps = Omit<ComboboxProps, "options" | "onChange"> & {
  /** Receives the code id and the rate it charges today (a 0..1 fraction), so
   *  the caller can set the line's stored `taxPercent` in the same edit. Null
   *  rate means the selection was cleared — the line goes back to manual. */
  onChange?: (taxCodeId: string, effectiveRate: number | null) => void;
};

/**
 * The tax code a document line resolves through. Selecting one is what makes a
 * line's `taxPercent` a derived fact rather than a typed number, so the caller
 * gets the rate handed to it rather than having to look the code up again.
 *
 * A line with NO code is not an error — it is the manual/legacy path, where the
 * percent stays editable. That is why this is clearable and never required.
 */
const TaxCode = ({ onChange, ...props }: TaxCodeSelectProps) => {
  const { options, rateById } = useTaxCodes();

  return (
    <Combobox
      options={options}
      {...props}
      label={props?.label ?? "Tax Code"}
      placeholder={props?.placeholder ?? "None / manual"}
      isClearable
      onChange={(selected) => {
        // @carbon/form's Combobox hands back the OPTION (or null), not the value.
        const selectedId = selected ? selected.value : "";
        onChange?.(
          selectedId,
          selectedId ? (rateById.get(selectedId) ?? 0) : null
        );
      }}
    />
  );
};

TaxCode.displayName = "TaxCode";
export default TaxCode;

export const useTaxCodes = () => {
  const fetcher =
    useFetcher<Awaited<ReturnType<typeof getTaxCodesListWithRates>>>();

  useMount(() => {
    fetcher.load(path.to.api.taxCodes);
  });

  return useMemo(() => {
    const rows = fetcher.data?.data ?? [];
    return {
      // The rate rides in the label so the picker states what the code charges
      // — the percent field next to it is read-only once a code is chosen.
      options: rows.map((taxCode) => ({
        value: taxCode.id,
        label: `${taxCode.name} (${round(taxCode.effectiveRate * 100, 3)}%)`
      })),
      rateById: new Map(
        rows.map((taxCode) => [taxCode.id, taxCode.effectiveRate])
      )
    };
  }, [fetcher.data?.data]);
};
