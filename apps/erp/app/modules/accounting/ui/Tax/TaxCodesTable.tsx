import { Checkbox, MenuIcon, MenuItem } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import {
  LuCalculator,
  LuFileText,
  LuGlobe,
  LuMapPin,
  LuPencil,
  LuPercent,
  LuTags,
  LuToggleLeft,
  LuTrash
} from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { usePercentFormatter, usePermissions, useUrlParams } from "~/hooks";
import { useCustomColumns } from "~/hooks/useCustomColumns";
import { path } from "~/utils/path";
import {
  taxCalculationTypes,
  taxReportingCategories
} from "../../accounting.models";
import type { TaxCode } from "../../types";

type TaxCodesTableProps = {
  data: TaxCode[];
  count: number;
};

const TaxCodesTable = memo(({ data, count }: TaxCodesTableProps) => {
  const { t } = useLingui();
  const [params] = useUrlParams();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const percentFormatter = usePercentFormatter();
  const customColumns = useCustomColumns<TaxCode>("taxCode");

  const columns = useMemo<ColumnDef<TaxCode>[]>(() => {
    const defaultColumns: ColumnDef<TaxCode>[] = [
      {
        accessorKey: "name",
        header: t`Name`,
        cell: ({ row }) => (
          <Hyperlink to={`${row.original.id}?${params.toString()}`}>
            <Enumerable value={row.original.name} />
          </Hyperlink>
        ),
        meta: {
          icon: <LuPercent />
        }
      },
      {
        accessorKey: "description",
        header: t`Description`,
        cell: (item) => item.getValue<string | null>(),
        meta: {
          icon: <LuFileText />
        }
      },
      {
        accessorKey: "calculationType",
        header: t`Calculation Type`,
        cell: (item) => <Enumerable value={item.getValue<string>()} />,
        meta: {
          filter: {
            type: "static",
            options: taxCalculationTypes.map((v) => ({
              label: <Enumerable value={v} />,
              value: v
            }))
          },
          icon: <LuCalculator />
        }
      },
      {
        accessorKey: "reportingCategory",
        header: t`Reporting Category`,
        cell: (item) => <Enumerable value={item.getValue<string>()} />,
        meta: {
          filter: {
            type: "static",
            options: taxReportingCategories.map((v) => ({
              label: <Enumerable value={v} />,
              value: v
            }))
          },
          icon: <LuTags />
        }
      },
      {
        accessorKey: "countryCode",
        header: t`Country`,
        cell: (item) => item.getValue<string | null>(),
        meta: {
          icon: <LuGlobe />
        }
      },
      {
        accessorKey: "state",
        header: t`State / Province`,
        cell: (item) => item.getValue<string | null>(),
        meta: {
          icon: <LuMapPin />
        }
      },
      {
        accessorKey: "effectiveRate",
        header: t`Effective Rate`,
        // Blended across the code's components in force today, so a compound
        // code reads as what it actually charges (5% + compound 9.975% is
        // 15.47%, not 14.975%).
        cell: (item) => percentFormatter.format(item.getValue<number>() ?? 0),
        meta: {
          icon: <LuPercent />
        }
      },
      {
        accessorKey: "active",
        header: t`Active`,
        cell: (item) => <Checkbox isChecked={item.getValue<boolean>()} />,
        meta: {
          filter: {
            type: "static",
            options: [
              { label: t`Active`, value: "true" },
              { label: t`Inactive`, value: "false" }
            ]
          },
          icon: <LuToggleLeft />
        }
      }
    ];
    return [...defaultColumns, ...customColumns];
  }, [params, customColumns, percentFormatter, t]);

  const renderContextMenu = useCallback(
    (row: TaxCode) => {
      return (
        <>
          <MenuItem
            disabled={!permissions.can("update", "accounting")}
            onClick={() => {
              navigate(`${path.to.taxCode(row.id)}?${params.toString()}`);
            }}
          >
            <MenuIcon icon={<LuPencil />} />
            <Trans>Edit Tax Code</Trans>
          </MenuItem>
          <MenuItem
            disabled={!permissions.can("delete", "accounting")}
            onClick={() => {
              navigate(`${path.to.deleteTaxCode(row.id)}?${params.toString()}`);
            }}
          >
            <MenuIcon icon={<LuTrash />} />
            <Trans>Delete Tax Code</Trans>
          </MenuItem>
        </>
      );
    },
    [navigate, params, permissions]
  );

  return (
    <Table<TaxCode>
      data={data}
      columns={columns}
      count={count}
      primaryAction={
        permissions.can("create", "accounting") && (
          <New label={t`Tax Code`} to={`new?${params.toString()}`} />
        )
      }
      renderContextMenu={renderContextMenu}
      title={t`Tax Codes`}
    />
  );
});

TaxCodesTable.displayName = "TaxCodesTable";
export default TaxCodesTable;
