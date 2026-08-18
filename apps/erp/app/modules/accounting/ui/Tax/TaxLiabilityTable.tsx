import { Combobox, HStack } from "@carbon/react";
import { useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useMemo } from "react";
import {
  LuCircleDollarSign,
  LuLandmark,
  LuPercent,
  LuShieldOff
} from "react-icons/lu";
import { PeriodSelector, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { useUrlParams } from "~/hooks";
import { useCurrencyFormatter } from "~/hooks/useCurrencyFormatter";
import { useUser } from "~/hooks/useUser";
import type { TaxLiabilityLine } from "../../types";

type TaxLiabilityTableProps = {
  data: TaxLiabilityLine[];
  authorities: { id: string; name: string }[];
  fiscalStartMonth: number;
};

const TaxLiabilityTable = memo(
  ({ data, authorities, fiscalStartMonth }: TaxLiabilityTableProps) => {
    const { t } = useLingui();
    const [params, setParams] = useUrlParams();
    const { company } = useUser();
    const currencyFormatter = useCurrencyFormatter({
      currency: company.baseCurrencyCode
    });

    const selectedAuthority = params.get("taxAuthorityId") ?? "";
    const authorityOptions = useMemo(
      () =>
        authorities.map((authority) => ({
          value: authority.id,
          label: authority.name
        })),
      [authorities]
    );

    const columns = useMemo<ColumnDef<TaxLiabilityLine>[]>(
      () => [
        {
          accessorKey: "taxAuthorityName",
          header: t`Authority`,
          cell: ({ row }) =>
            row.original.taxAuthorityName ? (
              <Enumerable value={row.original.taxAuthorityName} />
            ) : (
              // Legacy flat-taxPercent postings carry no authority.
              <span className="text-muted-foreground">{t`No authority`}</span>
            ),
          meta: {
            icon: <LuLandmark />,
            exportValue: (row: TaxLiabilityLine) => row.taxAuthorityName ?? ""
          }
        },
        {
          accessorKey: "componentName",
          header: t`Component`,
          cell: ({ row }) =>
            row.original.componentName ? (
              <Enumerable value={row.original.componentName} />
            ) : (
              // Exemption rows are recorded per line, without a component.
              <span className="text-muted-foreground">{t`Exempt (no component)`}</span>
            ),
          meta: {
            icon: <LuPercent />
          }
        },
        {
          accessorKey: "taxableAmount",
          header: t`Taxable Amount`,
          cell: ({ row }) =>
            currencyFormatter.format(row.original.taxableAmount),
          meta: {
            icon: <LuCircleDollarSign />
          }
        },
        {
          accessorKey: "exemptAmount",
          header: t`Exempt Amount`,
          cell: ({ row }) =>
            currencyFormatter.format(row.original.exemptAmount),
          meta: {
            icon: <LuShieldOff />
          }
        },
        {
          accessorKey: "collectedTax",
          header: t`Collected`,
          cell: ({ row }) =>
            currencyFormatter.format(row.original.collectedTax),
          meta: {
            icon: <LuCircleDollarSign />
          }
        },
        {
          accessorKey: "inputTax",
          header: t`Input Tax`,
          cell: ({ row }) => currencyFormatter.format(row.original.inputTax),
          meta: {
            icon: <LuCircleDollarSign />
          }
        },
        {
          accessorKey: "netTax",
          header: t`Net Owed`,
          cell: ({ row }) => (
            <span className="font-medium">
              {currencyFormatter.format(row.original.netTax)}
            </span>
          ),
          meta: {
            icon: <LuCircleDollarSign />
          }
        }
      ],
      [t, currencyFormatter]
    );

    return (
      <div className="flex flex-col h-full w-full">
        <HStack className="px-4 py-2 justify-between border-b border-border">
          <PeriodSelector
            variant="range"
            fiscalStartMonth={fiscalStartMonth}
            defaultPresetId="last-6-months"
          />
          <div className="w-64">
            <Combobox
              size="sm"
              value={selectedAuthority}
              options={authorityOptions}
              placeholder={t`All authorities`}
              onChange={(value) => {
                setParams({ taxAuthorityId: value || undefined });
              }}
              isClearable
            />
          </div>
        </HStack>
        <Table<TaxLiabilityLine>
          compact
          count={data.length}
          columns={columns}
          data={data}
          title={t`Tax Liability`}
        />
      </div>
    );
  }
);

TaxLiabilityTable.displayName = "TaxLiabilityTable";
export default TaxLiabilityTable;
